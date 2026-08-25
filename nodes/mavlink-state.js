'use strict';

const { createStateFeed, snapshotPeers } = require('../lib/state');
const { firstDefined, applyConnectionStatus, dialectFromConnection } = require('../lib/addressing');
const {
  makeStatusRecord,
  applyActionStatus,
  shouldSuppress,
  failInput,
} = require('../lib/delivery');

module.exports = function registerMavlinkState(RED) {
  function MavlinkStateNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const connectionNode = RED.nodes.getNode(config.connection);
    applyConnectionStatus(node, true, connectionNode);

    // Mode-name resolution context (lib/vehicle/modes.js): the bound profile's
    // firmware/family plus its compiled bundle. A disabled Connection carries
    // no vehicle snapshot — and an empty peer table that will never hold a
    // mode to name — so no context is built and outputs stay numbers-only.
    // An unresolvable Connection keeps its badge above and its per-input
    // failure path; this read must not turn it into a deploy crash.
    const vehicle = connectionNode && connectionNode.vehicle;
    const modes = vehicle && {
      firmware: vehicle.firmware,
      vehicleFamily: vehicle.vehicleFamily,
      bundle: dialectFromConnection(RED, connectionNode),
    };

    let feed = null;
    if (config.mode === 'feed') {
      // The editor saves events as a comma-joined string from a members-only
      // multi-select; an empty selection means the full default set.
      const events = config.events.split(',').map((s) => s.trim()).filter(Boolean);
      feed = createStateFeed(connectionNode.peerTable, { events, modes }, (record) => {
        node.send([{ payload: record }]);
      });
      node.status({ fill: 'grey', shape: 'ring', text: 'listening' });
    }

    node.on('input', (msg, send, done) => {
      try {
        if (shouldSuppress(msg)) {
          done();
          return;
        }
        if (config.mode === 'snapshot') {
          const payload = msg.payload ?? {};
          const peers = snapshotPeers(connectionNode.peerTable, {
            // Nullish-preserving: a configured 0 reaches the filter as 0 rather
            // than being swallowed by `||` and treated as unset.
            sysid: firstDefined(payload.sysid, config.targetSystem),
            compid: firstDefined(payload.compid, config.targetComponent),
          }, modes);
          applyActionStatus(node, 'ok', `${peers.length} peer(s)`);
          send([
            { payload: peers },
            makeStatusRecord(node.type, {
              result: 'succeeded',
              detail: 'snapshot',
              count: peers.length,
              // Frames whose CRC failed on a msgid the bound dialect carries:
              // corruption on the link, counted since deploy. A dialect
              // mismatch is not corruption — it arrives as an UNKNOWN_<id>
              // message and never lands here. Two snapshots apart give a rate.
              invalidPackets: connectionNode.invalidPacketCount(),
            }),
          ]);
        }
        done();
      } catch (err) {
        failInput(node, send, err, done);
      }
    });

    node.on('close', (done) => {
      if (feed) feed.close();
      done();
    });
  }

  RED.nodes.registerType('mavlink-state', MavlinkStateNode);
};
