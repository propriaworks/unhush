// Global shortcut handling on Wayland sessions.
//
// We run under XWayland on Wayland (see the re-exec guard at the top of main.cjs), and a Wayland
// compositor does not honour X11 key grabs from an XWayland client while a native window has focus.
// So on Wayland the desktop environment owns the key binding, and it runs `unhush-toggle`, which
// writes one line into our command fifo (electron/commandFifo.cjs).
//
// That collapses what used to be a guessing game -- is the GlobalShortcuts portal available on this
// compositor and version? -- into a single answer. The portal branches below are now reached only
// by someone who forces --ozone-platform themselves, which is unsupported (native Wayland can't
// keep the clipboard reliable on GNOME -- see the re-exec guard in main.cjs), but is still handled
// correctly rather than left to misbehave.
//
// Key design note: we do NOT use globalShortcut.isRegistered() to detect portal availability. On
// KDE and GNOME 48+ the portal interaction is asynchronous — register() returns false while the DE
// permission dialog is pending, even though the portal will work once the user accepts.
//
// Nothing here shows a dialog: first-run guidance belongs to the setup window
// (electron/setup-dialog.html), and ongoing configuration to Settings.

const path = require("path");
const fs = require("fs");
const { spawnSync } = require("child_process");
const commandFifo = require("./commandFifo.cjs");
const { which } = require("./which.cjs");

let log = () => {};
let userDataPath = "";
// userData is injected rather than pulled from electron's app, the same way audioDucking takes the
// app name: it's the module's only reason to touch electron, and without that dependency this file
// is directly testable outside an electron process.
function init(logFn, userData) {
  log = logFn;
  userDataPath = userData || "";
  // Without it, gnomeFlagFile() resolves relative to the cwd and the GNOME opt-in silently stops
  // being remembered — a caller that forgets the argument should hear about it, not limp on.
  if (!userDataPath) log("warn", "waylandShortcut.init called without a userData path");
}

// Desktop identity is still needed for two things: GNOME is the one desktop whose keybindings we
// can set programmatically, and both names steer the "where do I click" hint. Everything else that
// used to branch per compositor and per GNOME version is gone -- see needsFallback().
const desktop = (process.env.XDG_CURRENT_DESKTOP || '').toLowerCase();
const isGnome = desktop.includes('gnome');
const isKde   = desktop.includes('kde') || desktop.includes('plasma');

const isWaylandSession = process.env.XDG_SESSION_TYPE === 'wayland';
// True when we re-execed ourselves onto XWayland (see the guard at the top of main.cjs).
const forcedX11 = process.argv.some(a => a.startsWith('--ozone-platform=x11'));

// Which display backend we actually ended up on, for the startup log line -- the thing we
// previously had to infer from symptoms (a centred, un-raisable recording bar meant Wayland-native).
function displayBackend() {
  const arg = process.argv.find(a => a.startsWith('--ozone-platform='));
  if (arg) return `${arg.split('=')[1] || '?'} (forced)`;
  return isWaylandSession ? 'wayland (native)' : 'x11';
}

// Returns true when a desktop-environment shortcut is needed because globalShortcut can't bind the
// key itself. One condition, where there used to be a per-compositor, per-GNOME-version portal
// capability matrix (including a `gnome-shell --version` probe): running under XWayland means
// Chromium builds an X11 listener rather than a portal one, and a Wayland compositor won't deliver
// X11 grabs to an XWayland client. The sole exception is a user who forces --ozone-platform
// themselves, where Electron is a real Wayland client and the portal is live again.
function needsFallback() {
  return isWaylandSession && forcedX11;
}

// The command to paste into a desktop environment's "run a command" shortcut.
function toggleCommand() {
  return commandFifo.toggleCommand();
}

