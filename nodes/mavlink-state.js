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

    // Affirmative dispatch: a blank/typo used to fall through both `=== 'feed'`
    // gates and behave as snapshot silently. The editor's select always saves a
    // member, so a non-member is hand-edit drift and craters at construction.
    const mode = resolveStateMode(config.mode);

    let feed = null;
    if (connectionNode && mode === 'feed') {
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
        if (mode === 'feed') {
          // Feed mode's contract is "output 0 carries the event stream only"
          // (help text). Answering a snapshot here would interleave an array
          // payload on the same wire as the {kind, event, at} records — a
          // silent shape-shift downstream functions cannot be expected to
          // survive (Array.prototype.at defeats even an `r.at ||` fallback).
          throw new Error('mavlink-state feed mode takes no input — use a snapshot-mode State node');
        }
        if (!connectionNode) {
          throw new Error('mavlink-state requires a Connection');
        }
        const payload = msg.payload ?? {};
        const peers = snapshotPeers(connectionNode.peerTable, {
          // Nullish-preserving: a configured 0 must reach the filter as 0, not
          // be swallowed by `||` and treated as "unset".
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

/**
 * Affirmative dispatch for the State mode token: feed sets up the event stream
 * at construction, snapshot answers on input. Anything else — blank included —
 * throws rather than defaulting to snapshot (§14 selection-typo).
 *
 * @param {*} value  config.mode
 * @returns {'snapshot'|'feed'}
 */
function resolveStateMode(value) {
  switch (value) {
    case 'snapshot':
    case 'feed':
      return value;
    default:
      throw new Error(`unknown State mode ${JSON.stringify(value)} — expected one of snapshot, feed`);
  }
}

function selectedEvents(config) {
  if (Array.isArray(config.events)) return config.events;
  if (typeof config.events === 'string' && config.events.trim()) {
    return config.events.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return undefined;
}
