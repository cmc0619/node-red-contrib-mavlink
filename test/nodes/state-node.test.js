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
  const RED = redStub(nodesById);
  require('../../nodes/mavlink-state')(RED);
  const Node = RED.nodes.types['mavlink-state'];
  return new Node(config);
}

function conn() {
  const peerTable = new EventEmitter();
  peerTable.snapshot = () => [{ sysid: 1, components: [{ compid: 1 }] }];
  return { id: 'conn', peerTable };
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
    { connection: 'conn', mode: 'snapshot', targetSystem: '', targetComponent: '' },
    { conn: conn() }
  );
  const { out, err } = await drive(node, { payload: {} });
  assert.equal(err, undefined);
  assert.equal(out[0][0].payload.length, 1);
  assert.equal(out[0][1].result, 'succeeded');
});
