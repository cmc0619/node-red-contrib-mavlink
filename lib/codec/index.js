'use strict';

/**
 * The field codec (DESIGN.md §5): the one conversion path between JavaScript
 * values and MAVLink field values, driven by compiled dialect metadata passed
 * as an argument. It imports nothing above itself — no `node-mavlink`, no
 * `lib/metadata`, nothing Node-RED — so it stays independently testable and
 * extractable (its own directory, tests, and README).
 *
 * Public surface:
 *   - {@link encodeField}/{@link decodeField}   — one field, both directions
 *   - {@link encodeMessage}/{@link decodeMessage} — a whole message by name
 *   - {@link assembleBitmask}/{@link decodeBitmask} — bitmask ⇄ entry names
 *   - {@link paramValueToWire}/{@link paramValueFromWire} — PX4 int/float union
 *   - {@link FieldCodecError} — thrown on rejected input, naming the field
 */

const { encodeField, decodeField } = require('./field');
const { encodeMessage, decodeMessage } = require('./message');
const { assembleBitmask, decodeBitmask } = require('./mask');
const { paramValueToWire, paramValueFromWire, PARAM_TYPES } = require('./param-union');
const { FieldCodecError } = require('./errors');
const { TYPE_INFO } = require('./types');

module.exports = {
  encodeField,
  decodeField,
  encodeMessage,
  decodeMessage,
  assembleBitmask,
  decodeBitmask,
  paramValueToWire,
  paramValueFromWire,
  PARAM_TYPES,
  TYPE_INFO,
  FieldCodecError,
};
