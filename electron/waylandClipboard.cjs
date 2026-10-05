// The Wayland half of the clipboard, for desktops whose XWayland is provided by xwayland-satellite
// (Niri, chiefly). Only clipboardAccess.cjs uses this, and only when active() says so. Under
// satellite it *replaces* Electron's X clipboard for writes, reads, saves and restores.
//
// WORKAROUND for xwayland-satellite clipboard bugs (as of 0.8.3 / main b5690b5, 2026-10). Unhush
// runs under XWayland (see main.cjs), so Electron's clipboard is the X one, and satellite must
// copy it to the Wayland clipboard that native Wayland apps read. GNOME and KDE bridge the two
// inside the compositor; satellite is instead an ordinary Wayland client standing in for every X
// window, and that breaks in two ways:
//
// 1. X11 -> Wayland is refused while a Wayland app has focus. Satellite sets the Wayland clipboard
//    with wl_data_device.set_selection, which the compositor accepts only from the focused client
//    (Smithay, hence Niri: "denying setting selection by a non-focused client"). When the user
//    dictates into a Wayland app, that app has focus, so the transcript never reaches it and the
//    paste inserts whatever was there before. Nothing retries.
// 2. Any X11 clipboard owner can stop Wayland -> X11. Satellite keeps the X-backed source in its
//    clipboard slot and ignores Wayland copies until the compositor cancels that source -- which a
//    refused source (case 1) never gets, so the slot stays stuck. Wayland copies then never reach
//    X apps (https://github.com/Supreeeme/xwayland-satellite/issues/485, signature A). Even an
//    accepted source blocks Wayland -> X11 while an X client still owns CLIPBOARD (dnlbtz's repro,
//    #485 and PR #431), and Electron stays owner after every write.
//
// So under satellite, Unhush does not touch the X selections at all: wl-copy and wl-paste
// (wl-clipboard) use the data-control protocol, which clipboard tools are given precisely because
// it needs no focus, and Niri offers it. X apps still get the transcript, from satellite: they
// have focus when pasted into, so satellite does too, receives the new Wayland clipboard and takes
// X ownership itself.
//
// WHEN TO REMOVE: once the satellite versions we support (a) set the Wayland clipboard through
// ext-data-control whenever the compositor offers it, not only before any X window has had focus,
// and (b) follow Wayland copies through that device's events, so a stored X source can no longer
// block them. https://github.com/Supreeeme/xwayland-satellite/pull/431 as of 2026-09 does neither:
// it uses data-control only with no keyboard serial and discards the device's selection events.
// We have asked for both there. With both, Electron's X clipboard would work under satellite as
// it does everywhere else, and this module, its use in clipboardAccess.cjs, the setup card in
// main.cjs and the wl-clipboard package dependency could all go.
//
// The tools are deliberately used only where satellite runs: elsewhere the compositor bridges the
// clipboard itself, and on one without data-control (GNOME's Mutter) wl-copy falls back to briefly
// taking focus, which would send the paste to the wrong window.

const { spawn, execFile } = require("child_process");
const { promisify } = require("util");
const fs = require("fs");
const path = require("path");
const { findBinary } = require("./findBinary.cjs");

const execFileAsync = promisify(execFile);

const SATELLITE = "xwayland-satellite";
const TEXT_TYPE = "text/plain;charset=utf-8";
// Set by password managers so that clipboard history skips the entry. Released wl-copy (2.2.1)
// cannot set it, so such an entry is not restored: re-offered without the hint, a clipboard
// manager would record the password. Password managers clear the clipboard themselves anyway.
const SENSITIVE_HINT = "x-kde-passwordManagerHint";
// Reads are answered by the clipboard's owner, which may be slow (an X app, through satellite);
// save() is awaited before the paste, so this bounds how long a slow owner can delay it.
const READ_TIMEOUT_MS = 1000;
const WRITE_TIMEOUT_MS = 2000;
const MAX_READ_BYTES = 64 * 1024 * 1024; // room for a copied image

let log = () => {};
let satellite; // undefined until first checked, then whether satellite provides our X server
let tools = null; // { copy, paste } binary paths, once found
let missingLogged = false;

function init(logFn) {
  log = logFn;
}

// /proc/<pid>/cmdline is argv, NUL-separated.
function isSatelliteCmdline(cmdline) {
  return path.basename(cmdline.split("\0")[0]) === SATELLITE;
}

// Matched on argv[0] rather than with pgrep: the kernel truncates process names to 15 characters,
// one short of "xwayland-satellite". Only our own user's processes count.
function satelliteRunning() {
  const uid = process.getuid();
  for (const pid of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      if (fs.statSync(`/proc/${pid}`).uid !== uid) continue;
      if (isSatelliteCmdline(fs.readFileSync(`/proc/${pid}/cmdline`, "latin1"))) return true;
    } catch (e) {} // exited while we looked
  }
  return false;
}

// Decided once, on first use. By then Electron has long been connected to its X server, so if
// satellite is what provides it, it is running.
function satellitePresent() {
  if (satellite === undefined) {
    satellite = process.platform === "linux" && !!process.env.WAYLAND_DISPLAY && satelliteRunning();
  }
  return satellite;
}

