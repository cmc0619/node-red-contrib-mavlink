'use strict';

const { fail } = require('./errors');

/**
 * Bitmask assembly and decomposition, built entirely from powers of two — no
 * bitwise operators anywhere (DESIGN.md §5, enforced by `no-bitwise` over this
 * directory). JavaScript's `|`, `<<` and friends coerce to *signed* 32-bit, so
 * `1 << 31` is negative and `Buffer.writeUInt32LE` rejects it; MAV_MODE_FLAG
 * and type masks routinely set bit 31, so the operators are removed rather than
 * corrected. `mask + 2 ** bit` sets a bit and yields `2147483648` for bit 31 —
 * positive, exact, and accepted by `writeUInt32LE`.
 *
 * 32-bit masks are exact as `Number` (every 32-bit value is ≤ 2^53). 64-bit
 * masks use `BigInt`, whose arithmetic is exact and has no 32-bit coercion; the
 * value still leaves the codec as a decimal string.
 *
 * @typedef {import('./types')} _Types
 */

const ONE = 1;
const TWO = 2;

/**
 * Test whether a given bit index is set, by division and modulo rather than a
 * mask-and-compare. `Math.floor(mask / 2 ** bit) % 2 === 1` for `Number`;
 * the exact BigInt form for 64-bit.
 *
 * @param {number|bigint} mask Current mask.
 * @param {number} bit Zero-based bit index.
 * @param {boolean} use64 Whether `mask` is a `BigInt`.
 * @returns {boolean} True when the bit is set.
 */
function testBit(mask, bit, use64) {
  if (use64) {
    const divisor = BigInt(TWO) ** BigInt(bit);
    return (mask / divisor) % BigInt(TWO) === BigInt(ONE);
  }
  return Math.floor(mask / TWO ** bit) % TWO === ONE;
}

/**
 * Set a bit index, leaving it unchanged if already set. Adding `2 ** bit`
 * unconditionally would double-count a bit already present, so the guard keeps
 * the operation idempotent — a true OR, not a sum.
 *
 * @param {number|bigint} mask Current mask.
 * @param {number} bit Zero-based bit index.
 * @param {boolean} use64 Whether `mask` is a `BigInt`.
 * @returns {number|bigint} Mask with the bit set.
 */
function setBit(mask, bit, use64) {
  if (testBit(mask, bit, use64)) return mask;
  return mask + (use64 ? BigInt(TWO) ** BigInt(bit) : TWO ** bit);
}

/**
 * Enumerate the set bit indices of a whole mask value, low to high, without
 * bitwise operators. Used to OR one entry's (possibly multi-bit) value into an
 * accumulating mask and to decompose a mask back into named entries.
 *
 * @param {number|bigint} value A non-negative mask value.
 * @param {boolean} use64 Whether `value` is a `BigInt`.
 * @returns {number[]} Ascending bit indices that are set.
 */
function bitsOf(value, use64) {
  const bits = [];
  if (use64) {
    let remaining = value;
    let bit = 0;
    while (remaining > BigInt(0)) {
      if (remaining % BigInt(TWO) === BigInt(ONE)) bits.push(bit);
      remaining /= BigInt(TWO);
      bit += 1;
    }
    return bits;
  }
  let remaining = Math.trunc(value);
  let bit = 0;
  while (remaining > 0) {
    if (remaining % TWO === ONE) bits.push(bit);
    remaining = Math.floor(remaining / TWO);
    bit += 1;
  }
  return bits;
}

/**
 * Resolve one bitmask token to its numeric value. A token is either an entry
 * name (`MAV_MODE_FLAG_SAFETY_ARMED`), a numeric string, or a `Number`/`BigInt`.
 * Entry values may themselves be decimal strings when they exceed
 * `Number.MAX_SAFE_INTEGER`.
 *
 * @param {{entries:Array<{name:string,value:number|string}>}} enumMeta Enum metadata.
 * @param {string|number|bigint} token The token to resolve.
 * @param {string} fieldName Field name for error messages.
 * @param {boolean} use64 Whether to resolve as `BigInt`.
 * @returns {number|bigint} The token's mask value.
 */
