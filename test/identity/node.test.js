'use strict';

const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');

test('mavlink-local-identity stores heartbeatIntervalMs with a 1 Hz default', () => {
  const RED = redStub();
  require('../../nodes/mavlink-local-identity')(RED);
  const Node = RED.nodes.types['mavlink-local-identity'];

  const defaulted = new Node({ id: 'defaulted', role: 'gcs' });
  const custom = new Node({ id: 'custom', role: 'gcs', heartbeatIntervalMs: 250 });
  const explicitDefault = new Node({ id: 'explicit', role: 'gcs', heartbeatIntervalMs: 1000 });

  assert.equal(defaulted.heartbeatIntervalMs, 1000);
  assert.equal(defaulted.heartbeatIntervalMsConfigured, false);
  assert.equal(custom.heartbeatIntervalMs, 250);
  assert.equal(custom.heartbeatIntervalMsConfigured, true);
  assert.equal(explicitDefault.heartbeatIntervalMsConfigured, true);
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
