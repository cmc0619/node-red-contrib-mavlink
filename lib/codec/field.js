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
    const sentinel = degE7Sentinel(field);
    if (sentinel !== null && (resolved === null || resolved === undefined)) {
      // A degE7 field whose dialect declares an out-of-range invalid marker
      // (e.g. ADSB_VEHICLE.lat: INT32_MAX) has a wire word for "no value";
      // an explicit null/undefined encodes it. This is the one carve-out
      // from the blank-rejects rule (DESIGN.md §5): here blank is not a
      // missing value but a declared one.
      resolved = sentinel;
    } else {
      resolved = degreesToDegE7(field.name, resolved);
    }
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
      if (!isDegE7(field)) return n;
      const sentinel = degE7Sentinel(field);
      if (sentinel !== null && n === sentinel) return null;
      return n / 1e7;
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

/** int32 bounds — the wire width every degE7 field uses. */
const INT32_MAX = 2147483647;
const INT32_MIN = -2147483648;

/**
 * @param {Field} field
 * @returns {boolean}
 */
function isDegE7(field) {
  return field && typeof field.units === 'string' && field.units.toLowerCase() === 'dege7';
}

/**
 * Convert a JS degrees value to a degE7 integer: × 10⁷, rounded — always.
 *
 * The input is degrees, period. There is deliberately no "integer means
 * already-wire-scaled" pass-through and no magnitude heuristic: every mature
 * MAVLink encoder (MAVSDK, QGroundControl, pymavlink call sites, ArduPilot's
 * COMMAND_LONG converter) scales unconditionally and decides *whether* to
 * scale from static schema, never from the value. A value-inspecting rule
 * silently mis-encodes whole-number degrees (`lat: -35` became −0.0000035°)
 * — the exact bug class this function must not reintroduce. A caller holding
 * a raw wire integer divides by 1e7 first; one holding a declared-invalid
 * sentinel passes `null` (see the encodeScalar carve-out).
 *
 * @param {string} fieldName
 * @param {*} value
 * @returns {number}
 */
function degreesToDegE7(fieldName, value) {
  let n;
  if (typeof value === 'number') {
    n = value;
  } else if (typeof value === 'bigint') {
    n = Number(value);
  } else if (typeof value === 'string') {
    const s = value.trim();
    if (s === '') fail(fieldName, 'degE7 value is blank');
    n = Number(s);
  } else {
    fail(fieldName, `expected degrees, got ${value === null ? 'null' : typeof value}`);
  }
  // String(), not JSON.stringify(): the latter renders NaN and the infinities
  // as "null" and throws outright on a BigInt, so the message meant to name the
  // bad input would either misreport it or replace this error with a TypeError.
  if (!Number.isFinite(n)) fail(fieldName, `degE7 value ${String(value)} is not a finite number of degrees`);
  const scaled = Math.round(n * 1e7);
  // Fit, not semantics. §5: "Only integers need fit checking, and only because
  // they cannot be encoded without it" — a coordinate outside ±180° is invalid
  // but encodable, and the vehicle rejects it (ArduPilot's check_latlng). A
  // *semantic* ±180 bound here would reject the legitimate re-encode of a
  // decoded out-of-range sentinel: CAMERA_FOV_STATUS.lat_image carries
  // INT32_MIN for "at infinity, not intersecting the horizon", which decodes
  // to −214.7483648° and must scale back to INT32_MIN unchanged. Checking the
  // wire width instead keeps that round trip exact while still catching the
  // real mistake — a raw degE7 integer handed in as degrees — immediately and
  // with the fix named, rather than as a late Buffer range error.
  if (!Number.isSafeInteger(scaled) || scaled < INT32_MIN || scaled > INT32_MAX) {
    fail(
      fieldName,
      `${n}° does not fit the degE7 int32 range — a raw degE7 wire value must be divided by 1e7 first`
    );
  }
  return scaled;
}

/**
 * Numeric sentinel for a degE7 field whose dialect declares an invalid
 * marker that lies *outside* the legal coordinate space — today that is
 * exactly `INT32_MAX` (214.7483647° can never be a real lat/lon). Only such
 * markers get null↔sentinel codec support: mapping is then lossless in both
 * directions. An in-range marker like SIM_STATE's `invalid: 0` stays
 * untouched — 0° is a legal coordinate, and nulling it would destroy
 * information (the mistake QGC/MAVSDK avoid by not sentinel-decoding
 * coordinates at all; declared out-of-range markers are the safe subset).
 *
 * @param {Field} field
 * @returns {number|null}
 */
function degE7Sentinel(field) {
  return field && field.invalid === 'INT32_MAX' ? INT32_MAX : null;
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
