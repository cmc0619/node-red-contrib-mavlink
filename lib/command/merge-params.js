'use strict';

/**
 * Merge node-configured params with any override in msg.payload.
 *
 * Config stores params as a JSON string (JSON cannot carry bare NaN), so
 * string `"NaN"` is coerced with Number() to a real NaN sentinel. The editor
 * always saves valid JSON; a string that no longer parses throws. Payload
 * properties override configured properties before the command's 1–7 slots
 * are read by `buildParamArray`.
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
  return { ...JSON.parse(config.params), ...payload };
}

module.exports = { mergeParams };
