// Vendored from https://github.com/jtbr/dbus_globalshortcut_client (published, unmaintained).
// That repo is where this was developed and tested standalone; this copy is the living one --
// change it here, and port back only if the upstream is ever revived.

// Low-level D-Bus wire protocol: type signatures, marshalling/unmarshalling, and message framing.
//
// No knowledge of sockets, auth, or the portal lives here -- this is pure byte-in/byte-out logic so
// it can be unit tested in isolation. See portalShortcuts.cjs for the connection that uses it.
//
// Reference: the D-Bus specification's "Marshalling (Wire Format)" section. The short version:
// every value aligns to its type's natural boundary *measured from the start of the message*, with
// zero padding bytes inserted before it. Getting that alignment wrong produces messages the bus
// daemon silently drops or an ERROR reply for -- there is no partial-parse diagnostic.

'use strict';

// The four D-Bus core bootstrapping calls (Hello, AddMatch, Properties.Get) and the
// GlobalShortcuts portal interface between them use y (header field codes), u (serials, version,
// response codes), t (Activated/Deactivated timestamps), s/o (strings and object paths -- same
// wire form), g (signatures), b (booleans -- e.g. Request::Response result
// values), plus the containers a/(/v/{. n, q, i, x and d (int16, uint16, int32, int64, double)
// are also implemented for completeness even though nothing here currently uses them.
const ALIGN = {
  y: 1, u: 4, t: 8, b: 4,
  n: 2, q: 2, i: 4, x: 8, d: 8,
  s: 4, o: 4, g: 1, a: 4, '(': 8, v: 1, '{': 8,
};

const BASIC_TYPE_CODES = 'yutsogbnqixd';

function align(n, boundary) {
  const rem = n % boundary;
  return rem === 0 ? n : n + (boundary - rem);
}

// --- Signature parsing -----------------------------------------------------------------------

function parseOne(sig, i) {
  const c = sig[i];
  if (c === undefined) throw new Error('unexpected end of signature');
  if (BASIC_TYPE_CODES.includes(c)) return [{ code: c }, i + 1];
  if (c === 'v') return [{ code: 'v' }, i + 1];
  if (c === 'a') {
    const [elem, ni] = parseOne(sig, i + 1);
    return [{ code: 'a', elem }, ni];
  }
  if (c === '(') {
    const fields = [];
    let j = i + 1;
    while (sig[j] !== ')') {
      if (sig[j] === undefined) throw new Error(`unterminated struct in signature: ${sig}`);
      const [field, nj] = parseOne(sig, j);
      fields.push(field);
      j = nj;
    }
    return [{ code: '(', fields }, j + 1];
  }
  if (c === '{') {
    const [keyType, ni] = parseOne(sig, i + 1);
    const [valType, nj] = parseOne(sig, ni);
    if (sig[nj] !== '}') throw new Error(`unterminated dict entry in signature: ${sig}`);
    return [{ code: '{', keyType, valType }, nj + 1];
  }
  throw new Error(`unsupported signature code '${c}' in: ${sig}`);
}

function parseSignature(sig) {
  const nodes = [];
  let i = 0;
  while (i < sig.length) {
    const [node, ni] = parseOne(sig, i);
    nodes.push(node);
    i = ni;
  }
  return nodes;
}

// --- Encoding ---------------------------------------------------------------------------------

class Writer {
  constructor(offsetBase) {
    this.offsetBase = offsetBase;
    this.chunks = [];
    this.len = 0;
  }

  get absPos() {
    return this.offsetBase + this.len;
  }

  _push(buf) {
    this.chunks.push(buf);
    this.len += buf.length;
  }

  align(boundary) {
    if (boundary <= 1) return;
    const rem = this.absPos % boundary;
    if (rem) this._push(Buffer.alloc(boundary - rem));
  }

  writeU8(v) {
    this._push(Buffer.from([v & 0xff]));
  }

  writeU16LE(v) {
    this.align(2);
    const b = Buffer.alloc(2);
    b.writeUInt16LE(v >>> 0, 0);
    this._push(b);
  }

  writeI16LE(v) {
    this.align(2);
    const b = Buffer.alloc(2);
    b.writeInt16LE(v, 0);
    this._push(b);
  }

