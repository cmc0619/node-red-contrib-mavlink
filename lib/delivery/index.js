'use strict';

/**
 * Shared delivery helpers (DESIGN.md §9 "chain model").
 *
 * Every action node follows the same two-output contract:
 *   output 0 — continue: fires only on success, carries the result
 *   output 1 — status:   fires on every terminal outcome as a plain object
 *
 * `msg.payload === false` suppresses an action node silently (§9).
 *
 * Public surface consumed by palette nodes:
 *   {@link makeStatusRecord} — build an output-1 status object
 *   {@link shouldSuppress}   — `msg.payload === false` rule
 *   {@link capBadge}         — truncate badge text to BADGE_MAX (§6)
 *   {@link applyActionStatus} — set an action-node status badge (§6)
 *   {@link reportDoneError}  — report an input error through one Catch path
 *   {@link TIER}             — delivery tier constants
 *   {@link BADGE_MAX}        — 24 characters, from §6
 */

/**
 * Delivery tier constants (DESIGN.md §9 "Delivery tiers"). The values are
 * stored in node config and compared at runtime; keep them stable strings.
 *
 * @enum {string}
 */
const TIER = {
  /** Construct and emit the message; do not send it. Output 0 carries the built
   *  message for inspection, fan-out, or forwarding to mavlink-out. Always
   *  available. */
  BUILD: 'build',
  /** Enqueue the message on the connection queue (fire-and-forget). Output 0
   *  carries the input message as a pass-through trigger. Available when a
   *  connection is configured. */
  SEND: 'send',
  /** Enqueue and wait for the protocol-level acknowledgement or echo. Output 0
   *  fires on a terminal positive result. Available when the message supports
   *  confirmation. */
  SEND_CONFIRM: 'sendConfirm',
  /** Enqueue and wait for vehicle state to satisfy the completion condition.
   *  Output 0 fires when state matches. Available for commands with a known
   *  completion condition. */
  SEND_AWAIT: 'sendAwait',
};

/**
 * Maximum badge text length (§6 "Cap badge text at 24 characters").
 * @type {number}
 */
const BADGE_MAX = 24;

/**
 * Truncate text to {@link BADGE_MAX} characters, replacing the last character
 * with a single-glyph ellipsis when the string exceeds the limit.
 *
 * @param {string} text
 * @returns {string}
 */
function capBadge(text) {
  if (typeof text !== 'string') text = String(text);
  if (text.length <= BADGE_MAX) return text;
  return text.slice(0, BADGE_MAX - 1) + '\u2026';
}

/**
 * Build a plain status record for output 1.
 *
 * @param {object} fields  result fields
 * @returns {object}
 */
function makeStatusRecord(fields) {
  return { ...fields };
}

/**
 * True when `msg.payload === false` (the explicit suppress sentinel of §9).
 * The node does nothing and emits nothing on suppression — it is not an error.
 *
 * @param {object} msg
 * @returns {boolean}
 */
function shouldSuppress(msg) {
  return msg.payload === false;
}

/**
 * Map an action-node situation to its §6 status badge and apply it.
 *
 * Action nodes report last activity (§6):
 *   - sending  → blue dot,   text ending in ellipsis
 *   - ok       → green dot,  name of what completed
 *   - preview  → yellow dot, count of built messages
 *   - error    → red ring,   failure description
 *   - invalid  → red ring,   shown before any message arrives when misconfigured
 *
 * @param {object} node  Node-RED node instance
 * @param {'sending'|'ok'|'preview'|'error'|'invalid'} situation
 * @param {string} text  badge text; capped at BADGE_MAX
 */
function applyActionStatus(node, situation, text) {
  const { fill, shape } = ACTION_BADGE_STYLES[situation] || ACTION_BADGE_STYLES.error;
  node.status({ fill, shape, text: capBadge(text) });
}

/**
 * Report an input-handler error through exactly one Node-RED Catch path.
 *
 * @param {object} node  Node-RED node instance
 * @param {Error} err
 * @param {object} msg
 * @param {Function|undefined} done
 */
function reportDoneError(node, err, msg, done) {
  if (typeof done === 'function') {
    done(err);
    return;
  }
  node.error(err, msg);
}

/** @type {Object<string, {fill: string, shape: string}>} */
const ACTION_BADGE_STYLES = {
  sending: { fill: 'blue', shape: 'dot' },
  ok: { fill: 'green', shape: 'dot' },
  preview: { fill: 'yellow', shape: 'dot' },
  error: { fill: 'red', shape: 'ring' },
  invalid: { fill: 'red', shape: 'ring' },
};

module.exports = {
  TIER,
  BADGE_MAX,
  makeStatusRecord,
  shouldSuppress,
  capBadge,
  applyActionStatus,
  reportDoneError,
};
