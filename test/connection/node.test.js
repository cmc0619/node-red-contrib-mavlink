'use strict';

/**
 * mavlink-connection node constructor tests (DESIGN.md §6, §7). Covers two
 * review findings:
 *   - a disabled connection's send stub must fail loud, not report phantom
 *     success (mirrors the "never report phantom success" rule already
 *     documented at mavlink-command.js and mavlink-out.js);
 *   - deploy-time dialect failures (dangling Vehicle Profile reference, a
 *     broken custom profile's getDialect() throwing, a dangling identity
 *     reference) must degrade to a status badge, not throw in the
 *     constructor and leave the Connection — and every consumer — silently
 *     nonexistent.
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

test('a dangling Vehicle Profile reference degrades to invalid config instead of throwing in the constructor', () => {
  const RED = redStub({}); // config.vehicle points at nothing RED.nodes knows about
  require('../../nodes/mavlink-connection')(RED);
  const Node = RED.nodes.types['mavlink-connection'];

  let node;
  assert.doesNotThrow(() => {
    node = new Node({ vehicle: 'missing-vehicle', mode: 'udp' });
  }, 'a dangling vehicle reference must not throw and take the whole Connection down');

  assert.throws(
    () => node.send({ name: 'HEARTBEAT', fields: {} }),
    /invalid config/,
    'send fails loud naming the cause instead of pretending to work'
  );

  node.emit('close', () => {});
});

test('a Vehicle Profile whose getDialect() throws degrades to "dialect unavailable" (mirrors mavlink-build)', () => {
  const brokenVehicle = {
    getDialect() {
      throw new Error('bad custom XML profile');
    },
    getDefaults() {
      return {
        defaultTargetSystem: 1,
        defaultTargetComponent: 1,
        firmware: 'ardupilot',
        dialect: 'ardupilotmega',
      };
    },
  };
  const RED = redStub({ veh: brokenVehicle });
  require('../../nodes/mavlink-connection')(RED);
  const Node = RED.nodes.types['mavlink-connection'];

  let node;
  assert.doesNotThrow(() => {
    node = new Node({ vehicle: 'veh', mode: 'udp' });
  }, 'a broken custom profile must not throw and take the whole Connection down');

  assert.throws(
    () => node.send({ name: 'HEARTBEAT', fields: {} }),
    /dialect unavailable/,
    'send fails loud naming the cause instead of pretending to work'
  );

  node.emit('close', () => {});
});

test('a dangling identity reference degrades to invalid config instead of crashing the constructor', async () => {
  const vehicleNode = {
    getDialect() {
      return { enums: {}, messages: {} };
    },
    getDefaults() {
      return {
        defaultTargetSystem: 1,
        defaultTargetComponent: 1,
        firmware: 'ardupilot',
        dialect: 'ardupilotmega',
      };
    },
  };
  const RED = redStub({ veh: vehicleNode }); // 'missing-identity' resolves to undefined
  require('../../nodes/mavlink-connection')(RED);
  const Node = RED.nodes.types['mavlink-connection'];

  const node = new Node({
    vehicle: 'veh',
    additionalIdentities: ['missing-identity'],
    mode: 'udp',
    bindHost: '127.0.0.1',
    bindPort: 0, // ephemeral — the OS picks a free port, no fixture collision
  });

  // Silently filtering the reference would leave its id in boundIdentityIds /
  // defaultIdentityId while the runtime snapshot lacks it — send() with that
  // id would then crash on an undefined identity. Fail loud at construction:
  // badge + a throwing send, same posture as the dialect guards.
  assert.throws(
    () => node.send({ name: 'HEARTBEAT', fields: {} }),
    /invalid config/,
    'a dangling identity must fail at deploy, not become a send-time mystery'
  );

  await new Promise((resolve) => node.emit('close', resolve));
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
