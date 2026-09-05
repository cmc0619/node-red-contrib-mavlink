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

const {
  makeStatusRecord,
  shouldSuppress,
  applyActionStatus,
  failInput,
} = require('../lib/delivery');

module.exports = function registerMavlinkOut(RED) {
  /**
   * @param {object} config  Node-RED node config from the editor
   */
  function MavlinkOutNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    const connectionNode = RED.nodes.getNode(config.connection);

    // The editor owns the default ('2' = Control) — just convert it.
    const defaultBand = Number(config.band);

    node.on('input', (msg, send, done) => {
      // §9 suppress: msg.payload === false → silent no-op.
      if (shouldSuppress(msg)) {
        done();
        return;
      }

      // Everything that can go wrong here — a missing Connection, a payload
      // shape the wire cannot carry, a queue send throwing on a full band or
      // unknown identity — exits through one terminal record plus done(err),
      // so the chain halts and a Catch node hears about it (§2, §9).
      try {
        // An unrecognised payload rides as given and craters in
        // connectionNode.send, whose serializer throws synchronously on a
        // non-message before anything is enqueued (§0).
        const message = resolveMessage(msg);
        // msg.band overrides the config default by presence and rides as
        // given — msg is trusted (§0); a band no queue case answers to
        // selects no behavior at the switch (§5).
        const band = msg.band === undefined ? defaultBand : msg.band;
        connectionNode.send(message, {
          band,
          target: msg.target,
          identityId: msg.identityId,
        });
        applyActionStatus(node, 'ok', message.name);
        send([msg, makeStatusRecord(node.type, {
          result: 'sent',
          message: message.name,
          band,
        })]);
        done();
      } catch (err) {
        failInput(node, send, err, done);
      }
    });
  }

  RED.nodes.registerType('mavlink-out', MavlinkOutNode);
};

/**
 * Extract the `{ name, fields }` message: `msg.payload.message` when present,
 * else `msg.topic` as the name over `msg.payload` as the fields, else
 * `msg.payload` itself.
 *
 * @param {object} msg  the inbound Node-RED message
 * @returns {{ name: string, fields: object }}
 */
function resolveMessage(msg) {
  if (msg.payload.message !== undefined) return msg.payload.message;
  if (msg.topic !== undefined) return { name: msg.topic, fields: msg.payload };
  return msg.payload;
}
