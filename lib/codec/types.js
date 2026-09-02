'use strict';

/**
 * MAVLink scalar type table and the wire-value domain each type maps to.
 *
 * `node-mavlink`'s serializers are thin pass-throughs to `Buffer.write*`; this
 * table is the contract for what those serializers expect, kept here so the
 * knowledge lives in exactly one file. `lib/connection/wire.js` and
 * `wire-classes.js` read it to lay out payloads and synthesize classes.
 *
 * | MAVLink type        | wire-ready JS value              | Buffer writer        |
 * |---------------------|----------------------------------|----------------------|
 * | uint8_t/int8_t      | integer `Number`                 | writeU/IntInt8       |
 * | uint16_t/int16_t    | integer `Number`                 | writeU/Int16LE       |
 * | uint32_t/int32_t    | integer `Number` (bit 31 stays   | writeU/Int32LE       |
 * |                     | positive, e.g. 2147483648)       |                      |
 * | uint64_t/int64_t    | `BigInt` (decimal `string` on    | writeBigU/Int64LE    |
 * |                     | the JS side)                     |                      |
 * | float               | `Number` (narrowed to float32    | writeFloatLE         |
 * |                     | on the wire; NaN is lossless)    |                      |
 * | double              | `Number`                         | writeDoubleLE        |
 * | char (with [n])     | Latin-1 `string`, NUL-padded or  | buf.write(s,'latin1')|
 * |                     | truncated to exactly n bytes     |                      |
 *
 * Integer type-width fit checking lives in `Buffer.write*`, which throws
 * `ERR_OUT_OF_RANGE` for values that overflow the declared width (DESIGN.md
 * §14); nothing here re-checks it.
 *
 * `kind` groups types by wire representation, not by width:
 *   'uint' | 'int'      → 32-bit-or-smaller integers, a `Number`
 *   'uint64' | 'int64'  → 64-bit integers, a `BigInt`
 *   'float' | 'double'  → IEEE floats
 *   'char'              → Latin-1 string arrays
 */
const TYPE_INFO = {
  uint8_t: { size: 1, kind: 'uint', bytes: 1 },
  int8_t: { size: 1, kind: 'int', bytes: 1 },
  uint16_t: { size: 2, kind: 'uint', bytes: 2 },
  int16_t: { size: 2, kind: 'int', bytes: 2 },
  uint32_t: { size: 4, kind: 'uint', bytes: 4 },
  int32_t: { size: 4, kind: 'int', bytes: 4 },
  uint64_t: { size: 8, kind: 'uint64', bytes: 8 },
  int64_t: { size: 8, kind: 'int64', bytes: 8 },
  float: { size: 4, kind: 'float', bytes: 4 },
  double: { size: 8, kind: 'double', bytes: 8 },
  char: { size: 1, kind: 'char', bytes: 1 },
};

/**
 * Normalize a metadata type string to a table key. The only alias the registry
 * emits is `uint8_t_mavlink_version`, a plain `uint8_t` carrying the protocol
 * version; the bundle contract already collapses it, but normalizing here keeps
 * the table lookup correct even if a hand-built fixture does not.
 *
 * @param {string} type Raw MAVLink type string (no `[n]` suffix).
 * @returns {string} Canonical type key present in {@link TYPE_INFO}.
 */
function normalizeType(type) {
  if (type === 'uint8_t_mavlink_version') return 'uint8_t';
  return type;
}

/**
 * @param {string} type Raw MAVLink type string.
 * @returns {{size:number, kind:string, bytes:number}|undefined} Table entry.
 */
function typeInfo(type) {
  return TYPE_INFO[normalizeType(type)];
}

/**
 * @param {string} kind A `kind` from {@link TYPE_INFO}.
 * @returns {boolean} True for the two 64-bit integer kinds.
 */
function is64BitKind(kind) {
  return kind === 'uint64' || kind === 'int64';
}

module.exports = { normalizeType, typeInfo, is64BitKind };
