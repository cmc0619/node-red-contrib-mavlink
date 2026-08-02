'use strict';

/**
 * Bitmask / false-true enum shape helpers for the metadata pipeline.
 *
 * Registry loads drop XML `display="bitmask"`; {@link isBitmaskEnum} re-derives
 * it from value shape. {@link isFalseTrueEnum} detects binary FALSE/TRUE pairs
 * for editor boolean controls (DESIGN.md §6).
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

/**
 * Whether enum entries are a binary false/true pair suitable for a boolean
 * control (DESIGN.md §6). Requires exactly two members: one named `FALSE` /
 * `*_FALSE` with value 0, and one named `TRUE` / `*_TRUE` with value 1.
 * Excludes mixed tables such as `GIMBAL_AXIS_CALIBRATION_REQUIRED` (UNKNOWN /
 * TRUE / FALSE with FALSE=2).
 *
 * @param {Array<{name: string, value: number|string}>|null|undefined} entries
 * @returns {boolean}
 */
function isFalseTrueEnum(entries) {
  if (!Array.isArray(entries) || entries.length !== 2) return false;
  let falseOk = false;
  let trueOk = false;
  for (const entry of entries) {
    // Require valued objects — never synthesize 0/1 for bare name strings.
    if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string') return false;
    const name = entry.name;
    const isFalse = name === 'FALSE' || name.endsWith('_FALSE');
    const isTrue = name === 'TRUE' || name.endsWith('_TRUE');
    if (!isFalse && !isTrue) return false;
    // Reject null/false/'' — Number(null)===0 would falsely match FALSE=0.
    const rawValue = entry.value;
    if (typeof rawValue !== 'number' && typeof rawValue !== 'string') return false;
    if (typeof rawValue === 'string' && rawValue.trim() === '') return false;
    const value = Number(rawValue);
    if (!Number.isInteger(value)) return false;
    if (isFalse) {
      if (value !== 0 || falseOk) return false;
      falseOk = true;
    } else {
      if (value !== 1 || trueOk) return false;
      trueOk = true;
    }
  }
  return falseOk && trueOk;
}

module.exports = {
  isBitmaskEnum,
  isFalseTrueEnum,
};
