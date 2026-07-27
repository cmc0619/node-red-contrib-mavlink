'use strict';

const { encodeField, decodeField } = require('./field');

/**
 * Message-level encode/decode: apply the field codec across every field of a
 * `Message` from the dialect bundle, keyed by field name.
 *
 * Blank, explicit `0`, and absent are three distinct states (DESIGN.md §5),
 * and the distinguishing mechanism is own-property presence:
 *   - **absent**  — the key is not an own property of the input; the field is
 *                   left out of the output rather than zero-filled.
 *   - **blank**   — the key is present with `''`/`null`/`undefined`; a numeric
 *                   field rejects it (a char field treats `''` as empty).
 *   - **zero**    — the key is present with `0`; it passes through untouched.
 *
 * @typedef {import('./field').Field} Field
 * @typedef {import('./field').Enum} Enum
 * @typedef {Object} Message
 * @property {string} name Message name (e.g. `HEARTBEAT`).
 * @property {Field[]} fields Fields in declaration order, extensions last.
 */

/**
 * Encode a plain object of JavaScript field values to wire-ready values.
 *
 * @param {Message} message The message metadata.
 * @param {Object<string, *>} values Field values keyed by field name.
 * @param {{enums?: Object<string, Enum>}} [options] Enum metadata for
 *   enum/bitmask fields, keyed by screaming enum name.
 * @returns {Object<string, *>} Wire-ready values keyed by field name; absent
 *   input fields are omitted.
 */
function encodeMessage(message, values, options) {
  const enums = options && options.enums;
  const out = {};
  for (const field of message.fields) {
    if (!Object.prototype.hasOwnProperty.call(values, field.name)) continue;
    const enumMeta = enums && field.enum ? enums[field.enum] : undefined;
    out[field.name] = encodeField(field, values[field.name], enumMeta);
  }
  return out;
}

/**
 * Decode a plain object of wire values back to JavaScript field values. Absent
 * fields are omitted; present fields are converted by {@link decodeField}.
 *
 * @param {Message} message The message metadata.
 * @param {Object<string, *>} wireValues Wire values keyed by field name.
 * @returns {Object<string, *>} JavaScript values keyed by field name.
 */
function decodeMessage(message, wireValues) {
  const out = {};
  for (const field of message.fields) {
    if (!Object.prototype.hasOwnProperty.call(wireValues, field.name)) continue;
    out[field.name] = decodeField(field, wireValues[field.name]);
  }
  return out;
}

module.exports = { encodeMessage, decodeMessage };
