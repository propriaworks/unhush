// Paste-destination detection: identifies the app/window that receives a paste, purely for
// display in the tray menu (never written to the persistent log file — window titles can
// contain sensitive content like email subjects or chat messages).
//
// Detection is compositor/display-server specific, since there's no single cross-platform API:
//   - X11: xprop (both KDE and other DEs running an X11 session go through this path)
//   - Sway / Hyprland: their own IPC (swaymsg / hyprctl), bundled with those compositors
//   - GNOME (Wayland): GNOME has no supported external query — its own Mutter maintainer
//     rejected wlr-foreign-toplevel-management for breaking client isolation (Mutter ships
//     ext-foreign-toplevel-list-v1 instead, which omits focus state by design), and the private
//     Eval/Introspect D-Bus escape hatches are being actively locked down. We instead use the
//     community "Focused Window D-Bus" GNOME Shell extension if the user has it installed
//     (https://extensions.gnome.org/extension/5592/focused-window-d-bus/) — already the
//     ActivityWatch-recommended solution for this exact problem. If it's not installed, we
//     silently fall back to "unknown."
//   - KDE Plasma (Wayland): not implemented — falls back to "unknown" (tractable now though; see
//     getViaKwin() below). KDE X11 sessions are already covered by the xprop path above.
//
// IMPORTANT: unlike waylandShortcut.cjs (whose shell-outs run once at startup/settings-change
// time and use spawnSync), this module runs on every single paste, so all shell-outs here use
// non-blocking spawn(). spawnSync would block Node's single event loop thread for its full
// duration, which could stall the paste keystroke itself — that's not an acceptable tradeoff
// for a purely cosmetic tray indicator.

const { spawn } = require("child_process");

let log = () => {};
function init(logFn) { log = logFn; }

const sessionType = (process.env.XDG_SESSION_TYPE || '').toLowerCase();
const desktop = (process.env.XDG_CURRENT_DESKTOP || '').toLowerCase();
const isGnome = desktop.includes('gnome');
const isKde = desktop.includes('kde') || desktop.includes('plasma');
const isSway = !!process.env.SWAYSOCK;
const isHyprland = !!process.env.HYPRLAND_INSTANCE_SIGNATURE;

let _mechanism; // 'xprop' | 'sway' | 'hyprland' | 'kde-wayland' | 'gnome-extension' | 'unknown'
function resolveMechanism() {
  if (_mechanism !== undefined) return _mechanism;
  if (sessionType === 'x11' || (!sessionType && !process.env.WAYLAND_DISPLAY)) _mechanism = 'xprop';
  else if (isSway) _mechanism = 'sway';
  else if (isHyprland) _mechanism = 'hyprland';
  else if (isKde) _mechanism = 'kde-wayland';
  else if (isGnome) _mechanism = 'gnome-extension';
  else _mechanism = 'unknown';
  log('info', `activeWindow: detection mechanism = ${_mechanism}`);
  return _mechanism;
}

const _warned = new Set(); // per-mechanism "missing tool" warning, logged once per process lifetime

// Runs a command asynchronously and returns its stdout, or null on missing binary, non-zero
// exit, or timeout. Never throws.
function run(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(cmd, args);
    } catch (e) {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => { child.kill(); resolve(null); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => {
      clearTimeout(timer);
      if (!_warned.has(cmd)) {
        _warned.add(cmd);
        log('warn', `activeWindow: "${cmd}" not found — paste-destination display disabled for this session`);
      }
      resolve(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? out : null);
    });
  });
}

