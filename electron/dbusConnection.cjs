// Vendored from https://github.com/jtbr/dbus_globalshortcut_client (published, unmaintained).
// That repo is where this was developed and tested standalone; this copy is the living one --
// change it here, and port back only if the upstream is ever revived.

// Generic D-Bus bus client: connect to the session/system bus, SASL-authenticate, and exchange
// messages. No knowledge of the portal or of GlobalShortcuts lives here -- this is the reusable
// half of the stack, on top of electron/dbusWire.cjs's pure marshalling. See portalShortcuts.cjs
// for the GlobalShortcuts-specific calls built on top of this.

'use strict';

const net = require('net');
const { MESSAGE_TYPE, buildMessage, tryParseMessage } = require('./dbusWire.cjs');

const BUS_NAME = 'org.freedesktop.DBus';
const BUS_PATH = '/org/freedesktop/DBus';
const BUS_IFACE = 'org.freedesktop.DBus';

class DBusError extends Error {
  constructor(errorName, detail) {
    super(`${errorName}${detail ? `: ${detail}` : ''}`);
    this.name = 'DBusError';
    this.errorName = errorName;
  }
}

function parseBusAddress(addr) {
  // e.g. "unix:path=/run/user/1000/bus" or "unix:abstract=/tmp/dbus-XXXX,guid=..."; may list
  // several ";"-separated addresses to try -- we only need the first that parses.
  const first = addr.split(';')[0];
  if (!first.startsWith('unix:')) throw new Error(`unsupported D-Bus address (only unix: is supported): ${addr}`);
  const kv = {};
  for (const pair of first.slice('unix:'.length).split(',')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    kv[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  if (kv.path) return kv.path;
  // Node connects to an abstract socket via a path whose first byte is NUL.
  if (kv.abstract) return `\0${kv.abstract}`;
  throw new Error(`unix D-Bus address missing path= or abstract=: ${addr}`);
}

class DBusConnection {
  constructor(log) {
    this.log = log || (() => {});
    this.socket = null;
    this.serial = 1;
    this.pending = new Map();
    this.signalHandlers = [];
    this.closeHandlers = [];
    this.recvBuf = Buffer.alloc(0);
    this.uniqueName = null;
  }

  async connect() {
    const addr = process.env.DBUS_SESSION_BUS_ADDRESS;
    if (!addr) throw new Error('DBUS_SESSION_BUS_ADDRESS is not set');
    const path = parseBusAddress(addr);

    await new Promise((resolve, reject) => {
      const socket = net.createConnection(path);
      const onError = (err) => reject(err);
      socket.once('error', onError);
      socket.once('connect', () => {
        socket.removeListener('error', onError);
        this.socket = socket;
        resolve();
      });
    });

    this.socket.on('error', (err) => this._onSocketError(err));
    this.socket.on('close', () => this._onSocketClose());

    await this._handshake();
  }

  async _handshake() {
    // SASL EXTERNAL: prove our uid, then switch to binary D-Bus framing. See spec 4.2.
    const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
    const hex = Buffer.from(String(uid), 'ascii').toString('hex');

    const { line, rest } = await new Promise((resolve, reject) => {
      let buf = Buffer.alloc(0);
      const onData = (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        const idx = buf.indexOf('\r\n');
        if (idx !== -1) {
          this.socket.removeListener('data', onData);
          this.socket.removeListener('error', onError);
          resolve({ line: buf.subarray(0, idx).toString('ascii'), rest: buf.subarray(idx + 2) });
        }
      };
      const onError = (err) => reject(err);
      this.socket.on('data', onData);
      this.socket.once('error', onError);
      this.socket.write(Buffer.from([0]));
      this.socket.write(`AUTH EXTERNAL ${hex}\r\n`);
    });

    if (!line.startsWith('OK ')) throw new Error(`D-Bus SASL auth rejected: ${line}`);
    this.socket.write('BEGIN\r\n');

    this.recvBuf = rest;
    this.socket.on('data', (chunk) => this._onData(chunk));
    if (this.recvBuf.length) this._onData(Buffer.alloc(0));
  }

  _onData(chunk) {
    this.recvBuf = this.recvBuf.length ? Buffer.concat([this.recvBuf, chunk]) : chunk;
    for (;;) {
      let parsed;
      try {
        parsed = tryParseMessage(this.recvBuf);
      } catch (err) {
        this.log('error', `dbus: failed to parse incoming message, dropping buffer: ${err.message}`);
        this.recvBuf = Buffer.alloc(0);
        return;
      }
      if (!parsed) return;
      this.recvBuf = this.recvBuf.subarray(parsed.consumed);
      this._dispatch(parsed.message);
    }
  }

  _dispatch(msg) {
    if (msg.type === MESSAGE_TYPE.METHOD_RETURN || msg.type === MESSAGE_TYPE.ERROR) {
      const p = this.pending.get(msg.replySerial);
      if (!p) return;
      this.pending.delete(msg.replySerial);
      if (msg.type === MESSAGE_TYPE.ERROR) {
        p.reject(new DBusError(msg.errorName, msg.body && msg.body[0]));
      } else {
        p.resolve(msg.body);
      }
      return;
    }
    // Inbound METHOD_CALLs are ignored: we're a client only, and export no objects.
    if (msg.type === MESSAGE_TYPE.SIGNAL) {
      for (const h of this.signalHandlers.slice()) {
        if (h.path && h.path !== msg.path) continue;
        if (h.iface && h.iface !== msg.iface) continue;
        if (h.member && h.member !== msg.member) continue;
        try {
          h.fn(msg);
        } catch (err) {
          this.log('error', `dbus: signal handler for ${msg.iface}.${msg.member} threw: ${err.message}`);
        }
      }
    }
  }

  _onSocketError(err) {
    // 'close' always follows 'error' on a net.Socket -- _onSocketClose does the actual teardown
    // and notification, so this is just for the log.
    this.log('error', `dbus: socket error: ${err.message}`);
  }

  // Unexpected disconnect (bus crash, compositor/session restart, etc). Does NOT fire for an
  // intentional close() -- that already tears down state and the caller knows it initiated it.
  _onSocketClose() {
    this.socket = null;
    const err = new Error('D-Bus connection closed');
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    for (const fn of this.closeHandlers.slice()) {
      try {
        fn();
      } catch (e) {
        this.log('error', `dbus: close handler threw: ${e.message}`);
      }
    }
  }

  call({ destination, path, iface, member, bodySig = '', bodyValues = [] }) {
    if (!this.socket) return Promise.reject(new Error('D-Bus connection is closed'));
    const serial = this.serial++;
    const msg = buildMessage({
      type: MESSAGE_TYPE.METHOD_CALL, flags: 0, serial, path, iface, member, destination, bodySig, bodyValues,
    });
    return new Promise((resolve, reject) => {
      this.pending.set(serial, { resolve, reject });
      this.socket.write(msg);
    });
  }

  // Rule string, e.g. "type='signal',sender='org.freedesktop.portal.Desktop'".
  onSignal({ path, iface, member }, fn) {
    const entry = { path, iface, member, fn };
    this.signalHandlers.push(entry);
    return () => {
      const i = this.signalHandlers.indexOf(entry);
      if (i !== -1) this.signalHandlers.splice(i, 1);
    };
  }

  // Fires once on an unexpected disconnect (not on a caller-initiated close()). The bus itself
  // rarely dies, but the portal backend restarting, a compositor restart, or suspend/resume can
  // still take the socket down -- there is no transparent reconnect here since a fresh Session
  // has to be created and shortcuts rebound anyway (GlobalShortcuts has no restore token), so
  // recovery is really "call start() again", which belongs to the caller.
  onClose(fn) {
    this.closeHandlers.push(fn);
    return () => {
      const i = this.closeHandlers.indexOf(fn);
      if (i !== -1) this.closeHandlers.splice(i, 1);
    };
  }

  async hello() {
    const [name] = await this.call({ destination: BUS_NAME, path: BUS_PATH, iface: BUS_IFACE, member: 'Hello' });
    this.uniqueName = name;
    return name;
  }

  addMatch(rule) {
    return this.call({
      destination: BUS_NAME, path: BUS_PATH, iface: BUS_IFACE, member: 'AddMatch', bodySig: 's', bodyValues: [rule],
    });
  }

  close() {
    if (!this.socket) return;
    // Remove our own listeners first so an intentional close doesn't also run _onSocketClose's
    // unexpected-disconnect teardown (which would fire the close handlers registered via onClose).
    this.socket.removeAllListeners('close');
    this.socket.removeAllListeners('error');
    this.socket.destroy();
    this.socket = null;
    const err = new Error('D-Bus connection closed');
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }
}

module.exports = { DBusConnection, DBusError, parseBusAddress };
