'use strict';

/**
 * Merge node-configured params with any override in msg.payload.
 *
 * Config stores params as a JSON string (JSON cannot carry bare NaN), so
 * string `"NaN"` is coerced with Number() to a real NaN sentinel. Payload
 * object keys 1–7 override the same way; explicit `undefined` values are
 * ignored so they cannot wipe a configured value into NaN.
 *
 * A blank or whitespace-only value is *absent*, not zero. `Number('')` is 0,
 * and 0 is a legal coordinate — silently coercing an empty override is how a
 * Go To ends up flying to the Gulf of Guinea (§9, §10). Absent instead falls
 * through to the configured value or the preset's own default.
 *
 * @param {object} config
 * @param {*} payload
 * @returns {Object<number, number>}  index (1–7) → value
 */
function mergeParams(config, payload) {
  const out = {};
  let raw = {};
  try {
    if (config && config.params) raw = JSON.parse(config.params);
  } catch { /* invalid saved JSON → start from empty */ }

  for (const [k, v] of Object.entries(raw)) {
    const idx = Number(k);
    if (Number.isInteger(idx) && idx >= 1 && idx <= 7 && !isBlank(v)) {
      out[idx] = Number(v);
    }
  }

  if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
    for (const [k, v] of Object.entries(payload)) {
      const idx = Number(k);
      if (Number.isInteger(idx) && idx >= 1 && idx <= 7 && !isBlank(v)) {
        out[idx] = Number(v);
      }
    }
  }
  return out;
}

/**
 * Blank as an operator means it: undefined, null, or a string with nothing in
 * it but whitespace. Everything else — including an explicit 0 — is a value.
 *
 * @param {*} value
 * @returns {boolean}
 */
function isBlank(value) {
  if (value === undefined || value === null) return true;
  return typeof value === 'string' && value.trim() === '';
}

module.exports = { mergeParams };
