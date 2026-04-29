// Wayland global shortcut support.
//
// On Wayland, globalShortcut works via the XDG GlobalShortcuts portal (KDE, GNOME 48+).
// For GNOME < 48 (e.g. Ubuntu 24.04 LTS) the portal isn't available, so we offer to
// configure a GNOME custom keybinding via gsettings instead.
// For other Wayland compositors without portal support we show a one-time setup dialog.
//
// Key design note: we do NOT use globalShortcut.isRegistered() to detect portal availability.
// On KDE and GNOME 48+ the portal interaction is asynchronous — register() returns false while
// the DE permission dialog is pending, even though the portal will work once the user accepts.
// Instead we use static DE/version detection via needsFallback().

const { app, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawnSync } = require("child_process");

let log = () => {};
function init(logFn) { log = logFn; }

const desktop = (process.env.XDG_CURRENT_DESKTOP || '').toLowerCase();
const isGnome = desktop.includes('gnome');
const isKde   = desktop.includes('kde') || desktop.includes('plasma');

let _gnomeMajorVersion;
function getGnomeMajorVersion() {
  if (_gnomeMajorVersion !== undefined) return _gnomeMajorVersion;
  try {
    const r = spawnSync('gnome-shell', ['--version'], { encoding: 'utf8', timeout: 3000 });
    const m = r.stdout.match(/GNOME Shell (\d+)/);
    _gnomeMajorVersion = m ? parseInt(m[1]) : null;
  } catch (e) { _gnomeMajorVersion = null; }
  return _gnomeMajorVersion;
}

// Returns true when the portal is unavailable and a manual desktop environment fallback is needed.
// KDE and GNOME 48+ have working portals; everything else does not.
function needsFallback() {
  if (isKde) return false;
  if (isGnome) {
    const v = getGnomeMajorVersion();
    return v === null || v < 48;
  }
  return true; // wlroots compositors etc.
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

function setupGnomeShortcut(shortcut, execPath) {
  const flagFile = path.join(app.getPath('userData'), '.wayland-gnome-configured');
  const xkbBinding = electronToXkb(shortcut);
  try {
    gsettingsRun('set', GNOME_CUSTOM_SCHEMA, 'name', 'Unhush Toggle');
    gsettingsRun('set', GNOME_CUSTOM_SCHEMA, 'command', execPath);
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

    fs.writeFileSync(flagFile, '');
    log('info', `GNOME shortcut configured: "${xkbBinding}" → ${execPath}`);
  } catch (e) {
    log('error', `Failed to configure GNOME shortcut: ${e.message}`);
    dialog.showMessageBox({
      type: 'error',
      title: 'Shortcut setup failed',
      message: 'Could not configure the GNOME shortcut automatically.',
      detail: `${e.message}\n\nSet it up manually in GNOME Settings → Keyboard → Custom Shortcuts.`,
      buttons: ['OK'],
    });
  }
}

// Called when needsFallback() is true. Offers gsettings automation on GNOME < 48,
// or a one-time manual-setup dialog on other compositors.
function check(shortcut) {
  if (isGnome) {
    const flagFile = path.join(app.getPath('userData'), '.wayland-gnome-configured');
    if (fs.existsSync(flagFile)) {
      // Already configured — silently keep the binding in sync with any shortcut change
      updateGnomeShortcut(shortcut);
      return;
    }

    const promptedFlag = path.join(app.getPath('userData'), '.wayland-shortcut-prompted');
    if (fs.existsSync(promptedFlag)) return;
    fs.writeFileSync(promptedFlag, '');

    const execPath = process.env.APPIMAGE || app.getPath('exe');
    setupGnomeShortcut(shortcut, execPath);
  } else {
    // Non-GNOME Wayland without portal (wlroots compositors, etc.) — show instructions once
    const promptedFlag = path.join(app.getPath('userData'), '.wayland-shortcut-prompted');
    if (fs.existsSync(promptedFlag)) return;
    fs.writeFileSync(promptedFlag, '');

    dialog.showMessageBox({
      type: 'info',
      title: 'Wayland global shortcut',
      message: 'Manual shortcut setup needed',
      detail:
        `To use "${shortcut}" from any app, add a custom keyboard shortcut in your ` +
        `desktop environment's settings with this command:\n\n` +
        `  ${process.env.APPIMAGE || app.getPath('exe')}\n\n`,
      buttons: ['OK'],
    });
  }
}

// Returns how the global shortcut is managed on the current platform:
//   'native'   — globalShortcut works directly (X11, KDE, GNOME 48+)
//   'gsettings' — managed via GNOME custom keybindings (GNOME < 48); Unhush keeps it in sync
//   'manual'   — user must configure their compositor manually (wlroots etc.)
function shortcutMode() {
  if (!needsFallback()) return 'native';
  if (isGnome) return 'gsettings';
  return 'manual';
}

module.exports = { init, needsFallback, shortcutMode, check };
