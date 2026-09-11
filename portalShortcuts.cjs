// Vendored from https://github.com/jtbr/dbus_globalshortcut_client (published, unmaintained).
// That repo is where this was developed and tested standalone; this copy is the living one --
// change it here, and port back only if the upstream is ever revived.

// D-Bus client for the XDG GlobalShortcuts portal, built on the generic bus client in
// electron/dbusConnection.cjs.
//
// Implements and extends scripts/portal-shortcut-probe.py in JavaScript so an app can
// bind its own global hotkey. This is mainly needed on Wayland, since X11 allows direct
// control. This is the best method when using XWayland, and is also needed under pure
// Wayland KDE, GNOME and Hyprland Wayland sessions since Electron's portal path is broken
// (user reassignment can cause the app to crash as the ID changes).
//
// No npm dependencies -- Node built-ins only.
//
// Module API:
//   const portal = require("./portalShortcuts.cjs");
//   portal.init(log);
//   const result = await portal.start({ id, description, preferredTrigger, onActivated,
//                                        onDisconnected, onShortcutsChanged });
//   const { shortcuts } = await portal.list();
//   portal.isAvailable();
//   await portal.configure();
//   portal.stop();
//
// See scripts/portal-client-probe.cjs for the standalone CLI harness built on this module.

'use strict';

const { variant, dictToObject } = require('./dbusWire.cjs');
const { DBusConnection } = require('./dbusConnection.cjs');

const PORTAL_NAME = 'org.freedesktop.portal.Desktop';
const PORTAL_PATH = '/org/freedesktop/portal/desktop';
const SHORTCUTS_IFACE = 'org.freedesktop.portal.GlobalShortcuts';
const REQUEST_IFACE = 'org.freedesktop.portal.Request';

const BUS_NAME = 'org.freedesktop.DBus';

// The portal is two processes, not one. `org.freedesktop.portal.Desktop` is the frontend, which
// routes each interface to a backend that claims `org.freedesktop.impl.portal.desktop.<desktop>`
// (`.kde`, `.gnome`, `.hyprland`, ...). GlobalShortcuts lives entirely in the backend, so
// restarting *it* kills our session while the frontend keeps its name and its owner -- invisible
// to a watch on the frontend alone. Matched as a namespace because we cannot know which backend
// is in play, and it is not ours to choose; the bus treats this as a dotted-prefix match, so a
// merely string-prefixed name like `...desktopSomethingElse` does not match (verified on the
// session bus).
const BACKEND_NAMESPACE = 'org.freedesktop.impl.portal.desktop';

// Whether a NameOwnerChanged for `name` means the GlobalShortcuts session we hold is gone. The
// match rules already narrow the traffic, but the bus is free to send more than was asked for and
// acting on an unrelated name change would be a bad bug. A backend we don't use may restart too;
// rebinding then is wasted work rather than incorrect -- the frontend never says which backend
// serves GlobalShortcuts, so there is nothing more precise to test.
function ownerChangeAffectsSession(name) {
  return name === PORTAL_NAME || name.startsWith(`${BACKEND_NAMESPACE}.`);
}
const BUS_PATH = '/org/freedesktop/DBus';

const REQUEST_TIMEOUT_MS = 120000; // the consent dialog is a human in the loop; bound every wait

let tokenCounter = 0;
function nextToken(prefix) {
  tokenCounter += 1;
  return `${prefix}${tokenCounter}`; // must stay [A-Za-z0-9_] -- a valid object-path element
}

function senderToken(uniqueName) {
  return uniqueName.slice(1).replace(/\./g, '_'); // ":1.234" -> "1_234"
}

