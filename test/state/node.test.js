'use strict';

const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');

test('mavlink-state node emits peer table snapshots on demand', () => {
  const connection = {
    peerTable: {
      snapshot() {
        return [{ sysid: 4, components: [{ compid: 1, armed: true }] }];
      },
    },
  };
  const RED = redStub({ conn: connection });
  require('../../nodes/mavlink-state')(RED);
  const Node = RED.nodes.types['mavlink-state'];
  const node = new Node({ connection: 'conn', mode: 'snapshot', targetSystem: 4 });
  let sent;

  node.emit(
    'input',
    {}, // no payload — the node runs on its saved config (DESIGN.md §"override of last resort")
    (messages) => {
      sent = messages;
    },
    () => {}
  );

  assert.deepEqual(sent[0].payload, [{ sysid: 4, components: [{ compid: 1, armed: true }] }]);
});

test("a typo'd mode crashes instead of silently running snapshot (protocol omega)", () => {
  // 'snapshsot' used to fall through both `=== 'feed'` gates and behave as
  // snapshot silently. Affirmative dispatch craters at construction.
  const RED = redStub({ conn: { peerTable: { snapshot() { return []; } } } });
  require('../../nodes/mavlink-state')(RED);
  const Node = RED.nodes.types['mavlink-state'];
  assert.throws(
    () => new Node({ connection: 'conn', mode: 'snapshsot', targetSystem: 4 }),
    /unknown State mode "snapshsot" — expected one of snapshot, feed/
  );
});

function redStub(nodesById) {
  return {
    nodes: {
      types: {},
      createNode(node, config) {
        Object.setPrototypeOf(node, EventEmitter.prototype);
        EventEmitter.call(node);
        node.id = config.id || 'node';
        node.status = () => {};
        node.error = () => {};
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