function resolveToken(enumMeta, token, fieldName, use64) {
  if (typeof token === 'bigint') {
    if (token < 0n) fail(fieldName, `bitmask token ${token} is negative`);
    return use64 ? token : asSafeNumber(token, fieldName);
  }
  if (typeof token === 'number') {
    return use64 ? BigInt(asFiniteNonNegInt(token, fieldName)) : asFiniteNonNegInt(token, fieldName);
  }
  if (typeof token === 'string') {
    const s = token.trim();
    if (/^\+?\d+$/.test(s)) {
      // BigInt refuses an explicit '+', which scalar fields accept via Number.
      const big = BigInt(s[0] === '+' ? s.slice(1) : s);
      return use64 ? big : asSafeNumber(big, fieldName);
    }
    if (/^-\d+$/.test(s)) fail(fieldName, `bitmask token ${JSON.stringify(token)} is negative`);
    const entry = enumMeta && enumMeta.entries.find((e) => e.name === s);
    if (!entry) fail(fieldName, `unknown bitmask entry ${JSON.stringify(token)}`);
    if (use64) {
      const entryValue = BigInt(entry.value);
      if (entryValue < 0n) fail(fieldName, `bitmask entry ${entry.name} has a negative value`);
      return entryValue;
    }
    return asSafeNumber(BigInt(entry.value), fieldName);
  }
  fail(fieldName, `bitmask token must be a name, number, or numeric string; got ${typeof token}`);
  return undefined; // nothing matched: no behavior selected (§5)
}

/**
 * @param {number} n
 * @param {string} fieldName
 * @returns {number}
 */
function asFiniteNonNegInt(n, fieldName) {
  // Infinity would make bitsOf() loop forever; negatives/fractionals silently
  // collapse to the wrong mask.
  if (!Number.isFinite(n)) fail(fieldName, `bitmask value ${n} is not a finite number`);
  if (!Number.isInteger(n)) fail(fieldName, `bitmask value ${n} is not an integer`);
  if (n < 0) fail(fieldName, `bitmask value ${n} is negative`);
  return n;
}

/**
 * Coerce a non-negative BigInt to a Number for a ≤32-bit mask field. Rejects
 * values that become Infinity or lose integer precision.
 *
 * @param {bigint} big
 * @param {string} fieldName
 * @returns {number}
 */
function asSafeNumber(big, fieldName) {
  if (big < 0n) fail(fieldName, `bitmask value ${big} is negative`);
  if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail(fieldName, `bitmask value ${big} exceeds Number.MAX_SAFE_INTEGER; use a 64-bit field`);
  }
  return asFiniteNonNegInt(Number(big), fieldName);
}

/**
 * Assemble a bitmask from a list of entry names/values by OR-ing their mask
 * values. Duplicates and overlapping combined-flag entries are handled
 * correctly because each bit is set idempotently (see {@link setBit}). The
 * accumulator is `BigInt` when `use64` is set, so a bit-63 flag is exact.
 *
 * @param {{entries:Array<{name:string,value:number|string}>}} enumMeta Enum metadata.
 * @param {Array<string|number|bigint>} tokens Entry names/values to set.
 * @param {boolean} [use64=false] Assemble as a 64-bit `BigInt` mask.
 * @param {string} [fieldName='bitmask'] Field name for error messages.
 * @returns {number|bigint} The assembled mask (`Number` unless `use64`).
 */
function assembleBitmask(enumMeta, tokens, use64 = false, fieldName = 'bitmask') {
  if (!Array.isArray(tokens)) fail(fieldName, 'bitmask value must be an array of entry names or values');
  let mask = use64 ? BigInt(0) : 0;
  for (const token of tokens) {
    const value = resolveToken(enumMeta, token, fieldName, use64);
    for (const bit of bitsOf(value, use64)) {
      mask = setBit(mask, bit, use64);
    }
  }
  return mask;
}

