'use strict';

const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');

test('mavlink-param node builds PARAM_SET from msg payload values', () => {
  const RED = redStub({});
  require('../../nodes/mavlink-param')(RED);
  const Node = RED.nodes.types['mavlink-param'];
  const node = new Node({
    delivery: 'build',
    action: 'set',
    targetSystem: 6,
    targetComponent: 1,
    firmware: 'ardupilot',
  });
  let sent;

  node.emit(
    'input',
    { payload: { paramId: 'FOO', value: 12, paramType: 'MAV_PARAM_TYPE_REAL32' } },
    (messages) => {
      sent = messages;
    },
    () => {}
  );

  assert.equal(sent[0].payload.name, 'PARAM_SET');
  assert.equal(sent[0].payload.fields.param_id, 'FOO');
  assert.equal(sent[0].payload.fields.param_value, 12);
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
