'use strict';

const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');

test('mavlink-payload node builds command-backed payload messages', () => {
  const RED = redStub({});
  require('../../nodes/mavlink-payload')(RED);
  const Node = RED.nodes.types['mavlink-payload'];
  const node = new Node({
    delivery: 'build',
    topic: 'servo',
    verb: 'set',
    targetSystem: 7,
    targetComponent: 1,
  });
  let sent;

  node.emit(
    'input',
    { payload: { values: { servo: 8, pwm: 1600 } } },
    (messages) => {
      sent = messages;
    },
    () => {}
  );

  assert.equal(sent[0].payload.name, 'COMMAND_LONG');
  assert.equal(sent[0].payload.fields.command, 183);
  assert.equal(sent[0].payload.fields.param2, 1600);
  assert.equal(sent[1].payload.confirmation, 'command_ack');
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
