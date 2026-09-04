'use strict';

/**
 * Mission transfer lock (DESIGN.md §9 "Lock per connection, profile, and
 * type", §13). Two transfers of the same type on the same target conflict; a
 * fence transfer and a mission transfer run concurrently.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { LockRegistry } = require('../../lib/delivery/lock');
const { MISSION_TYPE } = require('../../lib/mission/types');

const CONN = 'conn-1';
const TARGET = { sysid: 1, compid: 1 };

test('a second transfer of the same type on the same target is refused', () => {
  const locks = new LockRegistry();
  const release = locks.acquire(CONN, TARGET, MISSION_TYPE.FENCE);
  assert.notEqual(release, null);

  // Second fence transfer on the same target — refused while the first holds.
  assert.equal(locks.acquire(CONN, TARGET, MISSION_TYPE.FENCE), null);

  release();
  // Once released, a fence transfer can start again.
  assert.notEqual(locks.acquire(CONN, TARGET, MISSION_TYPE.FENCE), null);
});

test('a fence transfer and a mission transfer run concurrently (different type)', () => {
  const locks = new LockRegistry();
  const fence = locks.acquire(CONN, TARGET, MISSION_TYPE.FENCE);
  const mission = locks.acquire(CONN, TARGET, MISSION_TYPE.MISSION);

  assert.notEqual(fence, null);
  assert.notEqual(mission, null);
  assert.equal(locks.size(), 2);
});

test('the same type on different targets does not conflict', () => {
  const locks = new LockRegistry();
  const a = locks.acquire(CONN, { sysid: 1, compid: 1 }, MISSION_TYPE.MISSION);
  const b = locks.acquire(CONN, { sysid: 2, compid: 1 }, MISSION_TYPE.MISSION);
  assert.notEqual(a, null);
  assert.notEqual(b, null);
});

test('the same type on different connections does not conflict', () => {
  const locks = new LockRegistry();
  const a = locks.acquire('conn-a', TARGET, MISSION_TYPE.MISSION);
  const b = locks.acquire('conn-b', TARGET, MISSION_TYPE.MISSION);
  assert.notEqual(a, null);
  assert.notEqual(b, null);
});

test('release is idempotent', () => {
  const locks = new LockRegistry();
  const release = locks.acquire(CONN, TARGET, MISSION_TYPE.RALLY);
  release();
  release(); // no throw, no double-free effect
  assert.equal(locks.isHeld(CONN, TARGET, MISSION_TYPE.RALLY), false);
});
