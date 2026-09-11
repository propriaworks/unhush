// @vitest-environment node

// Vendored from https://github.com/jtbr/dbus_globalshortcut_client (published, unmaintained).
// That repo is where this was developed and tested standalone; this copy is the living one --
// change it here, and port back only if the upstream is ever revived.

// Marshalling is pure and deserves direct testing: round-trip a{sv}, a(sa{sv}), nested variants,
// and -- most importantly -- exact byte offsets/padding for known messages, since alignment bugs
// here produce confusing runtime errors (an ERROR reply, or silence) rather than obvious ones.

import { describe, expect, it } from 'vitest';

const {
  parseSignature, marshal, unmarshal, variant, dictToObject, buildMessage, tryParseMessage, MESSAGE_TYPE,
  // eslint-disable-next-line @typescript-eslint/no-var-requires
} = require('./dbusWire.cjs');

describe('parseSignature', () => {
  it('parses primitives, arrays, structs and dict entries', () => {
    expect(parseSignature('y')).toEqual([{ code: 'y' }]);
    expect(parseSignature('as')).toEqual([{ code: 'a', elem: { code: 's' } }]);
    expect(parseSignature('a{sv}')).toEqual([
      { code: 'a', elem: { code: '{', keyType: { code: 's' }, valType: { code: 'v' } } },
    ]);
    expect(parseSignature('(sa{sv})')).toEqual([
      { code: '(', fields: [{ code: 's' }, { code: 'a', elem: { code: '{', keyType: { code: 's' }, valType: { code: 'v' } } }] },
    ]);
  });

  it('parses a multi-type top-level sequence as separate nodes, not a struct', () => {
    const nodes = parseSignature('oa(sa{sv})sa{sv}');
    expect(nodes).toHaveLength(4);
    expect(nodes[0]).toEqual({ code: 'o' });
    expect(nodes[2]).toEqual({ code: 's' });
  });
});

describe('exact byte offsets and padding', () => {
  it('pads a byte then uint32 to a 4-byte boundary, then reads uint32 with no further pad', () => {
    // Classic case: y at offset 0 (1 byte), u needs 4-byte alignment -> 3 pad bytes, then the
    // second u is already aligned. Total: 1 + 3 + 4 + 4 = 12 bytes.
    const buf = marshal('yuu', [0x42, 0xcafebabe, 0xdeadbeef]);
    expect(buf.length).toBe(12);
    expect(buf.readUInt8(0)).toBe(0x42);
    expect(buf.subarray(1, 4)).toEqual(Buffer.alloc(3)); // padding, all zero
    expect(buf.readUInt32LE(4)).toBe(0xcafebabe);
    expect(buf.readUInt32LE(8)).toBe(0xdeadbeef);
  });

  it('pads a byte then int32 to a 4-byte boundary, then reads int32 with no further pad', () => {
    const buf = marshal('yiu', [0x42, -7, 0xdeadbeef]);
    expect(buf.length).toBe(12);
    expect(buf.readUInt8(0)).toBe(0x42);
    expect(buf.subarray(1, 4)).toEqual(Buffer.alloc(3)); // padding, all zero
    expect(buf.readInt32LE(4)).toBe(-7);
    expect(buf.readUInt32LE(8)).toBe(0xdeadbeef);
  });

  it('pads a byte then boolean to a 4-byte boundary, wire form is uint32 not a single byte', () => {
    const buf = marshal('yb', [0x42, true]);
    expect(buf.length).toBe(8); // 1 + 3 pad + 4, not 1 + 3 pad + 1
    expect(buf.readUInt8(0)).toBe(0x42);
    expect(buf.readUInt32LE(4)).toBe(1);
  });

  it('excludes the length-to-first-element pad from the array length, but counts inter-element padding', () => {
    // Array of uint64 (8-byte aligned elements). After the 4-byte length field (offset 0-3), the
    // writer sits at absolute offset 4 and must pad 4 bytes to reach the element's 8-byte
    // boundary -- that pad must NOT be counted in the length word itself.
    const buf = marshal('at', [[1n, 2n]]);
    expect(buf.length).toBe(4 + 4 + 16); // length word + excluded pad + 2*8 byte elements
    expect(buf.readUInt32LE(0)).toBe(16); // contents only: two 8-byte uint64s
    expect(buf.subarray(4, 8)).toEqual(Buffer.alloc(4)); // the excluded pad, still physically present
    expect(buf.readBigUInt64LE(8)).toBe(1n);
    expect(buf.readBigUInt64LE(16)).toBe(2n);
  });

  it('excludes the length-to-first-element pad from the array length (int64 element)', () => {
    const buf = marshal('ax', [[1n, 2n]]);
    expect(buf.length).toBe(4 + 4 + 16);
    expect(buf.readUInt32LE(0)).toBe(16);
    expect(buf.subarray(4, 8)).toEqual(Buffer.alloc(4));
    expect(buf.readBigInt64LE(8)).toBe(1n);
    expect(buf.readBigInt64LE(16)).toBe(2n);
  });

  it('signature (g) uses a 1-byte length, unlike string/object-path (s/o)', () => {
    const sigBuf = marshal('g', ['a{sv}']);
    // 1 length byte + 5 chars + NUL = 7, no 4-byte length and no leading alignment padding.
    expect(sigBuf.length).toBe(7);
    expect(sigBuf.readUInt8(0)).toBe(5);
    expect(sigBuf.subarray(1, 6).toString('ascii')).toBe('a{sv}');
    expect(sigBuf.readUInt8(6)).toBe(0);

    const strBuf = marshal('s', ['ab']);
    // 4-byte length + 2 chars + NUL = 7 too, but arrived at differently (uint32 length).
    expect(strBuf.readUInt32LE(0)).toBe(2);
  });

  it('lays out a full method-call message with correct header alignment and body length', () => {
    const buf = buildMessage({
      type: MESSAGE_TYPE.METHOD_CALL,
      serial: 7,
      path: '/org/freedesktop/portal/desktop',
      iface: 'org.freedesktop.portal.GlobalShortcuts',
      member: 'ListShortcuts',
      destination: 'org.freedesktop.portal.Desktop',
      bodySig: 's',
      bodyValues: ['hello'],
    });
    expect(buf[0]).toBe(0x6c); // 'l' little-endian
    expect(buf[1]).toBe(MESSAGE_TYPE.METHOD_CALL);
    expect(buf[3]).toBe(1); // protocol version
    expect(buf.readUInt32LE(8)).toBe(7); // serial
    // body: 4-byte len (5) + "hello" (5) + NUL = 10 bytes
    expect(buf.readUInt32LE(4)).toBe(10);
    expect(buf.subarray(buf.length - 10).toString('utf8', 4, 9)).toBe('hello');
  });
});

