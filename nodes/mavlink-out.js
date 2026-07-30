'use strict';

/**
 * mavlink-out — Outbound MAVLink transmitter (DESIGN.md §3, §9, §12 step 5).
 *
 * Enqueues a message onto the Connection's outbound band queue. Accepts three
 * input shapes on `msg.payload`:
 *
 *   1. `{ name, fields }` — decoded-shape message ready for the wire adapter.
 *      Fields must already be wire-ready values (as produced by the field codec
 *      or by the Build tier of `mavlink-build`).
 *
 *   2. A Build-tier envelope `{ message: { name, fields }, ... }` — the object
 *      emitted by `mavlink-build` on output 0 when the tier is Build. The node
 *      extracts the nested message and sends it.
 *
 *   3. Any other object with a `.name` string — passed as-is to the connection
 *      queue; interpretation is the wire adapter's. Useful for forwarding a
 *      decoded message from another connection without re-encoding.
 *
 * Queue band and identity come from the message (msg.band, msg.identityId) or
 * from the node configuration default.
 *
 * Chain model (§9):
 *   output 0  — continue: the original msg, fired once the message is accepted
 *                into the queue (fire-and-forget — this is not an ACK)
 *   output 1  — status:   a status record on every terminal outcome including
 *                success
 *
 * Suppression (§9):
 *   `msg.payload === false`   → silent suppress; neither output fires
 */

const { BAND } = require('../lib/connection');
const {
  makeStatusRecord,
  shouldSuppress,
  applyActionStatus,
  capBadge,
  reportDoneError,
} = require('../lib/delivery');

module.exports = function registerMavlinkOut(RED) {
  /**
   * @param {object} config  Node-RED node config from the editor
   */
  function MavlinkOutNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    const connectionNode = RED.nodes.getNode(config.connection);
    if (!connectionNode || typeof connectionNode.send !== 'function') {
      node.status({ fill: 'red', shape: 'ring', text: 'invalid config' });
      return;
    }

    // Default queue band: Control (2) for user-initiated sends.
    const defaultBand = config.band !== undefined && config.band !== null && config.band !== ''
      ? Number(config.band)
      : BAND.CONTROL;

    node.status({ fill: 'grey', shape: 'ring', text: '' });

    node.on('input', (msg, send, done) => {
      const emit = send || ((messages) => node.send(messages));
      // §9 suppress: msg.payload === false → silent no-op.
      if (shouldSuppress(msg)) {
        if (done) done();
        return;
      }

      const message = resolveMessage(msg);
      if (!message) {
        const sr = makeStatusRecord({
          result: 'failed',
          reason: 'unrecognised payload shape — expected { name, fields } or Build-tier envelope',
          timestamp: Date.now(),
        });
        applyActionStatus(node, 'error', 'bad payload');
        emit([null, sr]);
        reportDoneError(new Error('mavlink-out: unrecognised payload shape'), done);
        return;
      }

      const band = msg.band !== undefined ? Number(msg.band) : defaultBand;
      const target = msg.target || null;
      const identityId = msg.identityId || undefined;

      // The queue send can throw synchronously — a full Control band, an
      // unknown identity, a disabled connection. Route the failure through a
      // status record + the input handler's Catch path so it never escapes as
      // an uncaught throw (§2) and the chain halts (output 0 stays silent).
      try {
        connectionNode.send(message, { band, target, identityId });
      } catch (err) {
        const sr = makeStatusRecord({
          result: 'failed',
          reason: err.message,
          message: message.name,
          band,
          timestamp: Date.now(),
        });
        applyActionStatus(node, 'error', capBadge(err.message));
        emit([null, sr]);
        reportDoneError(new Error(`mavlink-out: ${err.message}`), done);
        return;
      }

      const sr = makeStatusRecord({
        result: 'sent',
        message: message.name,
        band,
        timestamp: Date.now(),
      });
      applyActionStatus(node, 'ok', capBadge(message.name));
      emit([msg, sr]);
      if (done) done();
    });

    node.on('close', (_done) => {
      _done();
    });
  }

  RED.nodes.registerType('mavlink-out', MavlinkOutNode);
};

/**
 * Extract the `{ name, fields }` message from the various accepted message
 * shapes. Returns null when the shape is not recognised.
 *
 * @param {object} msg  the inbound Node-RED message
 * @returns {{ name: string, fields: object }|null}
 */
function resolveMessage(msg) {
  const payload = msg && msg.payload;

  if (payload && typeof payload === 'object') {
    // Build-tier envelope: { message: { name, fields }, ... }
    if (
      payload.message &&
      typeof payload.message === 'object' &&
      typeof payload.message.name === 'string'
    ) {
      return payload.message;
    }

    // Decoded-shape: { name, fields }
    if (typeof payload.name === 'string') {
      return payload;
    }
  }

  // mavlink-in shape: the message name is in msg.topic and the decoded field
  // values are in msg.payload. Recognising this lets a direct In → Out flow
  // forward traffic across connections without a Function node in between.
  if (
    typeof msg.topic === 'string' &&
    msg.topic !== '' &&
    payload &&
    typeof payload === 'object' &&
    !Array.isArray(payload)
  ) {
    return { name: msg.topic, fields: payload };
  }

  return null;
}
