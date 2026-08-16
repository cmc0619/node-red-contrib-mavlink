'use strict';

const { fail } = require('./errors');

/**
 * Numeric coercion with the codec's central discipline: never coerce a missing
 * or non-numeric value (DESIGN.md §5). `undefined`, `null` and `''` reach
 * `Buffer.write*` as `0`; non-numeric strings reach it as `NaN`; non-integers
 * are silently *truncated* by `Buffer.writeUInt8(4.5) → 4`. All four are the
 * silent-wrong-byte class this module exists to make loud, so each is rejected
 * here with the field named rather than passed downstream.
 *
 * Blank (`''`), explicit `0`, and absent are three distinct states; this file
 * handles blank (reject) and zero (accept). Absent is a message-level concern
 * (see `message.js`) — a field key that is not present is left out entirely.
 */

const INT_STRING = /^[+-]?\d+$/;

/**
 * Coerce a present value to an integer `Number` for a ≤32-bit field.
 *
 * Accepts a finite integer `Number`, a `BigInt` (converted via `Number`), or a
 * decimal integer `string` (`/^[+-]?\d+$/`, whitespace trimmed). Rejects
 * `undefined`, `null`, `''`, whitespace-only and non-numeric strings,
 * `NaN`/`Infinity`, non-integers, and any other type. Type-width overflow is
 * left to `Buffer` (DESIGN.md §14) — an oversized `BigInt` is already far past
 * every ≤32-bit width, so the write throws `ERR_OUT_OF_RANGE` loudly; a
 * declared `minValue`/`maxValue` narrower than the type is enforced here —
 * report, never wrap.
 *
 * @param {string} fieldName Field name for error messages.
 * @param {*} value The value to convert.
 * @param {{minValue?:number|null, maxValue?:number|null}} [bounds] Declared range.
 * @returns {number} Integer suitable for `Buffer.writeInt*`/`writeUInt*`.
 */
function toInteger(fieldName, value, bounds) {
  let n;
  if (typeof value === 'number') {
    n = value;
  } else if (typeof value === 'string') {
    const s = value.trim();
    if (s === '') fail(fieldName, 'value is blank; an active integer field needs a number');
    if (!INT_STRING.test(s)) fail(fieldName, `non-integer value ${JSON.stringify(value)}`);
    n = Number(s);
  } else if (value === undefined || value === null) {
    fail(fieldName, `value is ${value === null ? 'null' : 'undefined'}; would silently encode as 0`);
  } else if (typeof value === 'bigint') {
    n = Number(value);
  } else {
    fail(fieldName, `expected a number, got ${typeof value}`);
  }
  if (!Number.isFinite(n)) fail(fieldName, `value is ${n}; not a finite integer`);
  if (!Number.isInteger(n)) fail(fieldName, `non-integer value ${n}; Buffer would truncate it`);
  checkBounds(fieldName, n, bounds);
  return n;
}

/**
 * Coerce a present value to a `BigInt` for a 64-bit integer field. The JS side
 * carries 64-bit integers as decimal strings because a `Number` loses exactness
 * above 2^53; a `Number` is therefore accepted only when it is a safe integer.
 * A `Number` handed to `Buffer.writeBigUInt64LE` throws ("cannot mix BigInt"),
 * so converting here is the codec's job. Type-width overflow is left to `Buffer`.
 *
 * @param {string} fieldName Field name for error messages.
 * @param {*} value Decimal `string`, safe-integer `Number`, or `BigInt`.
 * @param {{minValue?:number|null, maxValue?:number|null}} [bounds] Declared range.
 * @returns {bigint} Value suitable for `Buffer.writeBigInt64LE`/`writeBigUInt64LE`.
 */
function toBigInt(fieldName, value, bounds) {
  let b;
  if (typeof value === 'bigint') {
    b = value;
  } else if (typeof value === 'string') {
    const s = value.trim();
    if (s === '') fail(fieldName, 'value is blank; an active 64-bit field needs a number');
    if (!INT_STRING.test(s)) fail(fieldName, `non-integer value ${JSON.stringify(value)}`);
    b = BigInt(s);
  } else if (typeof value === 'number') {
    if (!Number.isInteger(value)) fail(fieldName, `non-integer value ${value}`);
    if (!Number.isSafeInteger(value)) {
      fail(fieldName, 'unsafe 64-bit Number; pass 64-bit integers as decimal strings');
    }
    b = BigInt(value);
  } else if (value === undefined || value === null) {
    fail(fieldName, `value is ${value === null ? 'null' : 'undefined'}; would silently encode as 0`);
  } else {
    fail(fieldName, `expected a decimal string or integer, got ${typeof value}`);
  }
  if (bounds) {
    const { minValue, maxValue } = bounds;
    if (minValue !== undefined && minValue !== null && b < BigInt(minValue)) {
      fail(fieldName, `value ${b} is below declared minimum ${minValue}`);
    }
    if (maxValue !== undefined && maxValue !== null && b > BigInt(maxValue)) {
      fail(fieldName, `value ${b} is above declared maximum ${maxValue}`);
    }
  }
  return b;
}

/**
 * Coerce a present value to a float `Number`. Floats are never range-checked
 * (DESIGN.md §5) — the vehicle clamps or rejects — so any finite value,
 * `Infinity`, and `NaN` all pass. `NaN` survives losslessly and is meaningful:
 * in a field whose metadata declares `invalid="NaN"` it means "keep current".
 * Rejects `undefined`, `null`, `''`, and genuinely non-numeric strings, which
 * would otherwise reach `Buffer.writeFloatLE` as a silent `0` or `NaN`.
 *
 * @param {string} fieldName Field name for error messages.
 * @param {*} value Finite `Number`, `NaN`, `Infinity`, or numeric/`'NaN'` string.
 * @returns {number} Value suitable for `Buffer.writeFloatLE`/`writeDoubleLE`.
 */
function toFloat(fieldName, value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const s = value.trim();
    if (s === '') fail(fieldName, 'value is blank; an active float field needs a number');
    if (s.toLowerCase() === 'nan') return NaN;
    const n = Number(s);
    if (Number.isNaN(n)) fail(fieldName, `non-numeric value ${JSON.stringify(value)}; would silently encode as NaN`);
    return n;
  }
  if (value === undefined || value === null) {
    fail(fieldName, `value is ${value === null ? 'null' : 'undefined'}; would silently encode as 0`);
  }
  fail(fieldName, `expected a number, got ${typeof value}`);
  return NaN; // nothing matched: no behavior selected (§5)
}

/**
 * Enforce a declared numeric range for integer fields. A `minValue`/`maxValue`
 * narrower than the type width is authoritative; a value outside it is an error
 * rather than something to clamp.
 *
 * @param {string} fieldName Field name for error messages.
 * @param {number} n Value already known to be a finite integer.
 * @param {{minValue?:number|null, maxValue?:number|null}} [bounds] Declared range.
 */
function checkBounds(fieldName, n, bounds) {
  if (!bounds) return;
  const { minValue, maxValue } = bounds;
  if (minValue !== undefined && minValue !== null && n < minValue) {
    fail(fieldName, `value ${n} is below declared minimum ${minValue}`);
  }
  if (maxValue !== undefined && maxValue !== null && n > maxValue) {
    fail(fieldName, `value ${n} is above declared maximum ${maxValue}`);
  }
}

module.exports = { toInteger, toBigInt, toFloat };
