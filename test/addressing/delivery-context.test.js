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

test('resolveDeliveryContext omitted identity is empty, not the string undefined', () => {
  // Admin API deploy posts raw flow JSON. Editor default identity is '', but
  // omitted stays undefined. String(undefined) used to become the override
  // "undefined", Connection.send looked up that id, and identity.sysid threw
  // (SITL 40 Set GUIDED at 1d9cd1f).
  const bound = { vehicle: { targetSystem: 1, targetComponent: 1 } };
  const RED = redStub();
  const ctx = resolveDeliveryContext(RED, {
    delivery: 'send',
    config: { connection: 'conn', targetSystem: '', targetComponent: '' },
    payload: {},
    connectionNode: bound,
  });
  assert.equal(ctx.identityId, '');
  assert.equal(ctx.identityNode, null);

  const dated = resolveDeliveryContext(RED, {
    delivery: 'send',
    config: { connection: 'conn', targetSystem: '', targetComponent: '' },
    payload: 1750000000000,
    connectionNode: bound,
  });
  assert.equal(dated.identityId, '');
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

test('resolveDeliveryContext does not re-resolve a missing deploy-time Connection', () => {
  const RED = redStub({
    conn: { vehicle: { targetSystem: 1, targetComponent: 1 } },
  });
  const ctx = resolveDeliveryContext(RED, {
    delivery: 'send',
    config: { connection: 'conn', identity: '', targetSystem: '1', targetComponent: '1' },
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

  applyConnectionStatus(node, true, null);
  assert.equal(statuses[0].fill, 'red');
  assert.equal(statuses[0].shape, 'ring');
  assert.equal(statuses[0].text, 'no connection');
});

test('applyConnectionStatus clears when the config resolves — both halves', () => {
  // The clear is not decoration. Node-RED publishes a status clear only when a
  // node is *removed*, not when it is modified and restarted, and the editor
  // replays the last status it received — so without this a node that was
  // fixed and redeployed would keep displaying the dead badge (§14).
  const statuses = [];
  const node = { status: (s) => statuses.push(s) };

  applyConnectionStatus(node, true, { id: 'conn' });
  assert.deepEqual(statuses[0], {}, 'a resolved Connection clears');

  applyConnectionStatus(node, false, null);
  assert.deepEqual(statuses[1], {}, 'a config that needs no Connection has nothing to report');
});
