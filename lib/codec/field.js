'use strict';

const { fail } = require('./errors');
const { typeInfo, is64BitKind } = require('./types');
const { toInteger, toBigInt, toFloat } = require('./numeric');
const { assembleBitmask, decodeBitmask } = require('./mask');

/**
 * Field-level conversion between JavaScript values and MAVLink wire values,
 * driven by one compiled `Field` from the dialect bundle (see
 * `/tmp/briefs/bundle-shape.md`). The codec relies only on `Field.*` and, for
 * enum-typed fields, `Enum.bitmask` and `Enum.entries[].{name,value}`.
 *
 * @typedef {Object} Field
 * @property {string} name Wire/XML field name (snake_case).
 * @property {string} type MAVLink scalar type without the `[n]` suffix.
 * @property {number|null} arrayLength Array length, or null for a scalar.
 * @property {boolean} extension True for a v2 extension field.
 * @property {string|null} enum Screaming enum name when enum-typed.
 * @property {string|null} display `'bitmask'` when known, else null.
 * @property {string|null} invalid Sentinel marker (`'NaN'`, `'0'`, …).
 * @property {number|null} minValue Declared minimum, or null.
 * @property {number|null} maxValue Declared maximum, or null.
 *
 * @typedef {Object} Enum
 * @property {boolean} bitmask Whether the enum is a bitmask.
 * @property {Array<{name:string, value:number|string}>} entries Enum entries.
 */

/**
 * Encode one JavaScript value to its MAVLink wire-ready form for `field`.
 *
 * Dispatch:
 *   - `char`                    → Latin-1 string, NUL-padded/truncated to length
 *   - array (numeric)           → array of encoded elements, zero-padded to length
 *   - bitmask enum + array/name → assembled numeric mask
 *   - scalar enum + entry name  → the entry's numeric value
 *   - integer / 64-bit / float  → validated `Number` / `BigInt` / `Number`
 *
 * Never coerces a missing or non-numeric value; every rejection names the
 * field (DESIGN.md §5).
 *
 * @param {Field} field The field metadata.
 * @param {*} value The JavaScript value to encode.
 * @param {Enum} [enumMeta] Enum metadata when `field.enum` is set.
 * @returns {number|bigint|string|Array} The wire-ready value.
 */
function encodeField(field, value, enumMeta) {
  const info = typeInfo(field.type);
  if (!info) fail(field.name, `unknown MAVLink type ${JSON.stringify(field.type)}`);

  if (info.kind === 'char') return encodeChar(field, value);
  if (field.arrayLength !== null && field.arrayLength !== undefined) {
    return encodeArray(field, value, info, enumMeta);
  }
  return encodeScalar(field, value, info, enumMeta);
}

/**
 * Decode one MAVLink wire value back to a JavaScript value for `field`.
 *
 *   - `char`             → string with trailing NULs stripped
 *   - array              → array of decoded elements
 *   - 64-bit integer     → decimal string (BigInt is exact, string is portable)
 *   - float/double       → `Number` (NaN preserved losslessly)
 *   - other integers     → `Number`
 *
 * @param {Field} field The field metadata.
 * @param {*} wireValue The value as produced by the wire reader.
 * @returns {number|string|Array} The JavaScript value.
 */
function decodeField(field, wireValue) {
  const info = typeInfo(field.type);
  if (!info) fail(field.name, `unknown MAVLink type ${JSON.stringify(field.type)}`);

  if (info.kind === 'char') return decodeChar(field, wireValue);
  if (field.arrayLength !== null && field.arrayLength !== undefined) {
    if (!Array.isArray(wireValue)) fail(field.name, 'wire value for an array field must be an array');
    return wireValue.map((element) => decodeScalar(field, element, info));
  }
  return decodeScalar(field, wireValue, info);
}

/**
 * Encode a scalar field, resolving enum names and bitmask arrays first.
 */