describe('round-trip encoding through decoding', () => {
  function roundTrip(sig, values) {
    const buf = marshal(sig, values);
    return unmarshal(sig, buf).values;
  }

  it('round-trips a{sv} with mixed variant types', () => {
    const pairs = [
      ['handle_token', variant('s', 'tok1')],
      ['count', variant('u', 42)],
    ];
    const [decoded] = roundTrip('a{sv}', [pairs]);
    expect(dictToObject(decoded)).toEqual({ handle_token: 'tok1', count: 42 });
  });

  it('round-trips a(sa{sv}) -- the BindShortcuts response shape', () => {
    const shortcuts = [
      ['toggle-recording', [
        ['description', variant('s', 'Start or stop dictation')],
        ['trigger_description', variant('s', 'CTRL+ALT+space')],
      ]],
    ];
    const [decoded] = roundTrip('a(sa{sv})', [shortcuts]);
    expect(decoded).toHaveLength(1);
    const [id, propsPairs] = decoded[0];
    expect(id).toBe('toggle-recording');
    expect(dictToObject(propsPairs)).toEqual({
      description: 'Start or stop dictation',
      trigger_description: 'CTRL+ALT+space',
    });
  });

  it('round-trips a nested variant (a variant whose value is itself a compound type)', () => {
    // Mirrors the real shape: BindShortcuts' "shortcuts" result is a variant over a(sa{sv}).
    const inner = [['toggle-recording', [['description', variant('s', 'toggle')]]]];
    const pairs = [['shortcuts', variant('a(sa{sv})', inner)]];
    const [decoded] = roundTrip('a{sv}', [pairs]);
    const obj = dictToObject(decoded);
    expect(obj.shortcuts).toEqual(inner);
  });

  it('round-trips the full oa(sa{sv})sa{sv} BindShortcuts call signature', () => {
    const session = '/org/freedesktop/portal/desktop/session/1_234/sess1';
    const shortcuts = [['toggle-recording', [
      ['description', variant('s', 'Start or stop dictation')],
      ['preferred_trigger', variant('s', 'CTRL+ALT+space')],
    ]]];
    const options = [['handle_token', variant('s', 'tok1')]];
    const [decSession, decShortcuts, decParent, decOptions] = roundTrip(
      'oa(sa{sv})sa{sv}',
      [session, shortcuts, '', options],
    );
    expect(decSession).toBe(session);
    expect(decParent).toBe('');
    expect(dictToObject(decOptions)).toEqual({ handle_token: 'tok1' });
    const [id, propsPairs] = decShortcuts[0];
    expect(id).toBe('toggle-recording');
    expect(dictToObject(propsPairs)).toEqual({
      description: 'Start or stop dictation',
      preferred_trigger: 'CTRL+ALT+space',
    });
  });

  it('round-trips an empty array without breaking element alignment', () => {
    const [decoded] = roundTrip('a{sv}', [[]]);
    expect(decoded).toEqual([]);
  });

  it('round-trips booleans, decoding any nonzero uint32 as true', () => {
    expect(roundTrip('b', [true])).toEqual([true]);
    expect(roundTrip('b', [false])).toEqual([false]);
    const { values } = unmarshal('b', marshal('u', [42]));
    expect(values).toEqual([true]);
  });

  it('round-trips int16 and uint16, including negative and out-of-int16-range values', () => {
    expect(roundTrip('n', [-1])).toEqual([-1]);
    expect(roundTrip('n', [-32768])).toEqual([-32768]);
    expect(roundTrip('q', [65535])).toEqual([65535]);
  });

  it('round-trips int32', () => {
    expect(roundTrip('i', [-2147483648])).toEqual([-2147483648]);
    expect(roundTrip('i', [2147483647])).toEqual([2147483647]);
  });

  it('round-trips int64 as a bigint', () => {
    expect(roundTrip('x', [-1n])).toEqual([-1n]);
    expect(roundTrip('x', [9223372036854775807n])).toEqual([9223372036854775807n]);
  });

  it('round-trips a double, including fractional values', () => {
    expect(roundTrip('d', [3.14159])).toEqual([3.14159]);
    expect(roundTrip('d', [-0.5])).toEqual([-0.5]);
  });
});

