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
 *   {@link inFlightTracker}  — abort-on-close discipline for long runs
 *   {@link BADGE_MAX}        — 24 characters, from §6
 */

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
  if (text.length <= BADGE_MAX) return text;
  return `${text.slice(0, BADGE_MAX - 1)  }\u2026`;
}

/**
 * Build a plain status record for output 1. The one owner of the record's
 * `node` field (§9): every palette node's success and failure records — the
 * public two-output contract — carry the emitting node's registered type,
 * stamped here and nowhere else.
 *
 * @param {string} nodeType  the emitting node's registered type (`node.type`)
 * @param {object} fields  result fields
 * @returns {object}
 */
function makeStatusRecord(nodeType, fields) {
  // fields spread first: the stamp is authoritative even against a stray
  // `fields.node` (e.g. a record rebuilt from another record's fields).
  return { ...fields, node: nodeType };
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
 *
 * @param {object} node  Node-RED node instance
 * @param {'sending'|'ok'|'preview'|'error'} situation
 * @param {string} text  badge text; capped at BADGE_MAX
 */
function applyActionStatus(node, situation, text) {
  const { fill, shape } = ACTION_BADGE_STYLES[situation];
  node.status({ fill, shape, text: capBadge(text) });
}

/**
 * Terminal failure for one input: badge, `[null, record]` on the two-output
 * chain, and one done(err) for Catch. The record's `node` comes from the
 * registered type, so every action node fails in the same shape without a
 * per-node wrapper.
 *
 * @param {object} node  Node-RED node instance
 * @param {Function} send  the input handler's send
 * @param {Error} err
 * @param {Function} done  the input handler's done
 */
function failInput(node, send, err, done) {
  applyActionStatus(node, 'error', err.message);
  send([null, makeStatusRecord(node.type, { result: 'failed', detail: err.message })]);
  done(err);
}

/**
 * Track every run an action node has in flight, so `close` can abort all of
 * them and wait for each to unwind. Node-RED's close does not abort a running
 * promise chain: without this, a redeploy leaves a member loop sending live
 * vehicle commands from a node that no longer exists.
 *
 * A set rather than a single slot, because Node-RED does not serialise async
 * input handlers — two messages arriving close together re-enter and run
 * concurrently. One slot would let `close` cancel only the newest run and
 * return as soon as it settled, leaving the older one alive.
 *
 * `close(done)` waits for every aborted run to settle before calling `done`:
 * reporting closed immediately would let the tail of a cancelled run emit onto
 * a node Node-RED has already torn down.
 *
 * @returns {{track: function(function(AbortSignal): Promise<*>): Promise<*>,
 *            close: function(function(): void): void}}
 */
function inFlightTracker() {
  const inFlight = new Set();
  return {
    async track(start) {
      const controller = new AbortController();
      const entry = { controller, run: start(controller.signal) };
      inFlight.add(entry);
      try {
        return await entry.run;
      } finally {
        inFlight.delete(entry);
      }
    },
    close(done) {
      if (inFlight.size === 0) {
        done();
        return;
      }
      const running = [...inFlight];
      for (const entry of running) entry.controller.abort();
      Promise.allSettled(running.map((entry) => entry.run)).then(() => done());
    },
  };
}

/** @type {Object<string, {fill: string, shape: string}>} */
const ACTION_BADGE_STYLES = {
  sending: { fill: 'blue', shape: 'dot' },
  ok: { fill: 'green', shape: 'dot' },
  preview: { fill: 'yellow', shape: 'dot' },
  error: { fill: 'red', shape: 'ring' },
};

module.exports = {
    makeStatusRecord,
  shouldSuppress,
  capBadge,
  applyActionStatus,
  failInput,
  inFlightTracker,
};