// Drives the Request pattern (spec 5.1): subscribe to Request::Response at the predictable path
// *before* issuing the call, since a fast portal can answer before we'd otherwise be listening.
function callWithResponse(conn, method, buildBody, timeoutMs = REQUEST_TIMEOUT_MS) {
  const token = nextToken('t');
  const requestPath = `${PORTAL_PATH}/request/${senderToken(conn.uniqueName)}/${token}`;

  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      unsub();
      reject(new Error(`timeout waiting for ${method} response after ${timeoutMs}ms`));
    }, timeoutMs);

    const unsub = conn.onSignal({ path: requestPath, iface: REQUEST_IFACE, member: 'Response' }, (msg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsub();
      const [code, resultsPairs] = msg.body;
      resolve({ code, results: dictToObject(resultsPairs) });
    });

    const { sig, values } = buildBody(token);
    conn.call({
      destination: PORTAL_NAME, path: PORTAL_PATH, iface: SHORTCUTS_IFACE, member: method, bodySig: sig, bodyValues: values,
    }).catch((err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsub();
      reject(err);
    });
  });
}

async function checkAvailable(conn) {
  try {
    const [v] = await conn.call({
      destination: PORTAL_NAME, path: PORTAL_PATH, iface: 'org.freedesktop.DBus.Properties', member: 'Get', bodySig: 'ss', bodyValues: [SHORTCUTS_IFACE, 'version'],
    });
    return { available: true, version: v.value };
  } catch (err) {
    return { available: false, error: err.message };
  }
}

async function createSession(conn) {
  const { code, results } = await callWithResponse(conn, 'CreateSession', (token) => ({
    sig: 'a{sv}',
    values: [[
      ['handle_token', variant('s', token)],
      ['session_handle_token', variant('s', nextToken('sess'))],
    ]],
  }));
  if (code !== 0) return { code };
  // session_handle comes back typed as STRING, a documented quirk -- BindShortcuts etc. take it
  // as an object path ('o'), but the wire encoding is identical so no conversion is needed.
  return { code, sessionHandle: results.session_handle };
}

// Unwraps the nested a{sv} inside each (id, props) pair that BindShortcuts/ListShortcuts return.
function unwrapShortcuts(rawShortcuts) {
  return (rawShortcuts || []).map(([id, innerPairs]) => [id, dictToObject(innerPairs)]);
}

async function bindShortcuts(conn, session, shortcuts, parentWindow = '') {
  const { code, results } = await callWithResponse(conn, 'BindShortcuts', (token) => {
    const shortcutsValue = shortcuts.map((sc) => {
      const props = [['description', variant('s', sc.description)]];
      if (sc.preferredTrigger) props.push(['preferred_trigger', variant('s', sc.preferredTrigger)]);
      return [sc.id, props];
    });
    return {
      sig: 'oa(sa{sv})sa{sv}',
      values: [session, shortcutsValue, parentWindow, [['handle_token', variant('s', token)]]],
    };
  });
  if (code !== 0) return { code };
  return { code, shortcuts: unwrapShortcuts(results.shortcuts) };
}

async function listShortcuts(conn, session) {
  const { code, results } = await callWithResponse(conn, 'ListShortcuts', (token) => ({
    sig: 'oa{sv}',
    values: [session, [['handle_token', variant('s', token)]]],
  }));
  if (code !== 0) return { code };
  return { code, shortcuts: unwrapShortcuts(results.shortcuts) };
}

// Plain method call: no OUT parameter, no Response signal -- the editor appears or it doesn't.
async function configureShortcuts(conn, session, parentWindow = '') {
  await conn.call({
    destination: PORTAL_NAME, path: PORTAL_PATH, iface: SHORTCUTS_IFACE, member: 'ConfigureShortcuts', bodySig: 'osa{sv}', bodyValues: [session, parentWindow, []],
  });
}

// --- Module API (electron/*.cjs sibling shape: init(log), then instance methods) --------------

let log = () => {};
let conn = null;
let session = null;
let boundId = null;
let available = false;

function init(logger) {
  log = logger || (() => {});
}

