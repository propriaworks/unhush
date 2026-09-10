// Vendored from https://github.com/jtbr/dbus_globalshortcut_portal (published, unmaintained).
// That repo is where this was developed and tested standalone; this copy is the living one --
// change it here, and port back only if the upstream is ever revived.

// D-Bus client for the XDG GlobalShortcuts portal, built on the generic bus client in
// electron/dbusConnection.cjs.
//
// Reimplements scripts/portal-shortcut-probe.py in JavaScript so an app can bind its own global
// hotkey on KDE, GNOME and Hyprland Wayland sessions without Electron's broken portal path (the
// vendor README at https://github.com/jtbr/dbus_globalshortcut_portal records what was measured).
// No npm dependencies -- Node built-ins only.
//
// Module API:
//   const portal = require("./portalShortcuts.cjs");
//   portal.init(log);
//   const result = await portal.start({ id, description, preferredTrigger, onActivated, onDisconnected });
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
  id, description, preferredTrigger, onActivated, onDisconnected, parentWindow = '',
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
  c.onClose(() => {
    log('warn', 'portal: D-Bus connection closed unexpectedly');
    conn = null;
    session = null;
    boundId = null;
    available = false;
    try {
      if (onDisconnected) onDisconnected();
    } catch (err) {
      log('error', `portal: onDisconnected handler threw: ${err.message}`);
    }
  });

  try {
    await c.hello();
    await c.addMatch(`type='signal',sender='${PORTAL_NAME}'`);

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
  init, start, isAvailable, configure, stop,
  // Exposed for scripts/portal-client-probe.cjs and for tests; not part of the documented module
  // API. DBusConnection itself lives in dbusConnection.cjs -- callers needing the generic client
  // should require that directly rather than reaching through here.
  _internal: {
    createSession, bindShortcuts, listShortcuts, configureShortcuts, checkAvailable,
    PORTAL_NAME, PORTAL_PATH, SHORTCUTS_IFACE,
  },
};
