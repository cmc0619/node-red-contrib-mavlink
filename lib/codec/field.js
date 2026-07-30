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
    // Arrays assemble bitmasks only for declared bitmask enums — a plain enum
    // scalar given ['A','B'] must not silently OR entry values together.
    if (!enumMeta || !enumMeta.bitmask) {
      fail(field.name, 'array value given for a non-bitmask field');
    }
    return assembleBitmask(enumMeta, value, use64, field.name);
  }

  let resolved = value;
  if (enumMeta && typeof value === 'string' && !/^[+-]?\d+(\.\d+)?$/.test(value.trim()) && value.trim().toLowerCase() !== 'nan') {
    const entry = enumMeta.entries.find((e) => e.name === value.trim());
    if (!entry) fail(field.name, `unknown ${field.enum} entry ${JSON.stringify(value)}`);
    resolved = entry.value;
  }

  // Wire lat/lon are degE7 integers (DESIGN.md §9); JS/UI speak degrees.
  if (isDegE7(field) && (info.kind === 'int' || info.kind === 'uint')) {
    resolved = degreesToDegE7(field.name, resolved);
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
    case 'int': {
      const n = Number(wireValue);
      return isDegE7(field) ? n / 1e7 : n;
    }
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
 * @param {Field} field
 * @returns {boolean}
 */
function isDegE7(field) {
  return field && typeof field.units === 'string' && field.units.toLowerCase() === 'dege7';
}

/**
 * Convert a JS degrees value to a degE7 integer (degrees × 10⁷, rounded).
 *
 * Every `Number`/`string` input is degrees, **including a whole number**: an
 * operator entering a latitude of 47 or -35 means 47° / -35°, never a raw wire
 * value. Reading integers as "already scaled" puts such a point at 47e-7° —
 * seven orders of magnitude off (§9 "Coordinate frames", and the same rule in
 * `lib/move`). A caller that already holds the wire integer must not route it
 * through this field codec.
 *
 * @param {string} fieldName
 * @param {*} value
 * @returns {number}
 */
function degreesToDegE7(fieldName, value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(fieldName, `degE7 value ${value} is not finite`);
    return Math.round(value * 1e7);
  }
  if (typeof value === 'string') {
    const s = value.trim();
    if (s === '') fail(fieldName, 'degE7 value is blank');
    const n = Number(s);
    if (!Number.isFinite(n)) fail(fieldName, `non-numeric degE7 value ${JSON.stringify(value)}`);
    return Math.round(n * 1e7);
  }
  if (typeof value === 'bigint') {
    // A BigInt cannot express fractional degrees, so it can only have come from
    // code that already holds the wire integer — pass it through.
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      fail(fieldName, 'degE7 BigInt exceeds safe integer range');
    }
    return Number(value);
  }
  fail(fieldName, `expected degrees, got ${typeof value}`);
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
