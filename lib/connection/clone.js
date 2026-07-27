'use strict';

/**
 * Structural deep copy for decoded MAVLink messages (DESIGN.md §7
 * "Subscriptions"). The Connection hands each subscriber its own copy, or one
 * Function node mutating a payload corrupts what every other subscriber sees.
 *
 * `JSON.parse(JSON.stringify(x))` is deliberately not used: a decoded float
 * field may be `NaN` (the "keep current" sentinel of §5), and JSON turns `NaN`
 * into `null`, silently changing the message's meaning. `structuredClone` is
 * not in the lint gate's declared globals. So the copy is done by hand over the
 * shapes a decoded message actually contains — plain objects, arrays, `Buffer`,
 * and primitives (numbers including `NaN`, strings, `BigInt`, booleans).
 *
 * @template T
 * @param {T} value
 * @returns {T} a copy sharing no mutable structure with `value`
 */
function deepCopy(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (Array.isArray(value)) return value.map(deepCopy);
  const out = {};
  for (const key of Object.keys(value)) {
    out[key] = deepCopy(value[key]);
  }
  return out;
}

module.exports = { deepCopy };
