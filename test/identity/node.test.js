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

test('mavlink-local-identity: a non-finite heartbeatIntervalMs refuses instead of flooding at ~1 kHz (owner ruling, 2026-08-14)', () => {
  // The editor's own validator (positiveNumberValidator) already blocks this
  // on a normal deploy; the crater this pins is the hand-edited flow the
  // editor never sees — the same target as band/sendAs/delivery.
  const RED = redStub();
  require('../../nodes/mavlink-local-identity')(RED);
  const Node = RED.nodes.types['mavlink-local-identity'];

  assert.throws(
    () => new Node({
      id: 'garbage',
      role: 'gcs',
      sourceSystemId: 255,
      sourceComponentId: 190,
      heartbeatIntervalMs: 'abc',
    }),
    /Local Identity heartbeat interval must be a finite number \(got "abc"\)/
  );
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
