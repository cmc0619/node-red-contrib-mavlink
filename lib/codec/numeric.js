'use strict';

/**
 * Convert a value to `Number`; the downstream wire writer owns its accepted
 * representation and range.
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
 * Convert a value to `BigInt` for a 64-bit integer field. The JS side carries
 * 64-bit integers as decimal strings, and the downstream wire writer owns its
 * accepted range.
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
 * Convert a value to a float `Number`; the downstream wire writer owns its
 * accepted representation.
 *
 * @param {string} fieldName Field name for error messages.
 * @param {*} value Finite `Number`, `NaN`, `Infinity`, or numeric/`'NaN'` string.
 * @returns {number} Value suitable for `Buffer.writeFloatLE`/`writeDoubleLE`.
 */
function toFloat(_fieldName, value) {
  return Number(value);
}

module.exports = { toInteger, toBigInt, toFloat };
