'use strict';

/**
 * Shared delivery helpers (DESIGN.md §9 "chain model").
 *
 * Every action node follows the same two-output contract:
 *   output 0 — continue: fires only on success, carries the result
 *   output 1 — status:   fires on every terminal outcome (success or failure)
 *
 * This module provides the marker and helpers that enforce the chain rules:
 *   - `msg.payload === false`  suppresses an action node silently (§9)
 *   - a status record fed back into an action node is refused, not executed,
 *     because both ports look identical on the canvas and the mistake is worth
 *     engineering against (§9 "A status record is refused")
 *
 * Public surface consumed by palette nodes:
 *   {@link isStatusRecord}   — detect the marker
 *   {@link makeStatusRecord} — attach the marker
 *   {@link shouldSuppress}   — `msg.payload === false` rule
 *   {@link refuseIfStatus}   — refuse a miswired status record input
 *   {@link capBadge}         — truncate badge text to BADGE_MAX (§6)
 *   {@link applyActionStatus} — set an action-node status badge (§6)
 *   {@link TIER}             — delivery tier constants
 *   {@link BADGE_MAX}        — 24 characters, from §6
 */

/**
 * Property key stamped on every status record. Using a plain string rather than
 * a Symbol preserves detectability through message serialisation and across
 * `deepCopy` (which copies own properties), so the marker survives the
 * SubscriptionRegistry's copy-per-subscriber path.
 *
 * @type {string}
 */
const STATUS_RECORD_MARKER = '__mavlinkStatusRecord__';

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
 * @param {*} msg
 * @returns {boolean} true when `msg` carries the status record marker
 */
function isStatusRecord(msg) {
  return msg !== null && typeof msg === 'object' && msg[STATUS_RECORD_MARKER] === true;
}

/**
 * Build a status record. The marker is set so {@link isStatusRecord} recognises
 * it and action nodes refuse to treat it as a trigger (§9).
 *
 * @param {object} fields  result fields; augmented with the marker
 * @returns {object}
 */
function makeStatusRecord(fields) {
  return { [STATUS_RECORD_MARKER]: true, ...fields };
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
 * When `msg` is a status record (a miswire — output 1 fed into an action
 * node's input), return a refusal status record naming the problem. When `msg`
 * is a normal message, return null and let the node proceed.
 *
 * The refusal fires output 1 and calls `node.error()`; the caller must not
 * execute the action. Both ports look identical on the canvas (§9) so this is
 * the mistake worth engineering against.
 *
 * @param {object} msg
 * @returns {object|null}
 */
function refuseIfStatus(msg) {
  if (!isStatusRecord(msg)) return null;
  return makeStatusRecord({
    result: 'refused',
    reason: 'status record received as action trigger — check node wiring (output 1 must not feed input)',
    timestamp: Date.now(),
  });
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

/** @type {Object<string, {fill: string, shape: string}>} */
const ACTION_BADGE_STYLES = {
  sending: { fill: 'blue', shape: 'dot' },
  ok: { fill: 'green', shape: 'dot' },
  preview: { fill: 'yellow', shape: 'dot' },
  error: { fill: 'red', shape: 'ring' },
  invalid: { fill: 'red', shape: 'ring' },
};

module.exports = {
  STATUS_RECORD_MARKER,
  TIER,
  BADGE_MAX,
  isStatusRecord,
  makeStatusRecord,
  shouldSuppress,
  refuseIfStatus,
  capBadge,
  applyActionStatus,
};