  writeU32LE(v) {
    this.align(4);
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v >>> 0, 0);
    this._push(b);
  }

  writeI32LE(v) {
    this.align(4);
    const b = Buffer.alloc(4);
    b.writeInt32LE(v, 0);
    this._push(b);
  }

  writeU64LE(v) {
    this.align(8);
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(v), 0);
    this._push(b);
  }

  writeI64LE(v) {
    this.align(8);
    const b = Buffer.alloc(8);
    b.writeBigInt64LE(BigInt(v), 0);
    this._push(b);
  }

  writeDouble(v) {
    this.align(8);
    const b = Buffer.alloc(8);
    b.writeDoubleLE(v, 0);
    this._push(b);
  }

  writeString(str) {
    this.align(4);
    const bytes = Buffer.from(String(str), 'utf8');
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32LE(bytes.length, 0);
    this._push(lenBuf);
    this._push(bytes);
    this._push(Buffer.from([0]));
  }

  // Signature (`g`) uses a 1-byte length, unlike string/object-path's uint32 -- easy to miss.
  writeSignature(str) {
    const bytes = Buffer.from(String(str), 'ascii');
    this._push(Buffer.from([bytes.length]));
    this._push(bytes);
    this._push(Buffer.from([0]));
  }

  reservePlaceholderU32() {
    this.align(4);
    const idx = this.chunks.length;
    this._push(Buffer.alloc(4));
    return idx;
  }

  patchU32(idx, value) {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(value, 0);
    this.chunks[idx] = b;
  }

  buffer() {
    return Buffer.concat(this.chunks);
  }
}

function variant(sig, value) {
  return { sig, value };
}

function encodeValue(writer, type, value) {
  switch (type.code) {
    case 'y': writer.writeU8(value); return;
    case 'b': writer.writeU32LE(value ? 1 : 0); return; // wire form is uint32, not a single byte
    case 'n': writer.writeI16LE(value); return;
    case 'q': writer.writeU16LE(value); return;
    case 'i': writer.writeI32LE(value); return;
    case 'u': writer.writeU32LE(value); return;
    case 'x': writer.writeI64LE(value); return;
    case 't': writer.writeU64LE(value); return;
    case 'd': writer.writeDouble(value); return;
    case 's': writer.writeString(value); return;
    case 'o': writer.writeString(value); return; // same wire form as `s`; see landmine #5
    case 'g': writer.writeSignature(value); return;
    case 'v': {
      writer.writeSignature(value.sig);
      const [node] = parseSignature(value.sig);
      encodeValue(writer, node, value.value);
      return;
    }
    case 'a': {
      const idx = writer.reservePlaceholderU32();
      const elemAlign = ALIGN[type.elem.code];
      // Padding to the element's alignment is NOT counted in the array's byte length, even
      // though the array as a whole aligns to 4 -- only the padding *between elements* counts.
      writer.align(elemAlign);
      const contentStart = writer.absPos;
      for (const item of value) encodeValue(writer, type.elem, item);
      writer.patchU32(idx, writer.absPos - contentStart);
      return;
    }
    case '(': {
      writer.align(8);
      type.fields.forEach((f, i) => encodeValue(writer, f, value[i]));
      return;
    }
    case '{': {
      writer.align(8);
      encodeValue(writer, type.keyType, value[0]);
      encodeValue(writer, type.valType, value[1]);
      return;
    }
    default:
      throw new Error(`unsupported dbus type code: ${type.code}`);
  }
}

function marshal(sigString, values) {
  const nodes = parseSignature(sigString);
  const writer = new Writer(0);
  nodes.forEach((node, i) => encodeValue(writer, node, values[i]));
  return writer.buffer();
}

// --- Decoding -----------------------------------------------------------------------------------

class Reader {
  constructor(buf, pos = 0) {
    this.buf = buf;
    this.pos = pos;
  }

  align(boundary) {
    if (boundary <= 1) return;
    const rem = this.pos % boundary;
    if (rem) this.pos += boundary - rem;
  }

  readU8() {
    const v = this.buf.readUInt8(this.pos);
    this.pos += 1;
    return v;
  }

