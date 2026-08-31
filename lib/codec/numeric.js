'use strict';

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
function toInteger(_fieldName, value) {
  return Number(value);
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
function toBigInt(_fieldName, value) {
  return BigInt(value);
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
function toFloat(_fieldName, value) {
  return Number(value);
}

module.exports = { toInteger, toBigInt, toFloat };
