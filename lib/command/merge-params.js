'use strict';

/**
 * Merge node-configured params with any override in msg.payload.
 *
 * Config stores params as a JSON string (JSON cannot carry bare NaN), so
 * string `"NaN"` is coerced with Number() to a real NaN sentinel. Payload
 * object keys 1–7 override the same way; explicit `undefined` values are
 * ignored so they cannot wipe a configured value into NaN.
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
    if (Number.isInteger(idx) && idx >= 1 && idx <= 7 && v !== undefined) {
      out[idx] = Number(v);
    }
  }

  if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
    for (const [k, v] of Object.entries(payload)) {
      const idx = Number(k);
      if (Number.isInteger(idx) && idx >= 1 && idx <= 7 && v !== undefined) {
        out[idx] = Number(v);
      }
    }
  }
  return out;
}

module.exports = { mergeParams };