  readU16LE() {
    this.align(2);
    const v = this.buf.readUInt16LE(this.pos);
    this.pos += 2;
    return v;
  }

  readI16LE() {
    this.align(2);
    const v = this.buf.readInt16LE(this.pos);
    this.pos += 2;
    return v;
  }

  readU32LE() {
    this.align(4);
    const v = this.buf.readUInt32LE(this.pos);
    this.pos += 4;
    return v;
  }

  readI32LE() {
    this.align(4);
    const v = this.buf.readInt32LE(this.pos);
    this.pos += 4;
    return v;
  }

  readU64LE() {
    this.align(8);
    const v = this.buf.readBigUInt64LE(this.pos);
    this.pos += 8;
    return v;
  }

  readI64LE() {
    this.align(8);
    const v = this.buf.readBigInt64LE(this.pos);
    this.pos += 8;
    return v;
  }

  readDouble() {
    this.align(8);
    const v = this.buf.readDoubleLE(this.pos);
    this.pos += 8;
    return v;
  }

  readString() {
    this.align(4);
    const len = this.buf.readUInt32LE(this.pos);
    this.pos += 4;
    const v = this.buf.toString('utf8', this.pos, this.pos + len);
    this.pos += len + 1; // + trailing NUL
    return v;
  }

  readSignature() {
    const len = this.buf.readUInt8(this.pos);
    this.pos += 1;
    const v = this.buf.toString('ascii', this.pos, this.pos + len);
    this.pos += len + 1;
    return v;
  }
}

function decodeValue(reader, type) {
  switch (type.code) {
    case 'y': return reader.readU8();
    case 'b': return reader.readU32LE() !== 0;
    case 'n': return reader.readI16LE();
    case 'q': return reader.readU16LE();
    case 'i': return reader.readI32LE();
    case 'u': return reader.readU32LE();
    case 'x': return reader.readI64LE();
    case 't': return reader.readU64LE();
    case 'd': return reader.readDouble();
    case 's': return reader.readString();
    case 'o': return reader.readString();
    case 'g': return reader.readSignature();
    case 'v': {
      const sig = reader.readSignature();
      const [node] = parseSignature(sig);
      return { sig, value: decodeValue(reader, node) };
    }
    case 'a': {
      const len = reader.readU32LE();
      const elemAlign = ALIGN[type.elem.code];
      reader.align(elemAlign);
      const end = reader.pos + len;
      const items = [];
      while (reader.pos < end) items.push(decodeValue(reader, type.elem));
      reader.pos = end;
      return items;
    }
    case '(': {
      reader.align(8);
      return type.fields.map((f) => decodeValue(reader, f));
    }
    case '{': {
      reader.align(8);
      const k = decodeValue(reader, type.keyType);
      const v = decodeValue(reader, type.valType);
      return [k, v];
    }
    default:
      throw new Error(`unsupported dbus type code: ${type.code}`);
  }
}

function unmarshal(sigString, buf, startPos = 0) {
  const nodes = parseSignature(sigString);
  const reader = new Reader(buf, startPos);
  const values = nodes.map((n) => decodeValue(reader, n));
  return { values, endPos: reader.pos };
}

// A plain-object a{sv} dict, once decoded, is an array of [key, {sig, value}] pairs. Callers almost
// always want the unwrapped values keyed by name.
function dictToObject(pairs) {
  const out = {};
  for (const [k, v] of pairs || []) out[k] = v.value;
  return out;
}

// --- Message framing ------------------------------------------------------------------------

const MESSAGE_TYPE = { METHOD_CALL: 1, METHOD_RETURN: 2, ERROR: 3, SIGNAL: 4 };

const HEADER_FIELD = {
  PATH: 1, INTERFACE: 2, MEMBER: 3, ERROR_NAME: 4,
  REPLY_SERIAL: 5, DESTINATION: 6, SENDER: 7, SIGNATURE: 8,
};

const HEADER_FIELDS_TYPE = { code: 'a', elem: { code: '(', fields: [{ code: 'y' }, { code: 'v' }] } };

