// Command FIFO: a named pipe that lets anything on this machine drive a running Unhush.
//
// Primarily this is how the global hotkey works on Wayland sessions. We run under XWayland there
// (see the re-exec guard in main.cjs), and a Wayland compositor does not honour X11 key grabs from
// an XWayland client while a native window has focus -- so the desktop environment owns the key
// binding and runs `unhush-toggle`, which writes one line here. That is a few milliseconds, versus
// the ~300ms of the older fallback that relaunched the whole app to signal the running instance.
//
// It is enabled on every session type, not just Wayland, because it is useful on its own: it
// separates "a key was pressed" from "who owns the binding", so a user can bind a key the Settings
// dropdown doesn't offer, and scripts can drive dictation.
//
// Security: XDG_RUNTIME_DIR is per-user and mode 0700, so the pipe is only reachable by its owner.
// The /tmp fallback is created 0600 for the same reason. Commands are matched against a fixed
// handler table -- nothing read here is ever executed.

const { spawnSync } = require("child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

let log = () => {};
function init(logFn) { log = logFn; }

let fifoPath = null;
let fd = null;
let stream = null;

// XDG_RUNTIME_DIR is where per-user transient state belongs: mode 0700, on tmpfs, and cleared when
// the session ends -- so anything left there by a crash cannot outlive the login, and nothing
// another user can read.
function resolvePath() {
  const xrd = process.env.XDG_RUNTIME_DIR;
  if (xrd) return path.join(xrd, "unhush.fifo");
  return path.join(os.tmpdir(), `unhush-${process.getuid()}.fifo`);
}

// The path the pipe lives at, for the UI to show in shortcut setup instructions.
function socketPath() {
  return fifoPath || resolvePath();
}

// The command to give a desktop environment's "run a command" shortcut. Package installs get the
// helper script from scripts/postinstall.sh; AppImage users have no postinstall step, so fall back
// to the one-liner the helper wraps.
const HELPER = "/usr/local/bin/unhush-toggle";
function toggleCommand() {
  if (fs.existsSync(HELPER)) return HELPER;
  return `sh -c 'printf "toggle\\n" > "${socketPath()}"'`;
}

function handleLine(line, handlers) {
  const cmd = line.trim();
  if (!cmd) return;
  const fn = handlers[cmd];
  if (!fn) {
    log("warn", `fifo: ignoring unknown command "${cmd.slice(0, 32)}"`);
    return;
  }
  log("info", `fifo: ${cmd}`);
  fn();
}

// handlers: { <command>: () => void }
function start(handlers) {
  fifoPath = resolvePath();
  try {
    // Always recreate: a node left behind by a crash may be a stale fifo with no reader (which
    // would make writers block) or, in the /tmp fallback, not even ours.
    fs.rmSync(fifoPath, { force: true });
    const r = spawnSync("mkfifo", ["-m", "600", fifoPath], { timeout: 3000 });
    if (r.status !== 0) throw new Error(r.error?.message || `mkfifo exited ${r.status}`);

    // O_RDWR rather than O_RDONLY: a read-only fifo reports EOF every time its last writer closes,
    // so the stream would end after the very first command. Holding a writer ourselves keeps it
    // open for the life of the app. O_NONBLOCK so opening doesn't wait for a writer.
    fd = fs.openSync(fifoPath, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);

    // net.Socket, not fs.createReadStream: an fs read stream issues plain read(2) calls on the
    // libuv threadpool, which on a non-blocking fd fails outright with EAGAIN (measured -- the
    // stream errored out at startup and never delivered a command). A socket wraps the fd in
    // libuv's poll-driven pipe handle, which is what handles EAGAIN correctly, and it keeps a
    // threadpool slot from being parked on a read that may not return for hours.
    stream = new net.Socket({ fd, readable: true, writable: false });
    stream.setEncoding("utf8");

    let buf = "";
    stream.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) !== -1) {
        handleLine(buf.slice(0, i), handlers);
        buf = buf.slice(i + 1);
      }
      // A writer that never sends a newline must not grow this without bound.
      if (buf.length > 1024) buf = "";
    });
    stream.on("error", (e) => log("warn", `fifo read error: ${e.message}`));

    log("info", `command fifo listening at ${fifoPath}`);
  } catch (e) {
    // Not fatal: the tray and any native global shortcut still work.
    log("warn", `could not create command fifo at ${fifoPath}: ${e.message}`);
    stop();
  }
}

function stop() {
  try { if (stream) stream.destroy(); } catch (e) {}
  try { if (fd !== null) fs.closeSync(fd); } catch (e) {}
  try { if (fifoPath) fs.rmSync(fifoPath, { force: true }); } catch (e) {}
  stream = null;
  fd = null;
}

module.exports = { init, start, stop, socketPath, toggleCommand };