async function start({
  id, description, preferredTrigger, onActivated, onDisconnected, onShortcutsChanged, parentWindow = '',
}) {
  if (conn) {
    log('warn', 'portal: start() called while already started; call stop() first');
    return { ok: false, reason: 'error', error: 'already started' };
  }

  let c;
  try {
    c = new DBusConnection(log);
    await c.connect();
  } catch (err) {
    log('info', `portal: unavailable (no D-Bus session bus): ${err.message}`);
    return { ok: false, reason: 'unavailable', error: err.message };
  }

  // Fires only on an unexpected drop (bus crash, compositor restart, portal backend going away
  // taking the socket with it, ...) -- stop() closes intentionally and this never sees it. There's
  // no reconnect here: a new Session has to be created and shortcuts rebound regardless, so
  // recovery is just calling start() again, which we leave to the caller via onDisconnected.
  // Both routes to "the binding is gone, start() again to get it back" end here. The caller sees
  // one callback because there is one remedy; the log line says which happened.
  let lostFired = false;
  const lost = (why) => {
    // A portal restart emits NameOwnerChanged twice (owner lost, then owner acquired), and a
    // socket close can follow either. One remedy, announced once.
    if (lostFired) return;
    lostFired = true;
    log('warn', `portal: ${why}`);
    if (conn === c) c.close();               // no-op for a socket that closed on its own

    conn = null;
    session = null;
    boundId = null;
    available = false;
    try {
      if (onDisconnected) onDisconnected();
    } catch (err) {
      log('error', `portal: onDisconnected handler threw: ${err.message}`);
    }
  };

  c.onClose(() => lost('D-Bus connection closed unexpectedly'));

  try {
    await c.hello();
    await c.addMatch(`type='signal',sender='${PORTAL_NAME}'`);
    // A session belongs to the portal process that created it, so when that process is replaced --
    // a restart, an update, a crash -- every handle we hold is dead: the shortcut stops firing and
    // ConfigureShortcuts answers "AccessDenied: Invalid session". Our own socket is untouched by
    // any of that (we are connected to the bus, not to the portal), so the socket-level disconnect
    // below never sees it. NameOwnerChanged is what does: the bus tells us the well-known name has
    // a new owner. Both names have to be watched -- see BACKEND_NAMESPACE. Measured on KDE Plasma 6:
    // restarting xdg-desktop-portal.service is caught by the first rule, and
    // plasma-xdg-desktop-portal-kde.service only by the second.
    await c.addMatch(
      `type='signal',sender='${BUS_NAME}',interface='${BUS_NAME}',member='NameOwnerChanged',arg0='${PORTAL_NAME}'`,
    );
    await c.addMatch(
      `type='signal',sender='${BUS_NAME}',interface='${BUS_NAME}',member='NameOwnerChanged',arg0namespace='${BACKEND_NAMESPACE}'`,
    );

    const avail = await checkAvailable(c);
    if (!avail.available) {
      log('info', `portal: unavailable (no GlobalShortcuts backend): ${avail.error}`);
      c.close();
      return { ok: false, reason: 'unavailable', error: avail.error };
    }
    log('info', `portal: GlobalShortcuts version ${avail.version}`);

    c.onSignal({ path: PORTAL_PATH, iface: SHORTCUTS_IFACE, member: 'Activated' }, (msg) => {
      const shortcutId = msg.body[1];
      // Dispatch on the id the portal sent -- never a locally reconstructed one (this is the
      // exact Chromium bug this module exists to avoid).
      if (shortcutId === id) {
        log('info', `portal: Activated ${shortcutId}`);
        try {
          if (onActivated) onActivated();
        } catch (err) {
          log('error', `portal: onActivated handler threw: ${err.message}`);
        }
      }
    });

    // The desktop tells us when the user edits our shortcut in its own editor (ConfigureShortcuts),
    // which is the only way it can change after the first bind. Without this the trigger we show
    // in the UI is whatever BindShortcuts said at startup, and stays wrong until the next launch.
    c.onSignal({ path: PORTAL_PATH, iface: SHORTCUTS_IFACE, member: 'ShortcutsChanged' }, (msg) => {
      const changed = unwrapShortcuts(msg.body[1]).find(([sid]) => sid === id);
      if (!changed) return;
      // An empty trigger_description is not "unknown" -- it means every trigger for this shortcut
      // has been switched off, and the shortcut can no longer fire. Pass it through as-is.
      const triggerDescription = changed[1].trigger_description || '';
      log('info', `portal: ShortcutsChanged ${id} -> ${triggerDescription || '(no trigger)'}`);
      try {
        if (onShortcutsChanged) onShortcutsChanged(triggerDescription);
      } catch (err) {
        log('error', `portal: onShortcutsChanged handler threw: ${err.message}`);
      }
    });

    c.onSignal({ path: BUS_PATH, iface: BUS_NAME, member: 'NameOwnerChanged' }, (msg) => {
      const [name, oldOwner, newOwner] = msg.body;
      if (!ownerChangeAffectsSession(name)) return;
      lost(`${name} changed owner (${oldOwner || 'none'} -> ${newOwner || 'none'}); the session it held is gone`);
    });

    const sessionResult = await createSession(c);
    if (sessionResult.code !== 0) {
      c.close();
      return { ok: false, reason: sessionResult.code === 1 ? 'denied' : 'error', error: `CreateSession response code ${sessionResult.code}` };
    }

    const bindResult = await bindShortcuts(c, sessionResult.sessionHandle, [{ id, description, preferredTrigger }], parentWindow);
    if (bindResult.code === 1) {
      c.close();
      return { ok: false, reason: 'denied' };
    }
    if (bindResult.code !== 0) {
      c.close();
      return { ok: false, reason: 'error', error: `BindShortcuts response code ${bindResult.code}` };
    }

    conn = c;
    session = sessionResult.sessionHandle;
    boundId = id;
    available = true;

    const bound = bindResult.shortcuts.find(([sid]) => sid === id);
    const triggerDescription = bound ? bound[1].trigger_description : undefined;
    if (!triggerDescription) {
      log('warn', `portal: shortcut ${id} is bound but every trigger is disabled -- it will not fire`);
    }
    return { ok: true, triggerDescription, shortcuts: bindResult.shortcuts };
  } catch (err) {
    log('error', `portal: start() failed: ${err.message}`);
    c.close();
    return { ok: false, reason: 'error', error: err.message };
  }
}

