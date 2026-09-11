// Global shortcut handling on Wayland sessions.
//
// There are exactly three paths, and the session type picks between the first two:
//
//   X11      globalShortcut.register() in main.cjs -- Chromium grabs the key itself, the Settings
//            dropdown changes it freely, no consent dialog. Nothing in this file applies.
//   Wayland  the XDG GlobalShortcuts portal, via our own D-Bus client (portalShortcuts.cjs). We
//            bind one stable id and dispatch on the id the portal sends back.
//   Fallback the user binds a key to `unhush-toggle` in their desktop, which writes one line into
//            our command fifo (commandFifo.cjs). Reached when the portal isn't there at all.
//
// Why our own D-Bus client rather than Electron's portal support: Electron/Chromium derives portal
// shortcut ids locally from the accelerator string, so a restored binding is dead on arrival and a
// rebind can abort the process. Ours is also reachable from an XWayland client -- D-Bus is
// transport-agnostic -- which is what lets us keep the XWayland re-exec (see main.cjs) and still
// bind the hotkey automatically.
//
// Portal rules that shape everything below, all derived from testing on KDE Plasma 6 (see
// https://github.com/jtbr/dbus_globalshortcut_client): BindShortcuts on every launch, since a
// restored session is listed but not armed; one stable id for the app's lifetime;
// preferred_trigger honoured on the FIRST bind only, so the app can never change its own key
// afterwards -- only the user can, through ConfigureShortcuts; and there is no unbind.
//
// Nothing here shows a dialog: first-run guidance belongs to the setup window
// (electron/setup-dialog.html), and ongoing configuration to Settings.

const commandFifo = require("./commandFifo.cjs");
const realPortal = require("./portalShortcuts.cjs");

let log = () => {};
// The portal client is injectable for the same reason userData used to be: vitest's vi.mock cannot
// reach a require() inside a .cjs module, and without a stand-in every test of this file would open
// a real D-Bus connection and answer differently on each machine. Production passes nothing.
let portal = realPortal;
function init(logFn, portalImpl) {
  log = logFn;
  portal = portalImpl || realPortal;
  portal.init(logFn);
}

const isWaylandSession = process.env.XDG_SESSION_TYPE === 'wayland';

const SHORTCUT_ID = 'toggle-recording';          // stable for the app's lifetime -- see header
const SHORTCUT_DESCRIPTION = 'Start or stop dictation';

// Which display backend we actually ended up on, for the startup log line -- the thing we
// previously had to infer from symptoms (a centred, un-raisable recording bar meant Wayland-native).
function displayBackend() {
  const arg = process.argv.find(a => a.startsWith('--ozone-platform='));
  if (arg) return `${arg.split('=')[1] || '?'} (forced)`;
  return isWaylandSession ? 'wayland (native)' : 'x11';
}

// True when the hotkey is the portal's business rather than globalShortcut's. Note this does not
// consult --ozone-platform: we reach the portal over D-Bus, so it works the same whether Chromium
// is running as an XWayland or a native Wayland client.
function usesPortal() {
  return isWaylandSession;
}

// The command to paste into a desktop environment's "run a command" shortcut.
function toggleCommand() {
  return commandFifo.toggleCommand();
}

// --- Electron accelerator -> XDG trigger syntax ------------------------------------------------
// Modifiers are upper-case and joined with "+"; the key is an XKB keysym name, which is where the
// surprises live: case matters ("space", but "F12" and "Insert"), and punctuation has spelled-out
// names. Only the keys the Settings dropdown can produce strictly need to be here, but stored
// values from older versions turn up too, so the common punctuation is mapped as well.
const KEYSYMS = {
  ' ': 'space', space: 'space', tab: 'Tab', enter: 'Return', return: 'Return', esc: 'Escape',
  escape: 'Escape', backspace: 'BackSpace', delete: 'Delete', insert: 'Insert', home: 'Home',
  end: 'End', pageup: 'Prior', pagedown: 'Next', up: 'Up', down: 'Down', left: 'Left',
  right: 'Right', plus: 'plus',
  '\\': 'backslash', '/': 'slash', '.': 'period', ',': 'comma', ';': 'semicolon',
  "'": 'apostrophe', '[': 'bracketleft', ']': 'bracketright', '-': 'minus', '=': 'equal',
  '`': 'grave',
};