function buildMessage(opts) {
  const {
    type, flags = 0, serial, path, iface, member, errorName,
    replySerial, destination, bodySig, bodyValues,
  } = opts;

  const bodyBuf = bodySig ? marshal(bodySig, bodyValues || []) : Buffer.alloc(0);

  const fields = [];
  if (path) fields.push([HEADER_FIELD.PATH, variant('o', path)]);
  if (iface) fields.push([HEADER_FIELD.INTERFACE, variant('s', iface)]);
  if (member) fields.push([HEADER_FIELD.MEMBER, variant('s', member)]);
  if (errorName) fields.push([HEADER_FIELD.ERROR_NAME, variant('s', errorName)]);
  if (replySerial != null) fields.push([HEADER_FIELD.REPLY_SERIAL, variant('u', replySerial)]);
  if (destination) fields.push([HEADER_FIELD.DESTINATION, variant('s', destination)]);
  if (bodySig) fields.push([HEADER_FIELD.SIGNATURE, variant('g', bodySig)]);

  // The header-fields array starts right after the fixed 12-byte header, so alignment for its
  // contents (structs, which align to 8) must be measured from absolute offset 12, not 0.
  const hfWriter = new Writer(12);
  encodeValue(hfWriter, HEADER_FIELDS_TYPE, fields);
  const hfBuf = hfWriter.buffer();

  const fixed = Buffer.alloc(12);
  fixed[0] = 0x6c; // 'l' little-endian
  fixed[1] = type;
  fixed[2] = flags;
  fixed[3] = 1; // protocol version
  fixed.writeUInt32LE(bodyBuf.length, 4);
  fixed.writeUInt32LE(serial, 8);

  const preBodyLen = 12 + hfBuf.length;
  const pad = align(preBodyLen, 8) - preBodyLen;

  return Buffer.concat([fixed, hfBuf, Buffer.alloc(pad), bodyBuf]);
}

// Returns { message, consumed } once a full message is available in buf, or null if buf holds an
// incomplete message and the caller should wait for more data.
function tryParseMessage(buf) {
  if (buf.length < 16) return null;
  const headerArrayLen = buf.readUInt32LE(12);
  // 16 (fixed header + header-array length word) is always a multiple of 8, so no extra padding
  // can fall between the length word and the first (8-aligned) struct element.
  const totalHeaderLen = align(16 + headerArrayLen, 8);
  const bodyLen = buf.readUInt32LE(4);
  const total = totalHeaderLen + bodyLen;
  if (buf.length < total) return null;

  const msgBuf = buf.subarray(0, total);
  const endian = msgBuf[0];
  if (endian !== 0x6c) {
    throw new Error(`unsupported D-Bus endianness byte 0x${endian.toString(16)} (only little-endian 'l' is supported)`);
  }
  const type = msgBuf[1];
  const flags = msgBuf[2];
  const serial = msgBuf.readUInt32LE(8);

  const reader = new Reader(msgBuf, 12);
  const fieldPairs = decodeValue(reader, HEADER_FIELDS_TYPE);
  reader.align(8);
  const bodyStart = reader.pos;

  const header = {};
  for (const [code, v] of fieldPairs) header[code] = v.value;
  const bodySig = header[HEADER_FIELD.SIGNATURE] || '';
  const body = bodySig ? unmarshal(bodySig, msgBuf, bodyStart).values : [];

  return {
    message: {
      type,
      flags,
      serial,
      path: header[HEADER_FIELD.PATH],
      iface: header[HEADER_FIELD.INTERFACE],
      member: header[HEADER_FIELD.MEMBER],
      errorName: header[HEADER_FIELD.ERROR_NAME],
      replySerial: header[HEADER_FIELD.REPLY_SERIAL],
      destination: header[HEADER_FIELD.DESTINATION],
      sender: header[HEADER_FIELD.SENDER],
      signature: bodySig,
      body,
    },
    consumed: total,
  };
}

module.exports = {
  align,
  ALIGN,
  parseSignature,
  Writer,
  Reader,
  variant,
  encodeValue,
  decodeValue,
  marshal,
  unmarshal,
  dictToObject,
  MESSAGE_TYPE,
  HEADER_FIELD,
  HEADER_FIELDS_TYPE,
  buildMessage,
  tryParseMessage,
};
