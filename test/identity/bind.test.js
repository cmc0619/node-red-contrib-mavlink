'use strict';

/**
 * Companion sysid binding (DESIGN.md §7): bindVehicleSysid, releaseVehicleSysid.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { bindVehicleSysid, releaseVehicleSysid } = require('../../lib/identity');

/* ---------- bindVehicleSysid ---------- */

test('bindVehicleSysid records a claim and returns the sysid', () => {
  const claims = new Map();
  const result = bindVehicleSysid(claims, 1, 'conn-A', 'conn-A');
  assert.equal(result, 1);
  assert.equal(claims.size, 1);
});

test('same connection updating its sysid claim is allowed', () => {
  const claims = new Map();
  bindVehicleSysid(claims, 1, 'conn-A', 'conn-A');
  const result = bindVehicleSysid(claims, 1, 'conn-A', 'conn-A');
  assert.equal(result, 1);
  assert.equal(claims.size, 1);
});

test('two connections deriving the same sysid → both allowed', () => {
  const claims = new Map();
  bindVehicleSysid(claims, 5, 'conn-A', 'conn-A');
  bindVehicleSysid(claims, 5, 'conn-B', 'conn-B');
  assert.equal(claims.size, 2);
});

test('two connections deriving conflicting sysids → throws', () => {
  const claims = new Map();
  bindVehicleSysid(claims, 1, 'conn-A', 'conn-A');
  assert.throws(
    () => bindVehicleSysid(claims, 2, 'conn-B', 'conn-B'),
    /conflict/i
  );
});

test('conflict error names both sources', () => {
  const claims = new Map();
  bindVehicleSysid(claims, 1, 'ConnectionA', 'a');
  let msg = '';
  try {
    bindVehicleSysid(claims, 2, 'ConnectionB', 'b');
  } catch (err) {
    msg = err.message;
  }
  assert.ok(msg.includes('ConnectionA') || msg.includes('conn'), 'should name a source');
});

/* ---------- releaseVehicleSysid ---------- */

test('releaseVehicleSysid removes the claim and returns null when none remain', () => {
  const claims = new Map();
  bindVehicleSysid(claims, 1, 'conn-A', 'conn-A');
  const remaining = releaseVehicleSysid(claims, 'conn-A');
  assert.equal(remaining, null);
  assert.equal(claims.size, 0);
});

test('releaseVehicleSysid with two claims returns the surviving sysid', () => {
  const claims = new Map();
  bindVehicleSysid(claims, 7, 'conn-A', 'conn-A');
  bindVehicleSysid(claims, 7, 'conn-B', 'conn-B');
  const remaining = releaseVehicleSysid(claims, 'conn-A');
  assert.equal(remaining, 7);
  assert.equal(claims.size, 1);
});

test('releasing a non-existent sourceId is a no-op', () => {
  const claims = new Map();
  const remaining = releaseVehicleSysid(claims, 'never-bound');
  assert.equal(remaining, null);
});
