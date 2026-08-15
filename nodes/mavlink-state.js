'use strict';

const { createStateFeed, snapshotPeers } = require('../lib/state');
const { firstDefined, applyConnectionStatus } = require('../lib/addressing');
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

    let feed = null;
    if (config.mode === 'feed') {
      feed = createStateFeed(connectionNode.peerTable, { events: selectedEvents(config) }, (record) => {
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
          });
          applyActionStatus(node, 'ok', `${peers.length} peer(s)`);
          send([
            { payload: peers },
            makeStatusRecord({
              node: 'mavlink-state',
              result: 'succeeded',
              detail: 'snapshot',
              count: peers.length,
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

function selectedEvents(config) {
  if (Array.isArray(config.events)) return config.events;
  if (typeof config.events === 'string' && config.events.trim()) {
    return config.events.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return undefined;
}
