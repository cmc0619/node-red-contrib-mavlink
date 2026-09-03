'use strict';

/**
 * Snapshot mode answers input with the peer-table view — pinned at the node,
 * because the behavior lives in the input handler, not lib/state. Feed mode no
 * longer refuses an input: an input to a feed node is a no-op (§5 sweep — the
 * editor is the protector, and a mis-wired feed node drops the input rather
 * than raising), so only snapshot's positive path is left to pin here.
 *
 * The test drives the REAL node (stub-over-fiction lesson, #252/#267).
 */

const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');

function redStub(nodesById) {
  return {
    nodes: {
      types: {},
      createNode(node, config) {
        Object.setPrototypeOf(node, EventEmitter.prototype);
        EventEmitter.call(node);
        node.id = config.id || 'node';
        node.type = 'mavlink-state';
        node.status = () => {};
        node.error = () => {};
        node.warn = () => {};
        node.send = (m) => m;
      },
      registerType(name, ctor) {
        this.types[name] = ctor;
      },
      getNode(id) {
        return nodesById[id];
      },
    },
  };
}

function makeNode(config, nodesById = {}) {
  const RED = redStub({ veh: { getDialect: () => ({ enums: {} }) }, ...nodesById });
  require('../../nodes/mavlink-state')(RED);
  const Node = RED.nodes.types['mavlink-state'];
  return new Node(config);
}

function conn(crcFailures = 0) {
  const peerTable = new EventEmitter();
  peerTable.snapshot = () => [{ sysid: 1, components: [{ compid: 1 }] }];
  peerTable.getComponent = () => undefined;
  return {
    id: 'conn',
    vehicle: { id: 'veh', firmware: 'ardupilot', vehicleFamily: 'copter' },
    peerTable,
    crcFailureCount: () => crcFailures,
  };
}

/** Drive one input; resolve on done() with everything the input emitted. */
function drive(node, msg) {
  return new Promise((resolve) => {
    const out = [];
    node.emit(
      'input',
      msg,
      (m) => { out.push(m); },
      (err) => resolve({ out, err })
    );
  });
}

test('snapshot mode still answers input with the peer-table view', async () => {
  const node = makeNode(
    {
      connection: 'conn',
      mode: 'snapshot',
      events: 'stale,expired,statustext',
      targetSystem: '',
      targetComponent: '',
    },
    { conn: conn() }
  );
  const { out, err } = await drive(node, { payload: {} });
  assert.equal(err, undefined);
  assert.equal(out[0][0].payload.length, 1);
  assert.equal(out[0][1].result, 'succeeded');
});

test('the snapshot status record carries the link corruption count', async () => {
  // Corrupt frames are dropped inside the splitter, so a flow's only view of a
  // deteriorating link is this number on output 1 — poll it and subtract.
  const node = makeNode(
    {
      connection: 'conn',
      mode: 'snapshot',
      events: '',
      targetSystem: '',
      targetComponent: '',
    },
    { conn: conn(4) }
  );
  const { out } = await drive(node, { payload: {} });
  assert.equal(out[0][1].crcFailures, 4);
  assert.equal(out[0][0].payload.length, 1, 'the peers payload on output 0 is untouched');
});

test('feed mode subscribes to the comma-joined events the editor saved', () => {
  const connection = conn();
  const emitted = [];
  const node = makeNode(
    {
      connection: 'conn',
      mode: 'feed',
      events: 'stale,expired',
      targetSystem: '',
      targetComponent: '',
    },
    { conn: connection }
  );
  node.send = (msgs) => emitted.push(msgs[0].payload);

  connection.peerTable.emit('stale', { sysid: 1, compid: 1 });
  connection.peerTable.emit('statustext', { sysid: 1, compid: 1, text: 'EKF OK' });
  connection.peerTable.emit('expired', { sysid: 1, compid: 1 });

  assert.deepEqual(
    emitted.map((r) => r.event),
    ['stale', 'expired'],
    'only the selected events reach the flow'
  );
});
