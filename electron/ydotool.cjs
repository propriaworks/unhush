// ydotool setup and daemon management.
//
// ydotool comes in two incompatible generations, and one machine could have both:
//
//   0.x  Ubuntu 22.04/Mint 22 still ship 0.1.8. The client writes /dev/uinput itself -- there is no
//        daemon to run -- and `key` takes key *names* ("shift+Insert"). A token it cannot parse
//        is not rejected: it falls back to the token's *first character* and types that, exit
//        status 0.
//   1.x  The client is a thin front end: it forwards keystrokes over a unix socket to the
//        ydotoold daemon, which is what holds /dev/uinput open. `key` takes keycode:state pairs
//        ("42:1"), and `ydotool debug` connects to the socket without injecting anything.
//
// The two must never be mixed. A 0.x ydotoold ignores --socket-path and binds its own default
// path instead, so it looks started while being unreachable; a 0.x client has no `debug` and so
// reports every socket as dead, including a perfectly good 1.x daemon. We therefore resolve
// the client ourselves, from PATH *and* the usual install directories, detect its generation
// by running it, and take the ydotoold sitting beside it -- never one from another directory.
//
// Nothing on a stock desktop starts a 1.x daemon for us, and the distro packaging is no help:
//
//   Debian sid / Arch          ydotool 1.x + a *user* unit /usr/lib/systemd/user/ydotool.service
//                              (not enabled by default).
//   Fedora                     ydotool 1.x + a *system* unit. That one is actively useless to us:
//                              a system service has no XDG_RUNTIME_DIR, so root's ydotoold binds
//                              /tmp/.ydotool_socket at 0600 root-owned, while the user's client
//                              looks in /run/user/<uid>/ and finds nothing.
//
// So for a 1.x install we run our own ydotoold as the user, on a socket path private to Unhush,
// for exactly as long as Unhush is running. The udev rule from scripts/postinstall.sh
// (TAG+="uaccess") is what lets a user-level daemon open /dev/uinput without root.
//
// Why a private socket path rather than ydotool's default: ydotoold refuses to start when another
// daemon is already live on the same path, so sharing the default would collide with a
// distro-enabled ydotool.service the moment a user enabled one. Two daemons on *different* paths
// are harmless -- each opens its own virtual keyboard and they never interact. It also keeps us
// out of /tmp/.ydotool_socket, the one location shared between users.

const os = require("os");
const path = require("path");
const fs = require("fs");
const { spawn, spawnSync } = require("child_process");

let log = () => {};
let userDataPath = "";
// userData is injected rather than read from electron's app: it is this module's only reason to
// depend on electron, and without it the socket-path and distro logic is testable as plain node.
function init(logFn, userData) {
  log = logFn;
  userDataPath = userData || "";
  // Only reached when there's no XDG_RUNTIME_DIR, so a missing path here would go unnoticed until
  // the socket landed somewhere relative to the cwd. Say so instead.
  if (!userDataPath) log("warn", "ydotool.init called without a userData path");
}

// The socket we ended up using -- ours, or one we adopted. env() pins clients to it.
let resolvedSocket = null;
let child = null;          // ydotoold we spawned, if any
let respawned = false;     // we replace a crashed daemon once, then give up
let quitting = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------- resolving the install

// Directories to look in, in preference order: everything on PATH, then the usual install
// locations in case PATH is not the session's own (see the header -- at login it frequently
// isn't). Deduplicated by real path, so the /bin -> /usr/bin symlink is not probed twice.
function candidateDirs() {
  const seen = new Set();
  const dirs = [];
  const add = (d) => {
    // Relative PATH entries (including "", which means the working directory) are skipped:
    // running a `ydotool` that happened to be sitting in our working directory is never right.
    if (!d || !path.isAbsolute(d)) return;
    let real = d;
    try { real = fs.realpathSync(d); } catch (e) {} // doesn't exist: keep it, it simply won't match
    if (seen.has(real)) return;
    seen.add(real);
    dirs.push(d);
  };
  for (const d of (process.env.PATH || "").split(path.delimiter)) add(d);
  for (const d of [path.join(os.homedir(), ".local", "bin"), "/usr/local/bin", "/usr/bin", "/bin"]) add(d);
  return dirs;
}