/**
 * Lazy bit→name index of an enum's single-bit entries, split by width because
 * an entry value above 2^53 keeps its bits as `BigInt` but loses them as
 * `Number`. Keyed on the enum metadata object so a reloaded dialect indexes
 * fresh; first entry wins on a shared bit, matching the per-call build this
 * replaced.
 * @type {WeakMap<object, {32?: Map<number,string>, 64?: Map<number,string>}>}
 */
const bitIndexByEnum = new WeakMap();

/**
 * @param {{entries:Array<{name:string,value:number|string}>}} enumMeta Enum metadata.
 * @param {boolean} use64 Whether entry values are read as `BigInt`.
 * @returns {Map<number,string>} Bit index → single-bit entry name.
 */
function singleBitIndex(enumMeta, use64) {
  let byWidth = bitIndexByEnum.get(enumMeta);
  if (byWidth === undefined) {
    byWidth = {};
    bitIndexByEnum.set(enumMeta, byWidth);
  }
  const width = use64 ? 64 : 32;
  let byBit = byWidth[width];
  if (byBit === undefined) {
    byBit = new Map();
    for (const entry of enumMeta.entries) {
      const entryValue = use64 ? BigInt(entry.value) : Number(entry.value);
      const entryBits = bitsOf(entryValue, use64);
      if (entryBits.length === 1 && !byBit.has(entryBits[0])) byBit.set(entryBits[0], entry.name);
    }
    byWidth[width] = byBit;
  }
  return byBit;
}

/**
 * Decompose a mask into the names of the single-bit entries it sets. Bits with
 * no matching single-bit entry are reported in `unknownBits` so the round trip
 * is lossless and an unrecognised flag is never silently dropped.
 *
 * @param {{entries:Array<{name:string,value:number|string}>}} enumMeta Enum metadata.
 * @param {number|bigint|string} mask The mask to decompose.
 * @param {boolean} [use64=false] Treat `mask` as a 64-bit value.
 * @returns {{names:string[], unknownBits:number[], value:number|bigint}}
 *   Matched entry names, unmatched bit indices, and the normalized mask value.
 */
function decodeBitmask(enumMeta, mask, use64 = false) {
  const value = normalizeMask(mask, use64);
  const byBit = enumMeta ? singleBitIndex(enumMeta, use64) : new Map();
  const names = [];
  const unknownBits = [];
  for (const bit of bitsOf(value, use64)) {
    if (byBit.has(bit)) names.push(byBit.get(bit));
    else unknownBits.push(bit);
  }
  return { names, unknownBits, value };
}

/**
 * @param {number|bigint|string} mask Mask as produced on the wire.
 * @param {boolean} use64 Whether the field is 64-bit.
 * @returns {number|bigint} `BigInt` when `use64`, else `Number`.
 */
function normalizeMask(mask, use64) {
  if (use64) {
    if (typeof mask === 'bigint') {
      if (mask < 0n) fail('bitmask', `bitmask value ${mask} is negative`);
      return mask;
    }
    if (typeof mask === 'number') return BigInt(asFiniteNonNegInt(mask, 'bitmask'));
    if (typeof mask === 'string') {
      const s = mask.trim();
      if (!/^\d+$/.test(s)) fail('bitmask', `bitmask value ${JSON.stringify(mask)} is not a non-negative integer`);
      return BigInt(s);
    }
    fail('bitmask', `bitmask value must be a number, bigint, or numeric string; got ${typeof mask}`);
  }
  if (typeof mask === 'bigint') return asSafeNumber(mask, 'bitmask');
  if (typeof mask === 'number') return asFiniteNonNegInt(mask, 'bitmask');
  if (typeof mask === 'string') {
    const s = mask.trim();
    if (!/^\d+$/.test(s)) fail('bitmask', `bitmask value ${JSON.stringify(mask)} is not a non-negative integer`);
    return asSafeNumber(BigInt(s), 'bitmask');
  }
  fail('bitmask', `bitmask value must be a number, bigint, or numeric string; got ${typeof mask}`);
  return undefined; // nothing matched: no behavior selected (§5)
}

module.exports = { assembleBitmask, decodeBitmask };