function encodeScalar(field, value, info, enumMeta) {
  const use64 = is64BitKind(info.kind);

  if (Array.isArray(value)) {
    if (!enumMeta) fail(field.name, 'array value given for a non-enum scalar field');
    return assembleBitmask(enumMeta, value, use64, field.name);
  }

  let resolved = value;
  if (enumMeta && typeof value === 'string' && !/^[+-]?\d+(\.\d+)?$/.test(value.trim()) && value.trim().toLowerCase() !== 'nan') {
    const entry = enumMeta.entries.find((e) => e.name === value.trim());
    if (!entry) fail(field.name, `unknown ${field.enum} entry ${JSON.stringify(value)}`);
    resolved = entry.value;
  }

  const bounds = { minValue: field.minValue, maxValue: field.maxValue };
  switch (info.kind) {
    case 'uint':
    case 'int':
      return toInteger(field.name, resolved, bounds);
    case 'uint64':
    case 'int64':
      return toBigInt(field.name, resolved, bounds);
    case 'float':
    case 'double':
      return toFloat(field.name, resolved);
    default:
      return fail(field.name, `unsupported scalar kind ${info.kind}`);
  }
}

/**
 * Decode a scalar wire value to its JavaScript form.
 */
function decodeScalar(field, wireValue, info) {
  switch (info.kind) {
    case 'uint':
    case 'int':
      return Number(wireValue);
    case 'uint64':
    case 'int64':
      return (typeof wireValue === 'bigint' ? wireValue : BigInt(wireValue)).toString();
    case 'float':
    case 'double':
      return typeof wireValue === 'number' ? wireValue : Number(wireValue);
    default:
      return fail(field.name, `unsupported scalar kind ${info.kind}`);
  }
}

/**
 * Encode a numeric array field. Elements are validated individually; a shorter
 * array is zero-padded to the declared length (standard fixed-array MAVLink
 * behaviour, distinct from the field-absence rule), and an over-long array is
 * an error rather than a silent truncation.
 */
function encodeArray(field, value, info, enumMeta) {
  if (!Array.isArray(value)) fail(field.name, 'value must be an array for an array-typed field');
  const n = field.arrayLength;
  if (value.length > n) fail(field.name, `array has ${value.length} elements but field holds ${n}`);
  const zero = is64BitKind(info.kind) ? BigInt(0) : 0;
  const out = [];
  for (let i = 0; i < n; i += 1) {
    if (i < value.length) {
      out.push(encodeScalar({ ...field, arrayLength: null }, value[i], info, enumMeta));
    } else {
      out.push(zero);
    }
  }
  return out;
}

/**
 * Encode a `char[n]` field: Latin-1, padded with NUL or truncated to exactly
 * `n` bytes. `''` is a valid empty string (unlike a blank numeric field). A
 * code point above 255 cannot be one Latin-1 byte and is rejected rather than
 * silently mangled.
 */
function encodeChar(field, value) {
  const n = field.arrayLength === null || field.arrayLength === undefined ? 1 : field.arrayLength;
  if (value === undefined || value === null) {
    fail(field.name, `value is ${value === null ? 'null' : 'undefined'}; a char field needs a string`);
  }
  if (typeof value !== 'string') fail(field.name, `expected a string, got ${typeof value}`);

  const truncated = value.length > n ? value.slice(0, n) : value;
  for (let i = 0; i < truncated.length; i += 1) {
    if (truncated.charCodeAt(i) > 255) {
      fail(field.name, `character ${JSON.stringify(truncated[i])} is not representable in Latin-1`);
    }
  }
  if (truncated.length === n) return truncated;
  return truncated + '\u0000'.repeat(n - truncated.length);
}

/**
 * Decode a `char[n]` field to a JavaScript string, stopping at the first NUL —
 * MAVLink strings are NUL-terminated and any bytes past the terminator are
 * padding. Accepts a `string` (from `node-mavlink`) or a raw `Buffer`.
 */
function decodeChar(field, wireValue) {
  let s;
  if (Buffer.isBuffer(wireValue)) s = wireValue.toString('latin1');
  else if (typeof wireValue === 'string') s = wireValue;
  else fail(field.name, `expected a string or Buffer, got ${typeof wireValue}`);
  const nul = s.indexOf('\u0000');
  return nul === -1 ? s : s.slice(0, nul);
}

module.exports = { encodeField, decodeField, assembleBitmask, decodeBitmask };