async function getViaXprop() {
  const root = await run('xprop', ['-root', '_NET_ACTIVE_WINDOW'], 1000);
  if (!root) return null;
  const idMatch = root.match(/window id # (0x[0-9a-fA-F]+)/);
  if (!idMatch) return null; // no active window

  const win = await run('xprop', ['-id', idMatch[1], 'WM_CLASS', '_NET_WM_NAME', 'WM_NAME'], 1000);
  if (!win) return null;

  const classMatch = win.match(/WM_CLASS\(STRING\) = "([^"]*)"/);
  const nameMatch =
    win.match(/_NET_WM_NAME\(UTF8_STRING\) = "((?:[^"\\]|\\.)*)"/) ||
    win.match(/WM_NAME\(\w+\) = "((?:[^"\\]|\\.)*)"/);

  const app = classMatch ? classMatch[1] : 'unknown';
  const title = nameMatch ? nameMatch[1].replace(/\\"/g, '"').replace(/\\n/g, ' ') : '';
  return { app, title };
}

async function getViaSway() {
  const out = await run('swaymsg', ['-t', 'get_tree'], 1500);
  if (!out) return null;
  let tree;
  try { tree = JSON.parse(out); } catch { return null; }

  function findFocused(node) {
    if (node.focused) return node;
    for (const child of [...(node.nodes || []), ...(node.floating_nodes || [])]) {
      const found = findFocused(child);
      if (found) return found;
    }
    return null;
  }

  const focused = findFocused(tree);
  if (!focused) return null;
  const app = focused.app_id || focused.window_properties?.class || 'unknown';
  return { app, title: focused.name || '' };
}

async function getViaHyprland() {
  const out = await run('hyprctl', ['-j', 'activewindow'], 1500);
  if (!out) return null;
  let obj;
  try { obj = JSON.parse(out); } catch { return null; }
  if (!obj || !obj.class) return null; // hyprctl returns {} when nothing is focused
  return { app: obj.class, title: obj.title || '' };
}

async function getViaGnomeExtension() {
  const out = await run('gdbus', [
    'call', '--session', '--dest', 'org.gnome.Shell',
    '--object-path', '/org/gnome/shell/extensions/FocusedWindow',
    '--method', 'org.gnome.shell.extensions.FocusedWindow.Get',
  ], 1000);
  if (!out) return null; // extension not installed/enabled, or gdbus missing

  // gdbus wraps the returned JSON string in a tuple literal, e.g. ('{"title":"...",...}',)
  const jsonMatch = out.match(/\('(.*)',\)/s);
  if (!jsonMatch) return null;
  let info;
  try { info = JSON.parse(jsonMatch[1].replace(/\\"/g, '"')); } catch { return null; }
  return { app: info.wm_class_instance || info.wm_class || 'unknown', title: info.title || '' };
}

// KDE Plasma Wayland: not implemented, but no longer blocked. KWin scripts can't return values, so
// (as kdotool does) the script pushes results with callDBus(<our unique bus name>, "/", "", member,
// ...) — a plain method call back into our own connection, not the custom signal previously assumed
// here. That needs a real D-Bus client, which dbusConnection.cjs now gives us.
//
// Sketch: loadScript(path, name) on org.kde.KWin /Scripting org.kde.kwin.Scripting → id (-1 if that
// name is already loaded), run() on /Scripting/Script{id}, unloadScript(name) after; the script
// reads workspace.activeWindow (.resourceClass/.caption) or hooks workspace.windowActivated.
// Undecided: load/run/unload per paste (only ever learns the window pasted into) vs. a resident
// script (free at paste time, but streams us every window title). Wants its own DBusConnection —
// the portal's is module-private and only conditionally alive — plus two gaps filled: _dispatch()
// drops inbound METHOD_CALL, and call() has no timeout (idiom in portalShortcuts.cjs). Unverified
// without real KDE Plasma Wayland hardware.
async function getViaKwin() {
  return null;
}

async function getActiveWindowInfo() {
  try {
    switch (resolveMechanism()) {
      case 'xprop': return await getViaXprop();
      case 'sway': return await getViaSway();
      case 'hyprland': return await getViaHyprland();
      case 'kde-wayland': return await getViaKwin();
      case 'gnome-extension': return await getViaGnomeExtension();
      default: return null; // unknown
    }
  } catch (e) {
    log('warn', `activeWindow: getActiveWindowInfo failed: ${e.message}`);
    return null;
  }
}

module.exports = { init, getActiveWindowInfo };
