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
 *                success; also fires when the input is suppressed or refused
 *
 * Suppression and miswire (§9):
 *   `msg.payload === false`   → silent suppress; neither output fires
 *   input is a status record  → refuse; output 1 fires, node.error() is called
 */

const { BAND } = require('../lib/connection');
const {
  makeStatusRecord,
  shouldSuppress,
  refuseIfStatus,
  applyActionStatus,
  capBadge,
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

    node.on('input', (msg) => {
      // §9 suppress: msg.payload === false → silent no-op.
      if (shouldSuppress(msg)) return;

      // §9 refuse: a status record fed into an action node is a miswire.
      const refusal = refuseIfStatus(msg);
      if (refusal) {
        node.error('mavlink-out: status record received as input — check wiring', msg);
        node.send([null, refusal]);
        return;
      }

      const message = resolveMessage(msg.payload);
      if (!message) {
        const sr = makeStatusRecord({
          result: 'failed',
          reason: 'unrecognised payload shape — expected { name, fields } or Build-tier envelope',
          timestamp: Date.now(),
        });
        applyActionStatus(node, 'error', 'bad payload');
        node.error('mavlink-out: unrecognised payload shape', msg);
        node.send([null, sr]);
        return;
      }

      const band = msg.band !== undefined ? Number(msg.band) : defaultBand;
      const target = msg.target || null;
      const identityId = msg.identityId || undefined;

      connectionNode.send(message, { band, target, identityId });

      const sr = makeStatusRecord({
        result: 'sent',
        message: message.name,
        band,
        timestamp: Date.now(),
      });
      applyActionStatus(node, 'ok', capBadge(message.name));
      node.send([msg, sr]);
    });

    node.on('close', (_done) => {
      _done();
    });
  }

  RED.nodes.registerType('mavlink-out', MavlinkOutNode);
};

/**
 * Extract the `{ name, fields }` message from the various accepted payload
 * shapes. Returns null when the shape is not recognised.
 *
 * @param {*} payload
 * @returns {{ name: string, fields: object }|null}
 */
function resolveMessage(payload) {
  if (!payload || typeof payload !== 'object') return null;

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

  return null;
}