// How to open the desktop's own keyboard-shortcut settings, so the setup window can take the user
// straight there instead of describing a menu path and hoping. Ordered candidates per desktop,
// because the binary names moved between major versions (Plasma 5 -> 6 especially); the first one
// actually installed wins, and an unknown desktop simply gets no button rather than a dead one.
const SHORTCUT_SETTINGS_CANDIDATES = [
  { when: () => isKde, commands: [
    "systemsettings kcm_keys",     // Plasma 6
    "kcmshell6 kcm_keys",
    "systemsettings5 kcm_keys",    // Plasma 5
    "kcmshell5 kcm_keys",
  ]},
  { when: () => isGnome, commands: ["gnome-control-center keyboard"] },
  { when: () => desktop.includes('xfce'), commands: ["xfce4-keyboard-settings"] },
  { when: () => desktop.includes('cinnamon'), commands: ["cinnamon-settings keyboard"] },
  { when: () => desktop.includes('mate'), commands: ["mate-keyboard-properties"] },
  { when: () => desktop.includes('lxqt'), commands: ["lxqt-config-globalkeyshortcuts"] },
  { when: () => desktop.includes('budgie'), commands: ["budgie-control-center keyboard"] },
];

let _settingsCommand; // cached: PATH doesn't change under a running process
function shortcutSettingsCommand() {
  if (_settingsCommand !== undefined) return _settingsCommand;
  _settingsCommand = null;
  for (const entry of SHORTCUT_SETTINGS_CANDIDATES) {
    if (!entry.when()) continue;
    for (const cmd of entry.commands) {
      if (which(cmd.split(' ')[0])) { _settingsCommand = cmd; break; }
    }
    break;
  }
  if (_settingsCommand) log('info', `shortcut settings command: ${_settingsCommand}`);
  return _settingsCommand;
}

// Convert Electron accelerator ("Shift+Space") to XKB format ("<Shift>space") for gsettings
function electronToXkb(shortcut) {
  const parts = shortcut.split('+');
  const key = parts.pop().toLowerCase();
  const mods = parts.map(m => {
    switch (m.toLowerCase()) {
      case 'shift':   return '<Shift>';
      case 'ctrl':
      case 'control': return '<Control>';
      case 'alt':     return '<Alt>';
      case 'super':
      case 'meta':    return '<Super>';
      default:        return `<${m}>`;
    }
  });
  return mods.join('') + key;
}

const GNOME_BINDING_PATH = '/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/unhush/';
const GNOME_CUSTOM_SCHEMA = `org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:${GNOME_BINDING_PATH}`;
const GNOME_MEDIA_SCHEMA = 'org.gnome.settings-daemon.plugins.media-keys';

function gnomeFlagFile() {
  return path.join(userDataPath, '.wayland-gnome-configured');
}

function gsettingsRun(...args) {
  const r = spawnSync('gsettings', args, { encoding: 'utf8', timeout: 3000 });
  if (r.status !== 0) throw new Error(r.stderr?.trim() || `gsettings ${args[0]} failed`);
  return r.stdout.trim();
}

function updateGnomeShortcut(shortcut) {
  try {
    gsettingsRun('set', GNOME_CUSTOM_SCHEMA, 'binding', electronToXkb(shortcut));
    log('info', `GNOME shortcut updated to ${electronToXkb(shortcut)}`);
  } catch (e) {
    log('warn', `Failed to update GNOME shortcut: ${e.message}`);
  }
}

