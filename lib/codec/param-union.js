'use strict';

/**
 * PX4 parameter int/float union (DESIGN.md §11).
 *
 * `PARAM_VALUE` / `PARAM_SET` carry the value in a `float` slot. PX4 stores
 * integer parameters by *reinterpreting the bit pattern* of that 4-byte slot,
 * not by converting the number: an int32 `V` is placed into the slot as raw
 * bytes, read back as int32 on the vehicle. Casting numerically instead
 * (`writeFloatLE(V)`) corrupts the parameter — the vehicle reads the float's
 * bits as an integer and gets nonsense. ArduPilot uses the slot as a genuine
 * float, so the reinterpret is a PX4-specific path the caller selects by
 * firmware; this module provides it and does not decide when to use it.
 *
 * The union is 4 bytes; 64-bit and real64 parameter types do not fit the
 * `PARAM_VALUE` float slot (they travel via `PARAM_EXT_*` as strings), so the
 * table below does not carry them.
 *
 * MAV_PARAM_TYPE (subset that fits the 4-byte float slot):
 *   1 UINT8  2 INT8  3 UINT16  4 INT16  5 UINT32  6 INT32  9 REAL32
 */
const PARAM_TYPES = {
  1: { name: 'MAV_PARAM_TYPE_UINT8', kind: 'uint', bytes: 1 },
  2: { name: 'MAV_PARAM_TYPE_INT8', kind: 'int', bytes: 1 },
  3: { name: 'MAV_PARAM_TYPE_UINT16', kind: 'uint', bytes: 2 },
  4: { name: 'MAV_PARAM_TYPE_INT16', kind: 'int', bytes: 2 },
  5: { name: 'MAV_PARAM_TYPE_UINT32', kind: 'uint', bytes: 4 },
  6: { name: 'MAV_PARAM_TYPE_INT32', kind: 'int', bytes: 4 },
  9: { name: 'MAV_PARAM_TYPE_REAL32', kind: 'real32', bytes: 4 },
};

/**
 * The table entry for a MAV_PARAM_TYPE value. Callers hand in the number —
 * lib/param resolves the editor's name before it reaches here, and the wire
 * decodes a number.
 *
 * @param {number} paramType MAV_PARAM_TYPE value.
 * @returns {{name:string, kind:string, bytes:number}} Table entry.
 */
function resolveParamType(paramType) {
  return PARAM_TYPES[paramType];
}

/**
 * Encode a parameter value into the `float` wire slot using the PX4 union.
 * REAL32 passes through untouched; integer types are written to a zero-filled
 * 4-byte buffer and read back as a float32 — the bit pattern the vehicle
 * expects. `Buffer.write*` throws `ERR_OUT_OF_RANGE` for an integer that
 * overflows the declared width.
 *
 * @param {*} value JS parameter value (integer for int types, number for REAL32).
 * @param {number|string} paramType MAV_PARAM_TYPE value or name.
 * @returns {number} The float to place in the `PARAM_VALUE`/`PARAM_SET` slot.
 */
function paramValueToWire(value, paramType) {
  const info = resolveParamType(paramType);
  if (info.kind === 'real32') return value;
  const buf = Buffer.alloc(4);
  writeInt(buf, Number(value), info);
  return buf.readFloatLE(0);
}

/**
 * Decode a `float` wire slot back to a parameter value using the PX4 union.
 * The inverse of {@link paramValueToWire}: the float bytes are read as the
 * integer type, or returned as-is for REAL32.
 *
 * @param {number} wireFloat The float from the `PARAM_VALUE` slot.
 * @param {number|string} paramType MAV_PARAM_TYPE value or name.
 * @returns {number} The JS parameter value.
 */
function paramValueFromWire(wireFloat, paramType) {
  const info = resolveParamType(paramType);
  if (info.kind === 'real32') return wireFloat;
  const buf = Buffer.alloc(4);
  buf.writeFloatLE(wireFloat, 0);
  return readInt(buf, info);
}

/**
 * Write an integer into the low bytes of a zeroed 4-byte union buffer. `Buffer`
 * enforces the type-width range and throws `ERR_OUT_OF_RANGE` for overflow.
 */
function writeInt(buf, n, info) {
  if (info.kind === 'uint') {
    if (info.bytes === 1) buf.writeUInt8(n, 0);
    else if (info.bytes === 2) buf.writeUInt16LE(n, 0);
    else buf.writeUInt32LE(n, 0);
  } else if (info.bytes === 1) buf.writeInt8(n, 0);
    else if (info.bytes === 2) buf.writeInt16LE(n, 0);
    else buf.writeInt32LE(n, 0);
}

/**
 * Read an integer from the low bytes of a 4-byte union buffer.
 */
function readInt(buf, info) {
  if (info.kind === 'uint') {
    if (info.bytes === 1) return buf.readUInt8(0);
    if (info.bytes === 2) return buf.readUInt16LE(0);
    return buf.readUInt32LE(0);
  }
  if (info.bytes === 1) return buf.readInt8(0);
  if (info.bytes === 2) return buf.readInt16LE(0);
  return buf.readInt32LE(0);
}

module.exports = { paramValueToWire, paramValueFromWire, PARAM_TYPES };
