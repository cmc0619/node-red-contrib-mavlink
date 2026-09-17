'use strict';

const { isBlank } = require('../addressing/resolve');

/**
 * Merge node-configured params with any override in msg.payload.
 *
 * Config stores params as a JSON string (JSON cannot carry bare NaN), so
 * string `"NaN"` is coerced with Number() to a real NaN sentinel. The node
 * parses that string once at construction; this merge reads it and never
 * writes to it, so payload overrides cannot leak into the next message.
 * Payload properties override configured properties before the command's
 * 1–7 slots are read by `buildParamArray`.
 *
 * A blank or whitespace-only value is *absent*, not zero. `Number('')` is 0,
 * and 0 is a legal coordinate — silently coercing an empty override is how a
 * Go To ends up flying to the Gulf of Guinea (§9, §10). Absent instead falls
 * through to the configured value or the preset's own default.
 *
 * @param {object} configParams  the node's parsed `config.params`
 * @param {object} payload  msg.payload — its enumerable keys are the overrides
 * @returns {Object<number, number>}  index (1–7) → value
 */
function mergeParams(configParams, payload) {
  const out = {};
  for (const source of [configParams, payload]) {
    for (const [key, value] of Object.entries(source)) {
      if (!isBlank(value)) out[Number(key)] = Number(value);
    }
  }
  return out;
}

module.exports = { mergeParams };
