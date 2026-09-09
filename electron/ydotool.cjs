// ydotool setup and daemon management.
//
// ydotool >= 1.0 is a thin client: it forwards keystrokes over a unix socket to the ydotoold
// daemon, which is what actually holds /dev/uinput open. Nothing on a stock desktop starts that
// daemon for us, and the distro packaging is no help:
//
//   Ubuntu (through questing)  ydotool 0.1.8 -- no daemon at all, the client writes /dev/uinput
//                              directly. Nothing to manage.
//   Debian sid / Arch          ydotool 1.x + a *user* unit /usr/lib/systemd/user/ydotool.service
//                              (not enabled by default).
//   Fedora                     ydotool 1.x + a *system* unit. That one is actively useless to us:
//                              a system service has no XDG_RUNTIME_DIR, so root's ydotoold binds
//                              /tmp/.ydotool_socket at 0600 root-owned, while the user's client
//                              looks in /run/user/<uid>/ and finds nothing.
//
// So we run our own ydotoold as the user, on a socket path private to Unhush, for exactly as long
// as Unhush is running. The udev rule from scripts/postinstall.sh (TAG+="uaccess") is what lets a
// user-level daemon open /dev/uinput without root.
//
// Why a private socket path rather than ydotool's default: ydotoold refuses to start when another
// daemon is already live on the same path, so sharing the default would collide with a
// distro-enabled ydotool.service the moment a user enabled one. Two daemons on *different* paths
// are harmless -- each opens its own virtual keyboard and they never interact. It also keeps us
// out of /tmp/.ydotool_socket, the one location shared between users.

const { app } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn, spawnSync } = require("child_process");

let log = () => {};
function init(logFn) { log = logFn; }

// The socket we ended up using -- ours, or one we adopted. env() pins clients to it.
let resolvedSocket = null;
let child = null;          // ydotoold we spawned, if any
let respawned = false;     // we replace a crashed daemon once, then give up
let quitting = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------- paths & probing

// ydotool's own default, as computed by both client and daemon (Client/ydotool.c,
// Daemon/ydotoold.c): $XDG_RUNTIME_DIR/.ydotool_socket, else /tmp/.ydotool_socket.
function defaultSocketPath() {
  const xrd = process.env.XDG_RUNTIME_DIR;
  return xrd ? path.join(xrd, ".ydotool_socket") : "/tmp/.ydotool_socket";
}

// The socket we manage. Kept distinct from the default -- see the header comment.
function managedSocketPath() {
  const xrd = process.env.XDG_RUNTIME_DIR;
  const preferred = xrd
    ? path.join(xrd, "unhush-ydotool.sock")
    : path.join(app.getPath("userData"), "ydotool.sock");
  // AF_UNIX sun_path holds 108 bytes and both ydotool and ydotoold *silently* truncate to it, so
  // two different long paths can collide after truncation and the daemon then refuses to start.
  // The normal path (/run/user/<uid>/unhush-ydotool.sock) is nowhere near this; the fallback is
  // for pathological homes only.
  if (Buffer.byteLength(preferred) >= 100) return `/tmp/unhush-ydotool-${process.getuid()}.sock`;
  return preferred;
}

function socketPath() {
  return resolvedSocket || managedSocketPath();
}

// Environment for every ydotool invocation. Without this the client falls back to its own
// default path and never finds our daemon.
function env() {
  return { ...process.env, YDOTOOL_SOCKET: socketPath() };
}

// Is a *live* daemon listening here? `ydotool debug` is the ideal probe: it resolves the socket
// exactly as a real paste does and connect()s to it, exiting 2 on failure, while injecting nothing
// and creating no uinput device. We can't probe from Node directly -- ydotoold uses SOCK_DGRAM,
// which Node's net module does not support for unix sockets -- and a plain existsSync would be
// fooled by the stale socket file a crashed daemon leaves behind.
function probeSocket(p) {
  if (!p) return false;
  const r = spawnSync("ydotool", ["debug"], {
    env: { ...process.env, YDOTOOL_SOCKET: p },
    stdio: "ignore",
    timeout: 3000,
  });
  return r.status === 0;
}

