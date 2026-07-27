'use strict';

const { createStateFeed, snapshotPeers } = require('../lib/state');

const BADGE_MAX = 24;

module.exports = function registerMavlinkState(RED) {
  function MavlinkStateNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const connectionNode = RED.nodes.getNode(config.connection);
    let feed = null;

    if (!connectionNode || !connectionNode.peerTable) {
      node.status({ fill: 'red', shape: 'ring', text: 'invalid config' });
    } else if (config.mode === 'feed') {
      feed = createStateFeed(connectionNode.peerTable, { events: selectedEvents(config) }, (record) => {
        node.send([{ payload: record }]);
      });
      node.status({ fill: 'grey', shape: 'ring', text: 'listening' });
    }

    node.on('input', (msg, send, done) => {
      const emit = send || ((messages) => node.send(messages));
      try {
        if (msg.payload === false) {
          if (done) done();
          return;
        }
        if (!connectionNode || !connectionNode.peerTable) {
          throw new Error('mavlink-state requires a Connection with a peer table');
        }
        const payload = objectPayload(msg.payload);
        const peers = snapshotPeers(connectionNode.peerTable, {
          sysid: payload.sysid || config.targetSystem,
          compid: payload.compid || config.targetComponent,
        });
        node.status({ fill: 'green', shape: 'dot', text: cap(`${peers.length} peer(s)`) });
        emit([{ payload: peers }]);
        if (done) done();
      } catch (err) {
        node.status({ fill: 'red', shape: 'ring', text: cap(err.message) });
        node.error(err);
        emit([null, { payload: statusRecord('failed', err.message) }]);
        if (done) done(err);
      }
    });

    node.on('close', (done) => {
      if (feed) feed.close();
      if (done) done();
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

function statusRecord(result, detail) {
  return { _mavlinkStatus: true, node: 'mavlink-state', result, detail };
}

function objectPayload(payload) {
  return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
}

function cap(text) {
  const s = String(text || '');
  return s.length > BADGE_MAX ? `${s.slice(0, BADGE_MAX - 1)}…` : s;
}