function electronToXdgTrigger(accelerator) {
  const parts = String(accelerator || '').split('+');
  // A trailing "+" ("Ctrl+Alt++") splits into an empty last part; the plus key is what was meant.
  const rawKey = parts.pop() || '+';
  const mods = parts.map(m => {
    switch (m.toLowerCase()) {
      case 'ctrl': case 'control': case 'cmdorctrl': case 'commandorcontrol': return 'CTRL';
      case 'alt': case 'option': return 'ALT';
      case 'shift': return 'SHIFT';
      case 'super': case 'meta': case 'cmd': case 'command': return 'SUPER';
      default: return m.toUpperCase();
    }
  });
  const lower = rawKey.toLowerCase();
  let key;
  if (KEYSYMS[rawKey]) key = KEYSYMS[rawKey];
  else if (KEYSYMS[lower]) key = KEYSYMS[lower];
  else if (/^f\d{1,2}$/.test(lower)) key = lower.toUpperCase();  // F1-F24 keep their capital F
  else key = lower;                                              // letters and digits
  return [...mods, key].join('+');
}

// --- Portal binding, and getting it back after a drop ------------------------------------------
// The client reports an unexpected disconnect (bus crash, compositor or portal-backend restart,
// suspend/resume) and deliberately does not reconnect itself: GlobalShortcuts has no restore token,
// so a fresh session and a rebind are required anyway. Recovery is therefore ours, and it is just
// start() again on a backoff.
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000, 30000, 30000];

let mode = isWaylandSession ? 'manual' : 'native';
let triggerDescription = null;
let everBound = false;   // a binding has worked at least once this session -- see attemptBind()
let retryIndex = 0;
let retryTimer = null;
let stopped = false;
let options = null;      // {trigger, onActivated, onChanged}, kept for retries

// Resolves once the first bind attempt has settled either way, so the setup window doesn't decide
// whether to nag before we know. Later retries don't touch it.
let markSettled;
const settledPromise = new Promise((resolve) => { markSettled = resolve; });
// On X11 there is no attempt to wait for: resolve at load, or every caller would wait forever.
if (!isWaylandSession) markSettled();
function settled() { return settledPromise; }

async function attemptBind() {
  if (stopped) return;
  const result = await portal.start({
    id: SHORTCUT_ID,
    description: SHORTCUT_DESCRIPTION,
    preferredTrigger: options.trigger,
    onActivated: options.onActivated,
    onDisconnected: handleDisconnect,
    // The user can change the key in the desktop's own editor at any time; this is how we hear
    // about it rather than showing the trigger we were given at startup for the rest of the run.
    onShortcutsChanged: (trigger) => {
      triggerDescription = trigger;
      if (options.onChanged) options.onChanged();
    },
  });

  if (result.ok) {
    if (everBound) log('info', `portal shortcut rebound after ${retryIndex} attempt(s)`);
    mode = 'portal';
    triggerDescription = result.triggerDescription || '';
    everBound = true;
    retryIndex = 0;
  } else if (!everBound) {
    // A cold failure is an answer about this desktop, not about timing: 'unavailable' means no
    // GlobalShortcuts backend here (sway and the rest of the wlroots family), and 'denied' means
    // the user declined the consent dialog -- retrying that would just raise it again. Either way
    // the manual command is the honest fallback.
    mode = 'manual';
    log(result.reason === 'denied' ? 'info' : 'warn',
      `portal shortcut not bound (${result.reason}${result.error ? `: ${result.error}` : ''}) — ` +
      `falling back to a desktop-bound ${toggleCommand()}`);
  } else if (retryIndex < RETRY_DELAYS_MS.length) {
    // The same reasons mean something else once a binding has worked: the bus or the backend is
    // still coming back up. Even 'denied' is retried here -- permission is already on record, so a
    // genuine refusal isn't plausible mid-restart.
    scheduleRetry(`rebind failed (${result.reason})`);
  } else {
    mode = 'manual';
    log('warn', 'portal rebind abandoned after repeated failures — the tray icon and ' +
      `${toggleCommand()} still work; restart Unhush to try again`);
  }
  markSettled();
}

