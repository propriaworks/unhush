// Give ydotool's virtual keyboard its own US layout.
//
// ydotool types by emitting US-QWERTY *key positions* from a fixed table (Client/tool_type.c);
// the display server then maps those positions through whatever layout the user actually has.
// On anything that isn't US-compatible the result is wrong but plausible -- on AZERTY, asking
// for 'q' produces 'a' and '1' produces '&'; on a Spanish layout ';' becomes 'ñ' and the
// apostrophe becomes a dead key that swallows the letter after it, so "it's" is typed "itś".
//
// The fix is not to type differently but to tell the display server that *this one device* is a
// US keyboard, leaving the user's real keyboard untouched. ydotool's own README documents this
// for sway and Hyprland; X11 can do the same through setxkbmap's per-device mode, which is what
// makes this worth automating -- the user would otherwise have to find the device id by hand
// after every daemon restart, since the device is recreated each time.
//
// Best-effort throughout: every failure leaves Type mode exactly as it was, which is correct on
// US layouts and wrong on others -- the status quo, never worse. Nothing here can fail a paste.
//
// Only works for ydotool 1.x, where ydotoold holds the uinput device open for its lifetime. A
// 0.x client (Ubuntu 22.04, Mint 22) opens /dev/uinput per invocation, so the device exists only
// while a keystroke is being sent and there is no stable device to configure.

const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);
const session = require("./session.cjs");

// The name ydotoold gives its uinput device (Daemon/ydotoold.c). Compositors that normalise
// device names -- Hyprland lowercases and hyphenates -- see the variant below it.
const DEVICE_NAME = "ydotoold virtual device";
const DEVICE_NAME_HYPRLAND = "ydotoold-virtual-device";

let log = () => {};
function init(logFn) { log = logFn; }

// Whether a us layout is actually in force on the virtual keyboard. Reported rather than
// predicted: Settings needs to know what is true, not what ought to be. It stays false for
// ydotool 0.x (never attempted, no persistent device to pin), on GNOME and KDE under Wayland
// (no per-device input configuration), and wherever the attempt failed -- xinput or setxkbmap
// missing, say. In every one of those cases Type mode is US-QWERTY-only.
let pinned = false;
function isPinned() { return pinned; }

// Runs a command and returns stdout, or null on any failure (missing binary, non-zero exit,
// timeout). Mirrors activeWindow.cjs's helper: shelling out here must never throw into a caller.
async function run(cmd, args, timeoutMs = 2000) {
  try {
    const { stdout } = await execFileAsync(cmd, args, { timeout: timeoutMs });
    return stdout;
  } catch (e) {
    return null;
  }
}

// X11. `xinput list --id-only` accepts a "keyboard:<name>" selector, which picks the
// keyboard-classed device by name -- ydotoold registers two devices with the same name, a
// pointer and a keyboard, and only the keyboard takes an XKB map. Matching by class as well as
// name also means a stray match can never land on the user's real keyboard, which would force
// *that* to US and be far worse than the bug being fixed.
async function pinX11() {
  const out = await run("xinput", ["list", "--id-only", `keyboard:${DEVICE_NAME}`]);
  const id = (out || "").trim().split(/\s+/)[0];
  if (!/^\d+$/.test(id)) return false;
  // setxkbmap -device takes a numeric id only, hence the lookup above.
  const ok = await run("setxkbmap", ["-device", id, "-layout", "us"]);
  if (ok === null) return false;
  log("info", `virtual keyboard: pinned device ${id} to the us layout`);
  return true;
}

// sway. Runtime `swaymsg input <identifier> xkb_layout us` applies immediately; the identifier
// (not the name) is what the input command takes, so the device list is consulted for it.
async function pinSway() {
  const out = await run("swaymsg", ["-t", "get_inputs", "--raw"]);
  if (!out) return false;
  let inputs;
  try { inputs = JSON.parse(out); } catch { return false; }
  const dev = (Array.isArray(inputs) ? inputs : []).find(
    (i) => i && i.type === "keyboard" && String(i.name || "").toLowerCase() === DEVICE_NAME);
  if (!dev || !dev.identifier) return false;
  if (await run("swaymsg", ["input", dev.identifier, "xkb_layout", "us"]) === null) return false;
  log("info", `virtual keyboard: pinned sway input ${dev.identifier} to the us layout`);
  return true;
}

// Hyprland. Per-device input config, set at runtime rather than written into the user's config.
// Hyprland normalises device names to lowercase with hyphens, which is the spelling its own
// documentation (and ydotool's README) uses.
async function pinHyprland() {
  const out = await run("hyprctl", ["keyword", `device:${DEVICE_NAME_HYPRLAND}:kb_layout`, "us"]);
  if (out === null) return false;
  log("info", "virtual keyboard: pinned Hyprland device to the us layout");
  return true;
}

/**
 * Point the display server at a US layout for ydotool's virtual keyboard, so its US-QWERTY
 * keycodes produce the characters they name whatever the user's own layout is.
 *
 * Retried, because the uinput device is created when ydotoold starts but the display server adds
 * it a moment later -- the socket being reachable does not mean the device is visible yet.
 */
async function pinUsLayout({ attempts = 6, intervalMs = 500 } = {}) {
  const pin = session.isX11() ? pinX11
    : session.isSway() ? pinSway
    : session.isHyprland() ? pinHyprland
    : null;
  if (!pin) {
    log("info", "virtual keyboard: no per-device layout support here; ydotool Type mode assumes "
      + "a US-QWERTY layout");
    return false;
  }
  for (let i = 0; i < attempts; i++) {
    if (await pin()) { pinned = true; return true; }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, intervalMs));
  }
  log("warn", "virtual keyboard: could not pin a us layout; Type mode will mistype on layouts "
    + "other than US-QWERTY");
  return false;
}

module.exports = { init, pinUsLayout, isPinned, _internal: { DEVICE_NAME, DEVICE_NAME_HYPRLAND } };