// Unlike satellite, wl-clipboard is looked for again on every call until found, so installing it
// takes effect without a restart (and the setup window's Re-check sees it).
function active() {
  if (!satellitePresent()) return false;
  if (!tools) {
    const copy = findBinary("wl-copy");
    const paste = findBinary("wl-paste");
    if (copy && paste) {
      tools = { copy, paste };
      log("info", "clipboard: xwayland-satellite detected — also setting the Wayland clipboard with wl-copy");
    } else if (!missingLogged) {
      missingLogged = true;
      log("error", "clipboard: xwayland-satellite detected but wl-clipboard (wl-copy, wl-paste) is not "
        + "installed — Wayland apps will paste their previous clipboard. Install wl-clipboard.");
    }
  }
  return !!tools;
}

// Setup-window card for main.cjs's preflight, or null. It applies in every output mode, since
// Clipboard mode and the tray's "Copy last" write the clipboard the same way a paste does.
// installCommand comes from the caller, which knows the distro (see ydotool.cjs).
function setupProblem(installCommand) {
  if (!satellitePresent() || active()) return null;
  return {
    code: "no-wl-clipboard",
    title: "wl-clipboard is not installed",
    detail: "On this desktop (Niri, or another that uses xwayland-satellite), Unhush needs "
      + "wl-clipboard to put transcripts on the clipboard that Wayland apps read. Without it, "
      + "pasting into a Wayland app inserts whatever you copied before. Install it, then re-check.",
    commands: [installCommand],
  };
}

// wl-copy spools stdin to a temp file under TMPDIR (unlinked as soon as it is open again). Point
// that at XDG_RUNTIME_DIR, which is per-user and in memory, so the transcript never reaches a disk.
function copyEnv() {
  const runtime = process.env.XDG_RUNTIME_DIR;
  return runtime ? { ...process.env, TMPDIR: runtime } : process.env;
}

// wl-copy exits once the compositor has accepted the new selection, leaving a forked child to
// serve it until something else is copied. That child keeps stderr (it swaps only stdin and stdout
// for /dev/null), so waiting for the pipes to close, as execFile does, would wait until the next
// copy. Success is therefore taken from the exit event. On failure nothing forked, the pipe closes
// promptly, and the message is complete by the close event.
function wlCopy(args, data) {
  return new Promise((resolve, reject) => {
    const child = spawn(tools.copy, args, { stdio: ["pipe", "ignore", "pipe"], env: copyEnv() });
    let stderr = "";
    const timer = setTimeout(() => child.kill(), WRITE_TIMEOUT_MS);
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        child.stderr.destroy();
        resolve();
      }
    });
    child.on("close", (code, signal) => {
      if (code !== 0) {
        reject(new Error(`wl-copy ${args.join(" ")} failed (${signal || `exit ${code}`}): ${stderr.trim()}`));
      }
    });
    child.stdin.on("error", () => {}); // EPIPE if wl-copy died before reading; reported above
    child.stdin.end(data);
  });
}

const selectionArgs = (primary) => (primary ? ["--primary"] : []);

// Never throws, so that a failure cannot stop the paste. Returns whether the regular clipboard was
// set; if not, clipboardAccess.cjs falls back to the X selections. A compositor without
// primary-selection support fails only the --primary half, which is merely logged.
async function writeTextBoth(text) {
  const [clipboard, primary] = await Promise.allSettled([false, true].map((primary) =>
    wlCopy([...selectionArgs(primary), "--type", TEXT_TYPE], text)));
  for (const r of [clipboard, primary]) {
    if (r.status === "rejected") log("warn", `clipboard: ${r.reason.message}`);
  }
  return clipboard.status === "fulfilled";
}

// The clipboard as a Wayland app would paste it; null if it is empty or no longer text.
async function readText() {
  try {
    const { stdout } = await execFileAsync(tools.paste, ["--no-newline", "--type", "text"],
      { timeout: READ_TIMEOUT_MS, maxBuffer: MAX_READ_BYTES });
    return stdout;
  } catch (e) {
    return null;
  }
}

// One type per selection, since wl-copy offers a single type (plus generic aliases for text). A
// rich copy, such as HTML with a plain-text twin, therefore comes back as plain text. Text is
// preferred as the part that is nearly always present and matters most; an image-only copy keeps
// its image; anything else is not restored.
const TEXT_PREFERENCE = [TEXT_TYPE, "text/plain", "UTF8_STRING"];
function chooseType(types) {
  return TEXT_PREFERENCE.find((t) => types.includes(t))
    || types.find((t) => t.startsWith("image/"))
    || null;
}

async function saveOne(primary) {
  const opts = { timeout: READ_TIMEOUT_MS, maxBuffer: MAX_READ_BYTES };
  try {
    const { stdout } = await execFileAsync(tools.paste, [...selectionArgs(primary), "--list-types"], opts);
    const types = stdout.split("\n").filter(Boolean);
    const type = types.includes(SENSITIVE_HINT) ? null : chooseType(types);
    if (!type) return null;
    const { stdout: data } = await execFileAsync(tools.paste,
      [...selectionArgs(primary), "--no-newline", "--type", type], { ...opts, encoding: "buffer" });
    return { type, data };
  } catch (e) {
    return null; // nothing copied, or the owner didn't answer in time
  }
}

async function save() {
  const [clipboard, primary] = await Promise.all([saveOne(false), saveOne(true)]);
  return { clipboard, primary };
}

async function restore(saved) {
  await Promise.all([[saved.clipboard, false], [saved.primary, true]]
    .filter(([s]) => s)
    .map(([s, primary]) => wlCopy([...selectionArgs(primary), "--type", s.type], s.data)));
}

module.exports = {
  init, active, setupProblem, writeTextBoth, readText, save, restore,
  _internal: { isSatelliteCmdline, chooseType, wlCopy, setTools: (t) => { tools = t; } },
};
