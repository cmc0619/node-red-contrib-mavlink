'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveActionTarget,
  profileFromVehicleNode,
  firstDefined,
  finiteNumberOr,
} = require('../../lib/addressing');

const PROFILE = { targetSystem: 42, targetComponent: 191, firmware: 'px4' };

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

test('a whitespace payload target is blank — it inherits, never broadcast 0 (#174)', () => {
  // Number(' ') is a finite 0, and sysid 0 is a real broadcast target: an
  // untrimmed blank test turned a template-join artifact into a broadcast.
  const t = resolveActionTarget({
    payloadTarget: { sysid: ' ', compid: '\t' },
    configSysid: 7,
    configCompid: 100,
    profile: PROFILE,
  });
  assert.deepEqual(t, { sysid: 7, compid: 100 });
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
    { targetSystem: 3, targetComponent: 4, firmware: 'px4' }
  );
});

// ── finiteNumberOr (owner ruling, 2026-08-14, timer/rate/port half) ─────────

test('finiteNumberOr: blank/absent resolves to the fallback verbatim', () => {
  assert.equal(finiteNumberOr(undefined, 1000, 'x'), 1000);
  assert.equal(finiteNumberOr(null, 1000, 'x'), 1000);
  assert.equal(finiteNumberOr('', 1000, 'x'), 1000);
  assert.equal(finiteNumberOr('   ', 1000, 'x'), 1000);
  // The fallback itself is not finiteness-checked — undefined rides through,
  // matching PeerTable's own "let the built-in default apply" contract.
  assert.equal(finiteNumberOr(undefined, undefined, 'x'), undefined);
});

test('finiteNumberOr: a present finite value coerces, including an explicit 0', () => {
  assert.equal(finiteNumberOr('5000', 1000, 'x'), 5000);
  assert.equal(finiteNumberOr(5000, 1000, 'x'), 5000);
  // 0 is a real value, not blank — the truthiness bug this replaces
  // (`config.staleMs ? Number(config.staleMs) : undefined`) lost it.
  assert.equal(finiteNumberOr(0, 1000, 'x'), 0);
  assert.equal(finiteNumberOr('0', 1000, 'x'), 0);
});

test('finiteNumberOr: a present non-finite value throws naming the label', () => {
  assert.throws(() => finiteNumberOr('fast', 5, 'Move stream rate (rateHz)'), /Move stream rate \(rateHz\) must be a finite number \(got "fast"\)/);
  assert.throws(() => finiteNumberOr(NaN, 5, 'x'), /must be a finite number/);
  assert.throws(() => finiteNumberOr(Infinity, 5, 'x'), /must be a finite number/);
  // Not blank — an array is not whitespace-only, so it reaches Number() and
  // fails finiteness like any other non-numeric value.
  assert.throws(() => finiteNumberOr([1, 2], 5, 'x'), /must be a finite number/);
});