describe('message framing over a byte stream', () => {
  it('returns null until a full message has arrived, then parses it and reports bytes consumed', () => {
    const full = buildMessage({
      type: MESSAGE_TYPE.METHOD_CALL,
      serial: 1,
      path: '/org/freedesktop/DBus',
      iface: 'org.freedesktop.DBus',
      member: 'Hello',
      destination: 'org.freedesktop.DBus',
    });

    expect(tryParseMessage(full.subarray(0, 8))).toBeNull();
    expect(tryParseMessage(full.subarray(0, full.length - 1))).toBeNull();

    const result = tryParseMessage(full);
    expect(result).not.toBeNull();
    expect(result.consumed).toBe(full.length);
    expect(result.message.member).toBe('Hello');
    expect(result.message.iface).toBe('org.freedesktop.DBus');
    expect(result.message.destination).toBe('org.freedesktop.DBus');
    expect(result.message.serial).toBe(1);
  });

  it('parses two concatenated messages one at a time, in order', () => {
    const msg1 = buildMessage({ type: MESSAGE_TYPE.METHOD_CALL, serial: 1, path: '/a', iface: 'i', member: 'One', destination: 'd' });
    const msg2 = buildMessage({ type: MESSAGE_TYPE.METHOD_CALL, serial: 2, path: '/a', iface: 'i', member: 'Two', destination: 'd' });
    const combined = Buffer.concat([msg1, msg2]);

    const first = tryParseMessage(combined);
    expect(first.message.member).toBe('One');
    const rest = combined.subarray(first.consumed);
    const second = tryParseMessage(rest);
    expect(second.message.member).toBe('Two');
    expect(second.consumed).toBe(rest.length);
  });

  it('round-trips an ERROR message with a REPLY_SERIAL header field', () => {
    const buf = buildMessage({
      type: MESSAGE_TYPE.ERROR,
      serial: 5,
      replySerial: 3,
      errorName: 'org.freedesktop.DBus.Error.Failed',
      destination: ':1.1',
      bodySig: 's',
      bodyValues: ['no GlobalShortcuts backend'],
    });
    const { message } = tryParseMessage(buf);
    expect(message.type).toBe(MESSAGE_TYPE.ERROR);
    expect(message.replySerial).toBe(3);
    expect(message.errorName).toBe('org.freedesktop.DBus.Error.Failed');
    expect(message.body).toEqual(['no GlobalShortcuts backend']);
  });
});

// The portal is two processes, and watching only the frontend let a backend
// restart kill the binding silently -- this predicate exists to prevent regressing
const {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  _internal: { ownerChangeAffectsSession },
  // eslint-disable-next-line @typescript-eslint/no-var-requires
} = require('./portalShortcuts.cjs');

describe('ownerChangeAffectsSession', () => {
  it('matches the portal frontend', () => {
    expect(ownerChangeAffectsSession('org.freedesktop.portal.Desktop')).toBe(true);
  });

  it('matches any desktop backend, whichever implements GlobalShortcuts', () => {
    for (const backend of ['kde', 'gnome', 'hyprland', 'wlr', 'cosmic']) {
      expect(ownerChangeAffectsSession(`org.freedesktop.impl.portal.desktop.${backend}`)).toBe(true);
    }
  });

  it('ignores unrelated names, including a merely string-prefixed one', () => {
    for (const name of [
      'org.freedesktop.impl.portal.PermissionStore',
      'org.freedesktop.impl.portal.desktopOther',
      'org.freedesktop.portal.Documents',
      'org.kde.KWin',
      ':1.42',
    ]) {
      expect(ownerChangeAffectsSession(name)).toBe(false);
    }
  });
});
