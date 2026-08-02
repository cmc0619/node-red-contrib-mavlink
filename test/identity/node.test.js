'use strict';

const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');

test('mavlink-local-identity stores heartbeatIntervalMs with a 1 Hz default', () => {
  const RED = redStub();
  require('../../nodes/mavlink-local-identity')(RED);
  const Node = RED.nodes.types['mavlink-local-identity'];

  // Blank is editor-legal (positiveNumberValidator accepts it, the input's
  // placeholder reads 1000), so absence resolves to the 1 Hz convention.
  const blank = new Node({ id: 'blank', role: 'gcs', heartbeatIntervalMs: '' });
  const custom = new Node({ id: 'custom', role: 'gcs', heartbeatIntervalMs: 250 });

  assert.equal(blank.heartbeatIntervalMs, 1000);
  assert.equal(custom.heartbeatIntervalMs, 250);
});

function redStub() {
  return {
    nodes: {
      types: {},
      createNode(node, config) {
        Object.setPrototypeOf(node, EventEmitter.prototype);
        EventEmitter.call(node);
        node.id = config.id || 'node';
        node.status = () => {};
      },
      registerType(name, ctor) {
        this.types[name] = ctor;
      },
    },
  };
}