function which(bin) {
  const r = spawnSync("which", [bin], { encoding: "utf8", timeout: 3000 });
  const out = (r.stdout || "").trim();
  return r.status === 0 && out ? out : null;
}

// ---------------------------------------------------------------------------- daemon lifecycle

function spawnDaemon(ydotooldPath, sockPath) {
  // Not detached: the daemon is ours alone and must not outlive Unhush. Leaving a ydotoold
  // running would keep an open /dev/uinput virtual keyboard -- an extra input device and
  // standing keystroke-injection surface -- for no benefit, since nothing else uses our socket.
  const proc = spawn(ydotooldPath, [`--socket-path=${sockPath}`], { stdio: "ignore" });
  proc.on("exit", (code, signal) => {
    if (quitting || proc !== child) return;
    log("warn", `ydotoold exited unexpectedly (code=${code}, signal=${signal})`);
    child = null;
    if (respawned) {
      log("error", "ydotoold died twice — not restarting again; pasting will fail");
      return;
    }
    respawned = true;
    log("info", "restarting ydotoold");
    child = spawnDaemon(ydotooldPath, sockPath);
  });
  proc.on("error", (err) => log("error", `failed to spawn ydotoold: ${err.message}`));
  return proc;
}

function stopDaemon() {
  quitting = true;
  if (!child) return;
  try {
    child.kill("SIGTERM");
    log("info", "stopped ydotoold");
  } catch (e) {
    log("warn", `failed to stop ydotoold: ${e.message}`);
  }
  child = null;
}

// Wait for the socket to accept connections. A freshly spawned ydotoold has to create its uinput
// device first; upstream's own systemd unit allows for this with an ExecStartPre sleep.
async function waitForSocket(p, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (probeSocket(p)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(250);
  }
}

// Ensure a reachable ydotoold, adopting an existing one where possible. First match wins.
async function ensureDaemon() {
  // 1. The user pinned a socket themselves — respect it, manage nothing.
  if (process.env.YDOTOOL_SOCKET) {
    const p = process.env.YDOTOOL_SOCKET;
    resolvedSocket = p;
    if (probeSocket(p)) {
      log("info", `using ydotoold at YDOTOOL_SOCKET=${p}`);
      return { ok: true, adopted: true };
    }
    log("warn", `YDOTOOL_SOCKET=${p} is set but no daemon is listening there`);
    return { ok: false };
  }

  // 2. ydotool 0.1.8 (Ubuntu) has no daemon and needs none.
  const ydotoold = which("ydotoold");
  if (!ydotoold) {
    log("info", "no ydotoold binary — assuming ydotool 0.x, which writes /dev/uinput directly");
    return { ok: true, needed: false };
  }

  // 3. Our own socket is already live: an orphan from a hard kill, or another Unhush instance.
  const mine = managedSocketPath();
  if (probeSocket(mine)) {
    resolvedSocket = mine;
    log("info", `adopted existing Unhush ydotoold at ${mine}`);
    return { ok: true, adopted: true };
  }

  // 4. A daemon on ydotool's default path (Debian/Arch user unit, or hand-started) works fine —
  //    adopt it rather than spawning a redundant second one.
  const dflt = defaultSocketPath();
  if (probeSocket(dflt)) {
    resolvedSocket = dflt;
    log("info", `adopted existing ydotoold at ${dflt}`);
    return { ok: true, adopted: true };
  }

  // 5. Start our own.
  try { fs.unlinkSync(mine); } catch (e) {} // clear a stale socket file, if any
  log("info", `starting ydotoold (${ydotoold}) on ${mine}`);
  quitting = false;
  child = spawnDaemon(ydotoold, mine);
  if (!(await waitForSocket(mine))) {
    log("error", `ydotoold did not come up on ${mine} within 5s`);
    return { ok: false };
  }
  resolvedSocket = mine;
  log("info", "ydotoold is up");
  return { ok: true, started: true };
}

// ---------------------------------------------------------------------------- uinput access