// GNOME is the one desktop whose custom keybindings we can set programmatically. This runs only
// when the user explicitly asks for it in Settings -- never on first run. It edits the user's
// keybindings, and this path can't be exercised from either of our test machines, so it should not
// fire on its own. Returns a result rather than showing a dialog; Settings reports the error.
function setupGnomeShortcut(shortcut) {
  const xkbBinding = electronToXkb(shortcut);
  const command = toggleCommand();
  try {
    gsettingsRun('set', GNOME_CUSTOM_SCHEMA, 'name', 'Unhush Toggle');
    gsettingsRun('set', GNOME_CUSTOM_SCHEMA, 'command', command);
    gsettingsRun('set', GNOME_CUSTOM_SCHEMA, 'binding', xkbBinding);

    // Add our path to the keybindings list if not already present
    const existing = gsettingsRun('get', GNOME_MEDIA_SCHEMA, 'custom-keybindings');
    if (!existing.includes('unhush')) {
      const paths = existing === '@as []' ? [] :
        existing.slice(1, -1).split(',').map(p => p.trim().replace(/'/g, '')).filter(Boolean);
      paths.push(GNOME_BINDING_PATH);
      gsettingsRun('set', GNOME_MEDIA_SCHEMA, 'custom-keybindings',
        `[${paths.map(p => `'${p}'`).join(', ')}]`);
    }

    fs.writeFileSync(gnomeFlagFile(), '');
    log('info', `GNOME shortcut configured: "${xkbBinding}" → ${command}`);
    return { ok: true };
  } catch (e) {
    log('error', `Failed to configure GNOME shortcut: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

// Undo setupGnomeShortcut, so switching away from automatic mode doesn't leave a stray keybinding
// pointing at a command the user no longer wants (or, after an uninstall, doesn't have).
function removeGnomeShortcut() {
  try {
    const existing = gsettingsRun('get', GNOME_MEDIA_SCHEMA, 'custom-keybindings');
    if (existing.includes('unhush')) {
      const paths = existing.slice(1, -1).split(',')
        .map(p => p.trim().replace(/'/g, '')).filter(p => p && !p.includes('unhush'));
      gsettingsRun('set', GNOME_MEDIA_SCHEMA, 'custom-keybindings',
        paths.length ? `[${paths.map(p => `'${p}'`).join(', ')}]` : '@as []');
    }
    fs.rmSync(gnomeFlagFile(), { force: true });
    log('info', 'GNOME shortcut removed');
    return { ok: true };
  } catch (e) {
    log('warn', `Failed to remove GNOME shortcut: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

// Called on every shortcut change. Only keeps an already-opted-in GNOME binding in sync; users who
// haven't opted in are told what to do by the setup window and Settings instead.
function check(shortcut) {
  if (isGnome && fs.existsSync(gnomeFlagFile())) updateGnomeShortcut(shortcut);
}

// How the global shortcut is managed on the current platform:
//   'native'    — globalShortcut works directly (X11 sessions; native-Wayland KDE/GNOME 48+)
//   'gsettings' — a GNOME custom keybinding we manage, after the user opted in
//   'manual'    — the user binds the key in their desktop environment, running toggleCommand()
function shortcutMode() {
  if (!needsFallback()) return 'native';
  if (isGnome && fs.existsSync(gnomeFlagFile())) return 'gsettings';
  return 'manual';
}

// A card for the first-run setup window, in the same shape as ydotool.cjs's preflight problems
// ({code, title, detail, commands, note}). null when globalShortcut binds the key itself.
function shortcutProblem() {
  // Nothing to prompt about when globalShortcut binds the key itself. Note the consequence on the
  // unsupported native-Wayland path: we assume the portal binds it, so if the portal silently
  // doesn't, no card appears -- Settings still shows the command either way.
  if (!needsFallback()) return null;
  const where = isKde
    ? 'System Settings → Keyboard → Shortcuts → Add New → Command.'
    : isGnome
      ? 'Settings → Keyboard → View and Customize Shortcuts → Custom Shortcuts → +.'
      : 'Look for "custom shortcuts" or "key bindings" in your desktop settings.';
  return {
    code: 'shortcut',
    title: 'Set the dictation shortcut in your desktop settings',
    detail:
      'On Wayland only the desktop environment can bind a key that works in every application. ' +
      'Add a custom shortcut that runs this command, using whichever key you prefer:',
    commands: [toggleCommand()],
    settingsCommand: shortcutSettingsCommand(), // may be null; the dialog hides its button then
    note: `${where}  Until then, click the tray icon to start and stop dictation.`,
  };
}

// Everything Settings needs to render the shortcut section in one round trip.
function shortcutInfo() {
  return {
    mode: shortcutMode(),
    command: toggleCommand(),
    canAutomate: isGnome && needsFallback(),
    settingsCommand: shortcutSettingsCommand(),
  };
}

module.exports = {
  init, needsFallback, shortcutMode, shortcutInfo, shortcutProblem, check, displayBackend,
  shortcutSettingsCommand,
  setupGnomeShortcut, removeGnomeShortcut, toggleCommand,
  _internal: { electronToXkb },
};
