'use strict';

const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');

test('mavlink-local-identity converts heartbeatIntervalMs as saved', () => {
  const RED = redStub();
  require('../../nodes/mavlink-local-identity')(RED);
  const Node = RED.nodes.types['mavlink-local-identity'];

  // The editor owns the 1000 default and reds blank (positiveNumberValidator,
  // mavlink-local-identity.html), so the runtime sees only a saved positive
  // number and just converts it — no second default here (§0).
  const custom = new Node({ id: 'custom', role: 'gcs', heartbeatIntervalMs: 250 });
  const stock = new Node({ id: 'stock', role: 'gcs', heartbeatIntervalMs: 1000 });

  assert.equal(custom.heartbeatIntervalMs, 250);
  assert.equal(stock.heartbeatIntervalMs, 1000);
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
