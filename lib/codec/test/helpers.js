'use strict';

/**
 * Test-local MAVLink payload writer and reader. Deliberately independent of the
 * codec's own type table so a pinned-byte test compares the codec against a
 * second implementation, not against itself. Uses `Buffer.write*` directly —
 * the wire truth — and no bitwise operators (this directory bans them).
 *
 * This file registers no tests; `node --test` executes every `.js` under a
 * `test/` directory, so it must be side-effect-free on require.
 *
 * Wire order (MAVLink v2): base fields sorted by type size descending, stable
 * (declaration order breaks ties); extension fields appended afterwards in
 * declaration order, never sorted. Field values are the codec's wire-ready
 * output (integer/BigInt/float/Latin-1 string/array).
 */

const SIZE = {
  uint8_t: 1,
  uint8_t_mavlink_version: 1,
  int8_t: 1,
  uint16_t: 2,
  int16_t: 2,
  uint32_t: 4,
  int32_t: 4,
  uint64_t: 8,
  int64_t: 8,
  float: 4,
  double: 8,
  char: 1,
};

/**
 * @param {{type:string, arrayLength:number|null}} field
 * @returns {number} Element size in bytes.
 */
function elementSize(field) {
  return SIZE[field.type];
}

/**
 * @param {{type:string, arrayLength:number|null}} field
 * @returns {number} Total wire size in bytes (element size × count).
 */
function fieldSize(field) {
  const count = field.arrayLength === null || field.arrayLength === undefined ? 1 : field.arrayLength;
  return elementSize(field) * count;
}

/**
 * Order fields as they appear in a MAVLink v2 payload.
 *
 * @param {Array} fields Fields in declaration order (extensions last).
 * @returns {Array} Fields in wire order.
 */
function wireOrder(fields) {
  const base = [];
  const extensions = [];
  fields.forEach((field, index) => {
    if (field.extension) extensions.push({ field, index });
    else base.push({ field, index });
  });
  base.sort((a, b) => {
    const diff = elementSize(b.field) - elementSize(a.field);
    return diff !== 0 ? diff : a.index - b.index;
  });
  return base.concat(extensions).map((entry) => entry.field);
}

/**
 * Write a scalar wire value at `offset`, returning the next offset.
 */
function writeScalar(buf, field, value, offset) {
  switch (field.type) {
    case 'uint8_t':
    case 'uint8_t_mavlink_version':
      return buf.writeUInt8(value, offset);
    case 'int8_t':
      return buf.writeInt8(value, offset);
    case 'uint16_t':
      return buf.writeUInt16LE(value, offset);
    case 'int16_t':
      return buf.writeInt16LE(value, offset);
    case 'uint32_t':
      return buf.writeUInt32LE(value, offset);
    case 'int32_t':
      return buf.writeInt32LE(value, offset);
    case 'uint64_t':
      return buf.writeBigUInt64LE(BigInt(value), offset);
    case 'int64_t':
      return buf.writeBigInt64LE(BigInt(value), offset);
    case 'float':
      return buf.writeFloatLE(value, offset);
    case 'double':
      return buf.writeDoubleLE(value, offset);
    default:
      throw new Error(`writer: unsupported type ${field.type}`);
  }
}

/**
 * Serialize wire-ready field values into a v2 payload buffer.
 *
 * @param {Array} fields Fields in declaration order.
 * @param {Object<string, *>} wireValues Codec wire-ready values by field name.
 * @returns {Buffer} The payload.
 */
function writePayload(fields, wireValues) {
  const order = wireOrder(fields);
  const total = fields.reduce((sum, field) => sum + fieldSize(field), 0);
  const buf = Buffer.alloc(total);
  let offset = 0;
  for (const field of order) {
    const value = wireValues[field.name];
    if (field.type === 'char') {
      const count = field.arrayLength === null || field.arrayLength === undefined ? 1 : field.arrayLength;
      buf.write(value, offset, count, 'latin1');
      offset += count;
    } else if (field.arrayLength !== null && field.arrayLength !== undefined) {
      for (let i = 0; i < field.arrayLength; i += 1) {
        offset = writeScalar(buf, field, value[i], offset);
      }
    } else {
      offset = writeScalar(buf, field, value, offset);
    }
  }
  return buf;
}

