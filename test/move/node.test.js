'use strict';

const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');

test('mavlink-move node builds a local-position message and emits status on output 1', () => {
  const RED = redStub({});
  require('../../nodes/mavlink-move')(RED);
  const Node = RED.nodes.types['mavlink-move'];
  const node = new Node({ delivery: 'build', mode: 'local-position', targetSystem: 5, targetComponent: 1 });
  let sent;

  node.emit(
    'input',
    { payload: { position: { north: 1, east: 2, up: 3 } } },
    (messages) => {
      sent = messages;
    },
    () => {}
  );

  assert.equal(sent[0].payload.name, 'SET_POSITION_TARGET_LOCAL_NED');
  assert.equal(sent[0].payload.fields.z, -3);
  assert.equal(sent[1].payload.result, 'succeeded');
  assert.equal(sent[1].payload._mavlinkStatus, true);
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
