'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveDeliveryContext,
  applyConnectionStatus,
  dialectFromConnection,
} = require('../../lib/addressing');

function redStub(nodes = {}) {
  return {
    nodes: {
      getNode(id) { return nodes[id] || null; },
    },
  };
}

test('resolveDeliveryContext Build+__vehicle uses the Vehicle Profile', () => {
  const RED = redStub({
    veh: {
      defaultTargetSystem: 7,
      defaultTargetComponent: 1,
      firmware: 'ardupilot',
    },
  });
  const ctx = resolveDeliveryContext(RED, {
    delivery: 'build',
    config: { dialect: '__vehicle', vehicle: 'veh', targetSystem: '', targetComponent: '' },
    payload: {},
  });
  assert.equal(ctx.useVehicle, true);
  assert.equal(ctx.target.sysid, 7);
  assert.equal(ctx.profile.firmware, 'ardupilot');
});

test('resolveDeliveryContext Param buildFirmwareProfile supplies firmware', () => {
  const RED = redStub();
  const ctx = resolveDeliveryContext(RED, {
    delivery: 'build',
    config: { dialect: 'common', firmware: 'px4', targetSystem: '1', targetComponent: '1' },
    payload: {},
    buildFirmwareProfile: true,
  });
  assert.equal(ctx.profile.firmware, 'px4');
});

test('resolveDeliveryContext wire tiers use only the deploy-bound Connection', () => {
  const bound = { vehicle: { targetSystem: 3, targetComponent: 1 } };
  const RED = redStub({
    conn: { vehicle: { targetSystem: 99, targetComponent: 99 } },
  });
  const ctx = resolveDeliveryContext(RED, {
    delivery: 'send',
    config: {
      connection: 'conn',
      targetSystem: '',
      targetComponent: '',
    },
    payload: {},
    connectionNode: bound,
  });
  assert.equal(ctx.connectionNode, bound);
  assert.equal(ctx.profile, bound.vehicle);
  assert.equal(ctx.target.sysid, 3);
});

test('resolveDeliveryContext does not re-resolve a missing deploy-time Connection', () => {
  const RED = redStub({
    conn: { vehicle: { targetSystem: 1, targetComponent: 1 } },
  });
  const ctx = resolveDeliveryContext(RED, {
    delivery: 'send',
    config: { connection: 'conn', targetSystem: '1', targetComponent: '1' },
    payload: {},
  });
  assert.equal(ctx.connectionNode, null);
});

test('dialectFromConnection reads the bound profile node', () => {
  const bundle = { dialect: 'custom' };
  const RED = redStub({
    veh: { getDialect: () => bundle },
  });
  assert.equal(
    dialectFromConnection(RED, { vehicle: { id: 'veh' } }),
    bundle
  );
  assert.equal(dialectFromConnection(RED, { vehicle: null }), null);
});

// ── applyConnectionStatus (§6 deploy-time badge) ─────────────────────────────

test('applyConnectionStatus badges a wire tier whose Connection did not resolve', () => {
  // §6's one exception to "action nodes report last activity": a node that
  // cannot possibly work says so before it is triggered. The editor cannot
  // catch this — the id is valid there and only fails when the runtime
  // constructs the config node (disabled, or its constructor threw).
  const statuses = [];
  const node = { status: (s) => statuses.push(s) };

  applyConnectionStatus(node, 'confirm', null);
  assert.equal(statuses[0].fill, 'red');
  assert.equal(statuses[0].shape, 'ring');
  assert.equal(statuses[0].text, 'invalid config');
});

test('applyConnectionStatus clears when the config resolves — both halves', () => {
  // The clear is not decoration. Node-RED publishes a status clear only when a
  // node is *removed*, not when it is modified and restarted, and the editor
  // replays the last status it received — so without this a node that was
  // fixed and redeployed would keep displaying the dead badge (§14).
  const statuses = [];
  const node = { status: (s) => statuses.push(s) };

  applyConnectionStatus(node, 'confirm', { id: 'conn' });
  assert.deepEqual(statuses[0], {}, 'a resolved Connection clears');

  applyConnectionStatus(node, 'build', null);
  assert.deepEqual(statuses[1], {}, 'Build needs no Connection, so nothing to report');
});
