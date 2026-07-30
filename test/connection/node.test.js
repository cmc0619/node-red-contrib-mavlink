'use strict';

/**
 * mavlink-connection node constructor tests (DESIGN.md §6, §7).
 *   - a disabled connection's send stub must fail loud, not report phantom
 *     success (mirrors the "never report phantom success" rule already
 *     documented at mavlink-command.js and mavlink-out.js).
 *
 * Required, editor-validated references (the Vehicle Profile, Local Identity)
 * and their internals (getDialect/getDefaults, loadBundled) are trusted: a
 * dangling or throwing reference is a broken deploy that must fail loud at
 * construction, not be masked by a degraded phantom Connection — so there is
 * deliberately no test asserting graceful degradation for those.
 *
 * A minimal Node-RED stub drives the node constructor; no live runtime.
 */

const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');

test('a disabled connection throws on send instead of reporting phantom success', () => {
  const RED = redStub({});
  require('../../nodes/mavlink-connection')(RED);
  const Node = RED.nodes.types['mavlink-connection'];
  const node = new Node({ disabled: true });

  assert.doesNotThrow(
    () => node.subscribe({}, () => {})(),
    'receiving nothing from a disabled connection is correct — subscribe stays a no-op'
  );
  assert.throws(
    () => node.send({ name: 'HEARTBEAT', fields: {} }),
    /disabled/,
    'send must fail loud so sender nodes report it instead of a phantom "sent"'
  );

  node.emit('close', () => {});
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
        node.warn = () => {};
        node.log = () => {};
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