// The live shortcuts, straight from the portal. ShortcutsChanged covers edits made while we are
// running; this covers everything else -- notably a UI opening long after the fact, and any change
// the desktop made without telling us.
async function list() {
  if (!conn || !session) return { ok: false, reason: 'error', error: 'not started' };
  try {
    const result = await listShortcuts(conn, session);
    if (result.code !== 0) {
      return { ok: false, reason: 'error', error: `ListShortcuts response code ${result.code}` };
    }
    return { ok: true, shortcuts: result.shortcuts };
  } catch (err) {
    log('warn', `portal: list() failed: ${err.message}`);
    return { ok: false, reason: 'error', error: err.message };
  }
}

function isAvailable() {
  return available;
}

async function configure() {
  if (!conn || !session) {
    log('warn', 'portal: configure() called before a successful start()');
    return { ok: false, reason: 'error', error: 'not started' };
  }
  try {
    await configureShortcuts(conn, session);
    return { ok: true };
  } catch (err) {
    log('error', `portal: configure() failed: ${err.message}`);
    return { ok: false, reason: 'error', error: err.message };
  }
}

function stop() {
  if (conn) conn.close();
  conn = null;
  session = null;
  boundId = null;
  available = false;
}

module.exports = {
  init, start, isAvailable, configure, list, stop,
  // Exposed for scripts/portal-client-probe.cjs and for tests; not part of the documented module
  // API. DBusConnection itself lives in dbusConnection.cjs -- callers needing the generic client
  // should require that directly rather than reaching through here.
  _internal: {
    createSession, bindShortcuts, listShortcuts, configureShortcuts, checkAvailable,
    ownerChangeAffectsSession,
    PORTAL_NAME, PORTAL_PATH, SHORTCUTS_IFACE, BACKEND_NAMESPACE,
  },
};
