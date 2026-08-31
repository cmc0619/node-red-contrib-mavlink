'use strict';

const { createStateFeed, snapshotPeers } = require('../lib/state');
const { firstDefined, dialectFromConnection } = require('../lib/addressing');
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

    // Mode-name resolution context (lib/vehicle/modes.js): the bound profile's
    // firmware/family plus its compiled bundle. A disabled Connection carries
    // no vehicle snapshot — and an empty peer table that will never hold a
    // mode to name — so no context is built and outputs stay numbers-only.
    // An unresolvable Connection craters on first use instead — the feed
    // subscribe below at deploy, or per input in poll mode (§0).
    const vehicle = connectionNode && connectionNode.vehicle;
    const modes = vehicle && {
      firmware: vehicle.firmware,
      vehicleFamily: vehicle.vehicleFamily,
      bundle: dialectFromConnection(RED, connectionNode),
    };

    let feed = null;
    switch (config.mode) {
      case 'feed': {
        const events = config.events.split(',').map((s) => s.trim()).filter(Boolean);
        feed = createStateFeed(connectionNode.peerTable, { events, modes }, (record) => {
          node.send([{ payload: record }]);
        });
        node.status({ fill: 'grey', shape: 'ring', text: 'listening' });
        break;
      }
      default: break; // This space intentionally left blank (§5)
    }

    node.on('input', (msg, send, done) => {
      try {
        if (shouldSuppress(msg)) {
          done();
          return;
        }
        switch (config.mode) {
          case 'snapshot': {
            const payload = msg.payload === undefined ? {} : msg.payload;
            const peers = snapshotPeers(connectionNode.peerTable, {
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
                crcFailures: connectionNode.crcFailureCount(),
              }),
            ]);
            break;
          }
          default: break; // This space intentionally left blank (§5)
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