/**
 * Read a scalar wire value at `offset`, returning `[value, nextOffset]`.
 */
function readScalar(buf, field, offset) {
  switch (field.type) {
    case 'uint8_t':
    case 'uint8_t_mavlink_version':
      return [buf.readUInt8(offset), offset + 1];
    case 'int8_t':
      return [buf.readInt8(offset), offset + 1];
    case 'uint16_t':
      return [buf.readUInt16LE(offset), offset + 2];
    case 'int16_t':
      return [buf.readInt16LE(offset), offset + 2];
    case 'uint32_t':
      return [buf.readUInt32LE(offset), offset + 4];
    case 'int32_t':
      return [buf.readInt32LE(offset), offset + 4];
    case 'uint64_t':
      return [buf.readBigUInt64LE(offset), offset + 8];
    case 'int64_t':
      return [buf.readBigInt64LE(offset), offset + 8];
    case 'float':
      return [buf.readFloatLE(offset), offset + 4];
    case 'double':
      return [buf.readDoubleLE(offset), offset + 8];
    default:
      throw new Error(`reader: unsupported type ${field.type}`);
  }
}

/**
 * Parse a v2 payload buffer back into wire-ready field values.
 *
 * @param {Array} fields Fields in declaration order.
 * @param {Buffer} buf The payload.
 * @returns {Object<string, *>} Wire-ready values by field name.
 */
function readPayload(fields, buf) {
  const order = wireOrder(fields);
  const out = {};
  let offset = 0;
  for (const field of order) {
    if (field.type === 'char') {
      const count = field.arrayLength === null || field.arrayLength === undefined ? 1 : field.arrayLength;
      out[field.name] = buf.toString('latin1', offset, offset + count);
      offset += count;
    } else if (field.arrayLength !== null && field.arrayLength !== undefined) {
      const arr = [];
      for (let i = 0; i < field.arrayLength; i += 1) {
        const [value, next] = readScalar(buf, field, offset);
        arr.push(value);
        offset = next;
      }
      out[field.name] = arr;
    } else {
      const [value, next] = readScalar(buf, field, offset);
      out[field.name] = value;
      offset = next;
    }
  }
  return out;
}

/**
 * Build a bundle-shape `Field` with sensible defaults, overriding as needed.
 *
 * @param {Object} overrides Partial field.
 * @returns {Object} A complete `Field`.
 */
function field(overrides) {
  return {
    name: 'f',
    type: 'uint8_t',
    arrayLength: null,
    extension: false,
    enum: null,
    display: null,
    units: null,
    invalid: null,
    minValue: null,
    maxValue: null,
    increment: null,
    description: null,
    ...overrides,
  };
}

/**
 * Run `fn`, assert it throws a `FieldCodecError` naming `fieldName`, and
 * return the error. `node:assert/strict`'s `assert.throws` does not return the
 * thrown value on Node 22, so tests that need `.field` / `.message` go through
 * this helper.
 *
 * @param {Function} fn Call site expected to throw.
 * @param {Function} ErrorClass The `FieldCodecError` constructor.
 * @param {string} [fieldName] Expected `error.field` when given.
 * @returns {Error} The thrown error.
 */
function expectFieldError(fn, ErrorClass, fieldName) {
  let thrown;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  if (!thrown) throw new Error('expected FieldCodecError, nothing was thrown');
  if (!(thrown instanceof ErrorClass)) {
    throw new Error(`expected FieldCodecError, got ${thrown && thrown.name}: ${thrown && thrown.message}`);
  }
  if (fieldName !== undefined && thrown.field !== fieldName) {
    throw new Error(`expected error.field ${JSON.stringify(fieldName)}, got ${JSON.stringify(thrown.field)}`);
  }
  return thrown;
}

module.exports = { writePayload, readPayload, wireOrder, fieldSize, field, expectFieldError };