function scheduleRetry(why) {
  const delay = RETRY_DELAYS_MS[retryIndex++];
  log('warn', `portal: ${why}; retrying in ${delay / 1000}s`);
  retryTimer = setTimeout(() => { retryTimer = null; attemptBind(); }, delay);
  // Don't hold the event loop open on this alone.
  if (typeof retryTimer.unref === 'function') retryTimer.unref();
}

function handleDisconnect() {
  if (stopped) return;
  retryIndex = 0;
  // mode deliberately stays 'portal' while retries are pending: the binding is expected back within
  // seconds, and telling the user to go configure a shortcut by hand in the meantime would be wrong.
  scheduleRetry('connection lost');
}

// Bind the hotkey through the portal. Idempotent -- the first caller's accelerator is the one
// offered as preferred_trigger, and the portal honours it on the first bind only anyway, so later
// calls have nothing to do.
async function startPortal(accelerator, onActivated, onChanged) {
  if (!usesPortal()) return;
  if (options) return;
  options = { trigger: electronToXdgTrigger(accelerator), onActivated, onChanged };
  log('info', `portal: binding ${SHORTCUT_ID} with preferred trigger ${options.trigger}`);
  await attemptBind();
}

// Opens the desktop's own shortcut editor, focused on our entry. This is how a user changes the
// key: we can't, after the first bind.
async function configure() {
  const result = await portal.configure();
  if (result && result.ok) return result;
  // "AccessDenied: Invalid session" means the portal process was replaced since we bound -- every
  // session it held died with it. The NameOwnerChanged watch rebinds within a second or so on its
  // own, but the user is waiting on a dialog *now*, so pre-empt it and try once more.
  const stale = /invalid session|accessdenied/i.test(String((result && result.error) || ''));
  if (!stale || mode !== 'portal' || !options) return result;
  log('info', 'portal: session was stale when opening the editor; rebinding first');
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  portal.stop();
  await attemptBind();
  return portal.configure();
}

// Re-read the live trigger from the portal. ShortcutsChanged already keeps us current while we are
// running, so this is belt and braces for the case that matters most -- a UI about to display the
// key -- and it costs one D-Bus round trip.
async function refresh() {
  if (mode !== 'portal') return;
  const result = await portal.list();
  if (!result.ok) return; // keep the last known value; list() has logged why
  const mine = result.shortcuts.find(([id]) => id === SHORTCUT_ID);
  triggerDescription = mine ? (mine[1].trigger_description || '') : '';
}

function stopPortal() {
  stopped = true;
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  portal.stop();
}

// How the global shortcut is managed on the current session:
//   'native' — globalShortcut grabs the key itself (X11)
//   'portal' — bound through the GlobalShortcuts portal; the desktop owns the key
//   'manual' — no portal here (or it refused): the user binds toggleCommand() themselves
function shortcutMode() {
  return mode;
}

// A card for the first-run setup window, in the same shape as ydotool.cjs's preflight problems
// ({code, title, detail, commands, note}). null unless the user really does have to bind it.
function shortcutProblem() {
  if (mode !== 'manual') return null;
  return {
    code: 'shortcut',
    title: 'Set the dictation shortcut in your desktop settings',
    detail:
      "Unhush couldn't register a global shortcut with this desktop, so the key binding has to be " +
      'yours. Add a shortcut that runs this command, using whichever key you prefer:',
    commands: [toggleCommand()],
    note: 'Look for "custom shortcuts" or "key bindings" in your desktop settings — or, on a ' +
      'compositor configured by hand (sway, river, Wayfire), in its config file.  Until then, ' +
      'click the tray icon to start and stop dictation.',
  };
}

// Everything Settings needs to render the shortcut section in one round trip. `trigger` is the
// portal's own description of the live key ('' when every trigger has been unchecked, which leaves
// the shortcut silently dead -- Settings says so).
function shortcutInfo() {
  return {
    mode,
    command: toggleCommand(),
    trigger: triggerDescription,
    canConfigure: mode === 'portal',
  };
}

module.exports = {
  init, displayBackend, usesPortal, toggleCommand,
  startPortal, configure, refresh, stopPortal, settled,
  shortcutMode, shortcutInfo, shortcutProblem,
  _internal: { electronToXdgTrigger, RETRY_DELAYS_MS },
};