function isExecutableFile(p) {
  try {
    if (!fs.statSync(p).isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch (e) {
    return false;
  }
}

// ydotool major version detection
// 0 or 1, or null when the client didn't run or said something we don't recognise. `ydotool help`
// is safe to run for either generation: it prints a command list and exits, touching neither
// /dev/uinput nor any socket.
function detectGeneration(client) {
  const r = spawnSync(client, ["help"], { encoding: "utf8", timeout: 3000 });
  return generationFromHelp(`${r.stdout || ""}${r.stderr || ""}`);
}

// Split out from the spawn so the parsing can be tested without a ydotool to run. 1.x names the
// socket environment variable in its help footer and lists a `debug` command; 0.x has neither,
// and lists `recorder`, which 1.x dropped.
function generationFromHelp(out) {
  if (/YDOTOOL_SOCKET/.test(out) || /^\s*debug\s*$/m.test(out)) return 1;
  if (/^\s*recorder\s*$/m.test(out)) return 0;
  return null;
}

// Which of the installs we found to use. A complete 1.x install wins wherever it is on the list,
// because that is the combination Unhush manages and tests; a self-contained 0.x comes next,
// since it needs nothing else to work; a 1.x client with no ydotoold beside it comes last, as it
// can only work if some other daemon happens to be running already.
function chooseInstall(installs) {
  const rank = (i) => (i.gen === 0 ? 1 : i.daemon ? 0 : 2);
  let best = null;
  for (const i of installs) if (!best || rank(i) < rank(best)) best = i;
  return best;
}

// Resolved once and then reused: neither PATH nor the installed binaries change under a running
// process. preflight() clears it, so the setup window's Re-check really does look again after
// the user has been told to install something.
let _install;
function forgetInstall() { _install = undefined; }

function install() {
  if (_install !== undefined) return _install;
  const seen = new Set();
  const found = [];
  for (const dir of candidateDirs()) {
    const client = path.join(dir, "ydotool");
    if (!isExecutableFile(client)) continue;
    // Two directories can hold the same binary through a symlink (/usr/local/bin -> /usr/bin);
    // running `help` on it twice would be pointless and would report a phantom second install.
    let real = client;
    try { real = fs.realpathSync(client); } catch (e) {}
    if (seen.has(real)) continue;
    seen.add(real);

    let gen = detectGeneration(client);
    if (gen === null) {
      log("warn", `could not tell which ydotool generation ${client} is; assuming 1.x`);
      gen = 1;
    }
    const daemon = path.join(dir, "ydotoold");
    found.push({ client, gen, daemon: isExecutableFile(daemon) ? daemon : null });
  }

  _install = chooseInstall(found) || null;
  if (!_install) {
    log("error", "no ydotool binary found on PATH or in the usual install directories");
    return _install;
  }
  const others = found.filter((i) => i !== _install);
  log("info",
    `using ydotool ${_install.gen}.x at ${_install.client}` +
    (_install.gen === 0
      ? " (writes /dev/uinput directly; no daemon needed)"
      : ` with ydotoold ${_install.daemon || "(none alongside it)"}`) +
    (others.length ? `; also found ${others.map((i) => `${i.gen}.x at ${i.client}`).join(", ")}` : ""));
  return _install;
}

// The resolved client, or null when ydotool isn't installed at all. Callers outside this module
// must use it rather than the bare name: PATH may well resolve to the other generation.
function clientPath() {
  const i = install();
  return i ? i.client : null;
}

function generation() {
  const i = install();
  return i ? i.gen : null;
}

// Shift+Insert rather than Ctrl+V because we need it to work in graphical apps and terminal alike,
// and Shift+Insert is also robust to keyboard mappings.
//
// Invoked differently depending upon ydotool version, both confirmed: each emits
// KEY_LEFTSHIFT down, KEY_INSERT down, KEY_INSERT up, KEY_LEFTSHIFT up.
function pasteKeyArgsFor(gen, keyDelayMs) {
  const delay = ["--key-delay", String(keyDelayMs)];
  return gen === 0
    ? ["key", ...delay, "shift+Insert"]              // key names; 0.x has no keycode syntax
    : ["key", ...delay, "42:1", "110:1", "110:0", "42:0"]; // KEY_LEFTSHIFT, KEY_INSERT, press/release
}
function pasteKeyArgs(keyDelayMs = 20) { return pasteKeyArgsFor(generation(), keyDelayMs); }

// `--file -` makes `type` read the text from stdin rather than the command line, so the
// transcript never has to touch the disk. Both generations accept the "-" spelling, and
// both disable backslash escaping when typing from a file, so the text is taken literally.
function typeStdinArgs(keyDelayMs = 12) {
  return ["type", "--key-delay", String(keyDelayMs), "--file", "-"];
}

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
    : path.join(userDataPath, "ydotool.sock");
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

// Environment for every ydotool invocation. Without this a 1.x client falls back to its own
// default path and never finds our daemon. A 0.x client has no socket to point at -- it writes
// /dev/uinput itself -- so it is handed the environment unchanged.
function env() {
  if (generation() === 0) return { ...process.env };
  return { ...process.env, YDOTOOL_SOCKET: socketPath() };
}

// Is a *live* daemon listening here? `ydotool debug` is the ideal probe: it resolves the socket
// exactly as a real paste does and connect()s to it, exiting 2 on failure, while injecting nothing
// and creating no uinput device. We can't probe from Node directly -- ydotoold uses SOCK_DGRAM,
// which Node's net module does not support for unix sockets -- and a plain existsSync would be
// fooled by the stale socket file a crashed daemon leaves behind.
function probeSocket(p) {
  const client = clientPath();
  if (!p || !client || generation() !== 1) return false; // 0.x has no `debug` and no socket
  const r = spawnSync(client, ["debug"], {
    env: { ...process.env, YDOTOOL_SOCKET: p },
    stdio: "ignore",
    timeout: 3000,
  });
  return r.status === 0;
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

// Kill a daemon we spawned. Clearing `child` first also neutralises its exit handler, which
// ignores any process that is no longer the current one.
function killChild(reason) {
  if (!child) return;
  const doomed = child;
  child = null;
  try {
    doomed.kill("SIGTERM");
    log("info", `stopped ydotoold (${reason})`);
  } catch (e) {
    log("warn", `failed to stop ydotoold: ${e.message}`);
  }
}

function stopDaemon() {
  quitting = true;
  killChild("app quitting");
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
  // 1. A 0.x client (Ubuntu/Mint) writes /dev/uinput itself: there is nothing to start, nothing
  //    to probe, and starting the 0.x ydotoold that ships beside it would be worse than useless
  //    -- it ignores --socket-path, binds its own default path, and so is unreachable.
  const chosen = install();
  if (!chosen) return { ok: false };
  if (chosen.gen === 0) {
    log("info", `ydotool 0.x (${chosen.client}) writes /dev/uinput directly; no daemon needed`);
    return { ok: true, needed: false };
  }

  // 2. The user pinned a socket themselves — respect it, manage nothing.
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
  if (!chosen.daemon) {
    log("error", `ydotool ${chosen.client} is 1.x but no ydotoold sits beside it, and no daemon `
      + "is reachable; pasting will fail");
    return { ok: false };
  }
  // A previous attempt that never became reachable is still running: kill it before replacing
  // it. Without this, every Re-check in the setup window left another ydotoold behind.
  killChild("previous attempt");
  try { fs.unlinkSync(mine); } catch (e) {} // clear a stale socket file, if any
  log("info", `starting ydotoold (${chosen.daemon}) on ${mine}`);
  quitting = false;
  respawned = false; // this is a fresh attempt, so it gets its own one crash-replacement
  child = spawnDaemon(chosen.daemon, mine);
  if (!(await waitForSocket(mine))) {
    log("error", `ydotoold did not come up on ${mine} within 5s`);
    killChild("did not come up"); // it may yet be listening somewhere we can't reach
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

const isRpmDistroFor = (d) => /fedora|rhel|centos/.test(d);
const isRpmDistro = () => isRpmDistroFor(distro());

// Distro-appropriate install command, for the "ydotool isn't installed" case (mostly AppImage).
// Split from distro() so the mapping can be checked without an /etc/os-release to match.
function installCommandFor(d) {
  if (isRpmDistroFor(d)) return "sudo dnf install ydotool";
  if (/arch/.test(d)) return "sudo pacman -S ydotool";
  if (/suse/.test(d)) return "sudo zypper install ydotool";
  return "sudo apt install ydotool"; // debian/ubuntu, and a reasonable default
}
function installCommand() { return installCommandFor(distro()); }

const UDEV_CMD =
  `echo 'KERNEL=="uinput", TAG+="uaccess", GROUP="input", MODE="0660", OPTIONS+="static_node=uinput"' ` +
  `| sudo tee /etc/udev/rules.d/80-uinput.rules`;
const UDEV_RELOAD = `sudo udevadm control --reload-rules && sudo udevadm trigger --name-match=uinput`;

// Check everything the paste path needs, and describe whatever is broken.
// Returns { ok, problems: [{ code, title, detail, commands, note }] }.
async function preflight() {
  const problems = [];
  forgetInstall(); // the user may have just installed ydotool and pressed Re-check

  if (!install()) {
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
        // Name the daemon that belongs to the client we resolved: on a machine with more than
        // one ydotool installed, the bare name may well be the other generation's.
        commands: [`${(install() && install().daemon) || "ydotoold"} --socket-path=${managedSocketPath()}`],
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

module.exports = {
  init, preflight, ensureDaemon, checkUinput, env, socketPath, stopDaemon,
  clientPath, generation, pasteKeyArgs, typeStdinArgs,
  _internal: {
    defaultSocketPath, managedSocketPath, installCommandFor, isRpmDistroFor,
    generationFromHelp, chooseInstall, pasteKeyArgsFor,
  },
};
