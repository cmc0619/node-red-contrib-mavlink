'use strict';

const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');

test('mavlink-state node emits peer table snapshots on demand', () => {
  const connection = {
    vehicle: { id: 'veh', firmware: 'ardupilot', vehicleFamily: 'copter' },
    peerTable: {
      snapshot() {
        return [{ sysid: 4, components: [{ compid: 1, armed: true }] }];
      },
      getComponent() {
        return undefined;
      },
    },
    crcFailureCount: () => 0,
  };
  const RED = redStub({ conn: connection, veh: { getDialect: () => ({ enums: {} }) } });
  require('../../nodes/mavlink-state')(RED);
  const Node = RED.nodes.types['mavlink-state'];
  const node = new Node({
    connection: 'conn',
    mode: 'snapshot',
    events: 'stale,expired,statustext',
    targetSystem: 4,
  });
  let sent;

  node.emit(
    'input',
    { payload: {} }, // no overrides — the node runs on its saved config (DESIGN.md §"override of last resort")
    (messages) => {
      sent = messages;
    },
    () => {}
  );

  // modeName is always assigned; a component with no observed mode carries undefined.
  assert.deepEqual(sent[0].payload, [{ sysid: 4, components: [{ compid: 1, armed: true, modeName: undefined }] }]);
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
