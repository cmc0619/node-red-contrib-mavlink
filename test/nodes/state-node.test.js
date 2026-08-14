'use strict';

/**
 * Feed mode refuses input — pinned at the node, because the refusal lives in
 * the input handler, not lib/state. Before this, ANY input to a feed-mode
 * node answered a peer-table snapshot on output 0 — an array interleaved on
 * the same wire as the {kind, event, at} records, a payload shape-shift the
 * help text ("output 0 carries the event stream only") said could not happen.
 * The measured casualty: an array's `.at` is Array.prototype.at, so even a
 * downstream `new Date(r.at || Date.now())` fallback throws RangeError.
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

test('feed mode refuses input — no snapshot ever rides the event-stream wire', async () => {
  const node = makeNode(
    { connection: 'conn', mode: 'feed', events: 'stale,expired' },
    { conn: conn() }
  );
  const { out, err } = await drive(node, { payload: 1755138744000 });
  assert.match(err.message, /feed mode takes no input/);
  assert.equal(out[0][0], null, 'nothing on the event-stream output');
  assert.equal(out[0][1].result, 'failed');
});

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
