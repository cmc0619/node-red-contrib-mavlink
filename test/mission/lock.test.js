'use strict';

/**
 * Mission transfer lock (DESIGN.md §9 "Lock per connection, profile, and
 * type", §13). Two transfers of the same type on the same target conflict; a
 * fence transfer and a mission transfer run concurrently.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { LockRegistry } = require('../../lib/delivery/lock');
const { missionTypeValue } = require('../../lib/mission/types');

const CONN = 'conn-1';
const TARGET = { sysid: 1, compid: 1 };

test('a second transfer of the same type on the same target is refused', () => {
  const locks = new LockRegistry();
  const release = locks.acquire(CONN, TARGET, missionTypeValue('fence'));
  assert.notEqual(release, null);

  // Second fence transfer on the same target — refused while the first holds.
  assert.equal(locks.acquire(CONN, TARGET, missionTypeValue('fence')), null);

  release();
  // Once released, a fence transfer can start again.
  assert.notEqual(locks.acquire(CONN, TARGET, missionTypeValue('fence')), null);
});

test('a fence transfer and a mission transfer run concurrently (different type)', () => {
  const locks = new LockRegistry();
  const fence = locks.acquire(CONN, TARGET, missionTypeValue('fence'));
  const mission = locks.acquire(CONN, TARGET, missionTypeValue('mission'));

  assert.notEqual(fence, null);
  assert.notEqual(mission, null);
});

test('the same type on different targets does not conflict', () => {
  const locks = new LockRegistry();
  const a = locks.acquire(CONN, { sysid: 1, compid: 1 }, missionTypeValue('mission'));
  const b = locks.acquire(CONN, { sysid: 2, compid: 1 }, missionTypeValue('mission'));
  assert.notEqual(a, null);
  assert.notEqual(b, null);
});

test('the same type on different connections does not conflict', () => {
  const locks = new LockRegistry();
  const a = locks.acquire('conn-a', TARGET, missionTypeValue('mission'));
  const b = locks.acquire('conn-b', TARGET, missionTypeValue('mission'));
  assert.notEqual(a, null);
  assert.notEqual(b, null);
});

test('release is idempotent', () => {
  const locks = new LockRegistry();
  const release = locks.acquire(CONN, TARGET, missionTypeValue('rally'));
  release();
  release(); // no throw, no double-free effect
  assert.equal(locks.isHeld(CONN, TARGET, missionTypeValue('rally')), false);
});
