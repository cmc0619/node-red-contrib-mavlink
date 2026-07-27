'use strict';

/**
 * Error raised when a field value cannot be converted to (or from) its MAVLink
 * wire form. Always names the offending field so a caller — and the Node-RED
 * debug pane — can locate the mistake without a stack dive.
 *
 * @property {string} field The XML/wire field name (e.g. `custom_mode`).
 */
class FieldCodecError extends Error {
  /**
   * @param {string} field Field name to blame.
   * @param {string} reason Human-readable reason, appended after the name.
   */
  constructor(field, reason) {
    super(`${field}: ${reason}`);
    this.name = 'FieldCodecError';
    this.field = field;
  }
}

/**
 * Throw a {@link FieldCodecError}. A function rather than an inline `throw` so
 * call sites read as a single expression and every rejection routes through
 * one place.
 *
 * @param {string} field Field name to blame.
 * @param {string} reason Reason text.
 * @returns {never}
 */
function fail(field, reason) {
  throw new FieldCodecError(field, reason);
}

module.exports = { FieldCodecError, fail };
