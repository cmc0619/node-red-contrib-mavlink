'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveDeliveryContext,
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
    config: { dialect: '__vehicle', vehicle: 'veh', identity: '', targetSystem: '', targetComponent: '' },
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
    config: { dialect: 'common', firmware: 'px4', identity: '', targetSystem: '1', targetComponent: '1' },
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
      identity: '',
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

test('resolveDeliveryContext wire stack covers every caller tier', () => {
  // The union of the caller tier selects (command send/confirm/complete,
  // param send/confirm/collect, payload send/confirm, mission confirm,
  // move send/confirm/stream): each member composes the Connection axis.
  const bound = { vehicle: { targetSystem: 3, targetComponent: 1 } };
  const RED = redStub();
  for (const delivery of ['send', 'confirm', 'complete', 'collect', 'stream']) {
    const ctx = resolveDeliveryContext(RED, {
      delivery,
      config: { connection: 'conn', identity: '', targetSystem: '', targetComponent: '' },
      payload: {},
      connectionNode: bound,
    });
    assert.equal(ctx.isBuild, false, delivery);
    assert.equal(ctx.connectionNode, bound, delivery);
    assert.equal(ctx.profile, bound.vehicle, delivery);
  }
});

test('resolveDeliveryContext composes nothing for a tier no editor select saves', () => {
  // §5: a stray tier matches no case in the tier dispatch — no Connection,
  // no profile, no identity node. The target still resolves from the config
  // rungs (it is data, not tier behavior), and the caller's own tier
  // dispatch selects nothing with the result.
  const bound = { vehicle: { targetSystem: 3, targetComponent: 1 } };
  const RED = redStub();
  const ctx = resolveDeliveryContext(RED, {
    delivery: 'sennd',
    config: { connection: 'conn', identity: '', targetSystem: '4', targetComponent: '1' },
    payload: {},
    connectionNode: bound,
  });
  assert.equal(ctx.isBuild, false);
  assert.equal(ctx.useVehicle, false);
  assert.equal(ctx.connectionNode, null);
  assert.equal(ctx.profile, null);
  assert.equal(ctx.identityNode, null);
  assert.equal(ctx.target.sysid, 4);
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
});
