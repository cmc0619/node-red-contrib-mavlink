'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveDeliveryContext,
  missingConnectionGate,
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

test('resolveDeliveryContext accepts Command legacy targetSysid keys', () => {
  const RED = redStub();
  const ctx = resolveDeliveryContext(RED, {
    delivery: 'build',
    config: { dialect: 'common', targetSysid: '9', targetCompid: '2' },
    payload: {},
  });
  assert.equal(ctx.target.sysid, 9);
  assert.equal(ctx.target.compid, 2);
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

test('resolveDeliveryContext wire tiers use the deploy-bound Connection only', () => {
  let lookups = 0;
  const bound = { vehicle: { targetSysid: 3, targetCompid: 1 } };
  const RED = {
    nodes: {
      getNode(id) {
        lookups += 1;
        if (id === 'conn') return { vehicle: { targetSysid: 99, targetCompid: 99 } };
        if (id === 'id1') return { getIdentity: () => ({ sysid: 1, compid: 1 }) };
        return null;
      },
    },
  };
  const ctx = resolveDeliveryContext(RED, {
    delivery: 'send',
    config: {
      connection: 'conn',
      identity: 'id1',
      targetSystem: '',
      targetComponent: '',
    },
    payload: {},
    connectionNode: bound,
  });
  assert.equal(ctx.connectionNode, bound);
  assert.equal(ctx.profile.targetSysid, 3);
  assert.equal(lookups, 1, 'must not re-getNode config.connection');
});

test('resolveDeliveryContext wire tiers do not invent a Connection via getNode', () => {
  const RED = redStub({
    conn: { vehicle: { targetSysid: 1, targetCompid: 1 } },
  });
  const ctx = resolveDeliveryContext(RED, {
    delivery: 'send',
    config: { connection: 'conn', targetSystem: '1', targetComponent: '1' },
    payload: {},
  });
  assert.equal(ctx.connectionNode, null);
});

test('missingConnectionGate flags wire tiers without a connection', () => {
  const statuses = [];
  const node = { status: (s) => statuses.push(s) };
  assert.equal(missingConnectionGate(node, 'confirm', null), true);
  assert.equal(statuses[0].fill, 'red');
  assert.equal(missingConnectionGate(node, 'build', null), false);
  assert.deepEqual(statuses[1], {});
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
