'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveActionTarget,
  profileFromVehicleNode,
  firstDefined,
} = require('../../lib/addressing');

const PROFILE = { targetSysid: 42, targetCompid: 191, firmware: 'px4' };

function companionIdentity(sysid) {
  return {
    derivesSysidFromVehicle: true,
    getIdentity: () => ({ sysid, compid: 191 }),
  };
}

const GCS_IDENTITY = {
  derivesSysidFromVehicle: false,
  getIdentity: () => ({ sysid: 255, compid: 190 }),
};

test('payload target wins over everything, including companion derivation', () => {
  const t = resolveActionTarget({
    payloadTarget: { sysid: 9, compid: 33 },
    configSysid: 5,
    configCompid: 6,
    identityNode: companionIdentity(42),
    profile: PROFILE,
  });
  assert.deepEqual(t, { sysid: 9, compid: 33 });
});

test('companion identity derives {airframe sysid, 1} and ignores config target', () => {
  const t = resolveActionTarget({
    configSysid: 5,
    configCompid: 6,
    identityNode: companionIdentity(42),
    profile: PROFILE,
  });
  assert.deepEqual(t, { sysid: 42, compid: 1 });
});

test('companion with compidFromConfig keeps compid resolution (Payload)', () => {
  const t = resolveActionTarget({
    configCompid: 100,
    identityNode: companionIdentity(42),
    profile: PROFILE,
    compidFromConfig: true,
  });
  assert.deepEqual(t, { sysid: 42, compid: 100 });
});

test('companion + compidFromConfig + blank compid inherits profile default', () => {
  const t = resolveActionTarget({
    configCompid: '',
    identityNode: companionIdentity(42),
    profile: PROFILE,
    compidFromConfig: true,
  });
  assert.deepEqual(t, { sysid: 42, compid: 191 });
});

test('gcs identity: config wins over profile', () => {
  const t = resolveActionTarget({
    configSysid: 7,
    configCompid: 100,
    identityNode: GCS_IDENTITY,
    profile: PROFILE,
  });
  assert.deepEqual(t, { sysid: 7, compid: 100 });
});

test('gcs identity: blank config inherits profile default', () => {
  const t = resolveActionTarget({
    configSysid: '',
    configCompid: '',
    identityNode: GCS_IDENTITY,
    profile: PROFILE,
  });
  assert.deepEqual(t, { sysid: 42, compid: 191 });
});

test('configured 0 is broadcast and survives the chain', () => {
  const t = resolveActionTarget({
    configSysid: 0,
    configCompid: 0,
    profile: PROFILE,
  });
  assert.deepEqual(t, { sysid: 0, compid: 0 });
});

test('unbound companion throws loud (broken deploy, not a mystery)', () => {
  const unbound = {
    derivesSysidFromVehicle: true,
    getIdentity: () => { throw new Error('companion identity is not bound to a vehicle'); },
  };
  assert.throws(() => resolveActionTarget({ identityNode: unbound }), /not bound/);
});

test('firmware ladder is payload → profile via firstDefined (no invented ardupilot)', () => {
  assert.equal(firstDefined('custom', PROFILE.firmware), 'custom');
  assert.equal(firstDefined(undefined, PROFILE.firmware), 'px4');
  assert.equal(firstDefined(undefined, undefined), undefined);
});

test('profileFromVehicleNode maps defaults and firmware, null-safe', () => {
  assert.equal(profileFromVehicleNode(null), null);
  assert.deepEqual(
    profileFromVehicleNode({ defaultTargetSystem: 3, defaultTargetComponent: 4, firmware: 'px4' }),
    { targetSysid: 3, targetCompid: 4, firmware: 'px4' }
  );
});