// Retry rather than test once: package postinstall triggers the udev rule asynchronously, so an
// installer that offers a "Launch" button can start us before logind has applied the uaccess ACL.
async function checkUinput(timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  for (;;) {
    try {
      fs.accessSync("/dev/uinput", fs.constants.W_OK);
      return { ok: true };
    } catch (e) {
      lastErr = e;
    }
    if (Date.now() >= deadline) break;
    await sleep(250);
  }
  log("error", `/dev/uinput not writable after ${timeoutMs}ms: ${lastErr && lastErr.code}`);
  return { ok: false, code: lastErr && lastErr.code };
}

// ---------------------------------------------------------------------------- preflight

// This distro's ID plus ID_LIKE, lowercased into one string, e.g. "linuxmint ubuntu debian".
// Cached: /etc/os-release can't change under a running process.
let _distro;
function distro() {
  if (_distro !== undefined) return _distro;
  let id = "", idLike = "";
  try {
    const osRelease = fs.readFileSync("/etc/os-release", "utf8");
    id = (osRelease.match(/^ID=(.*)$/m) || [])[1] || "";
    idLike = (osRelease.match(/^ID_LIKE=(.*)$/m) || [])[1] || "";
  } catch (e) {}
  _distro = `${id} ${idLike}`.replace(/"/g, "").toLowerCase();
  return _distro;
}

const isRpmDistro = () => /fedora|rhel|centos/.test(distro());

// Distro-appropriate install command, for the "ydotool isn't installed" case (mostly AppImage).
function installCommand() {
  if (isRpmDistro()) return "sudo dnf install ydotool";
  if (/arch/.test(distro())) return "sudo pacman -S ydotool";
  if (/suse/.test(distro())) return "sudo zypper install ydotool";
  return "sudo apt install ydotool"; // debian/ubuntu, and a reasonable default
}

const UDEV_CMD =
  `echo 'KERNEL=="uinput", TAG+="uaccess", GROUP="input", MODE="0660", OPTIONS+="static_node=uinput"' ` +
  `| sudo tee /etc/udev/rules.d/80-uinput.rules`;
const UDEV_RELOAD = `sudo udevadm control --reload-rules && sudo udevadm trigger --name-match=uinput`;

// Check everything the paste path needs, and describe whatever is broken.
// Returns { ok, problems: [{ code, title, detail, commands, note }] }.
async function preflight() {
  const problems = [];

  if (!which("ydotool")) {
    log("error", "ydotool binary not found on PATH");
    problems.push({
      code: "no-ydotool",
      title: "ydotool is not installed",
      detail: "Unhush uses ydotool to paste into other applications. Install it, then re-check.",
      commands: [installCommand()],
    });
    return { ok: false, problems }; // without the client there is nothing else worth testing
  }

  const uinput = await checkUinput();
  if (!uinput.ok) {
    const missing = uinput.code === "ENOENT";
    problems.push({
      code: "uinput",
      title: missing ? "/dev/uinput does not exist" : "/dev/uinput is not writable",
      detail: missing
        ? "The uinput kernel module doesn't appear to be loaded. Load it, then grant access:"
        : "ydotool needs write access to /dev/uinput. Grant it with:",
      commands: missing
        ? ["sudo modprobe uinput",
           "echo uinput | sudo tee /etc/modules-load.d/uinput.conf",
           UDEV_CMD, UDEV_RELOAD]
        : [UDEV_CMD, UDEV_RELOAD],
      note: "If it still fails afterwards, log out and back in — a running process can't pick up "
          + "new group membership.",
    });
  } else {
    // The daemon can only start once /dev/uinput is usable, so only try when it is.
    const daemon = await ensureDaemon();
    if (!daemon.ok) {
      problems.push({
        code: "daemon",
        title: "The ydotoold daemon isn't running",
        detail: "ydotool forwards keystrokes to a ydotoold daemon. Unhush normally starts one "
              + "itself, but that failed. You can start one manually:",
        commands: [`ydotoold --socket-path=${managedSocketPath()}`],
        note: "Don't use sudo — a root daemon puts its socket where your session can't reach it."
            // Only worth saying where such a service actually exists to be tempted by.
            + (isRpmDistro()
                ? " The ydotool.service that ships with this distribution is a root system "
                  + "service with exactly that problem, so enabling it won't help."
                : ""),
      });
    }
  }

  return { ok: problems.length === 0, problems };
}

module.exports = { init, preflight, ensureDaemon, checkUinput, env, socketPath, stopDaemon };
