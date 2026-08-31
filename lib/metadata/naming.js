'use strict';

/**
 * Bitmask enum shape helpers for the metadata pipeline.
 *
 * Registry loads drop XML `display="bitmask"`; {@link isBitmaskEnum} re-derives
 * it from value shape.
 */

/**
 * True when a value is a uint32 with exactly one bit set. Computed by division
 * rather than bit tests so it never trips the codec's `no-bitwise` rule if the
 * helper is ever shared (§5 forbids bitwise there; this module is exempt but
 * stays arithmetic for one implementation of the idea).
 *
 * @param {*} v
 * @returns {boolean}
 */
function isSingleBit(v) {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isInteger(n) || n <= 0 || n > 0xffffffff) {
    return false;
  }
  let x = n;
  while (x % 2 === 0) {
    x /= 2;
  }
  return x === 1;
}

/**
 * Whether an enum's member values form an additive bitmask. MAVLink marks these
 * with `display="bitmask"` in XML, but the generated modules drop it, so for
 * registry loads it is re-derived from value shape: every non-zero member is a
 * single bit, and either there are at least three such flags or the enum name
 * declares the intent (`*_FLAG`/`*_FLAGS`/`*_MASK`/`*_TYPEMASK`). Below three
 * flags the shape alone is ambiguous (a tiny exclusive enum like `{0,1,2}`
 * matches by accident), so the name disambiguates.
 *
 * @param {Array<number|string>} values  enum member numeric values
 * @param {string} [name]  SCREAMING_SNAKE enum name
 * @returns {boolean}
 */
function isBitmaskEnum(values, name) {
  if (!Array.isArray(values)) {
    return false;
  }
  let flags = 0;
  for (const value of values) {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) {
      return false;
    }
    if (n === 0) {
      continue;
    }
    if (!isSingleBit(n)) {
      return false;
    }
    flags += 1;
  }
  if (flags >= 3) {
    return true;
  }
  return flags >= 1 && typeof name === 'string' && /_(FLAGS?|MASK|TYPEMASK)$/.test(name);
}

module.exports = {
  isBitmaskEnum,
};
