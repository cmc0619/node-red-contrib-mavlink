'use strict';

/**
 * The at-most-one-in-flight slot (`cancelSlot`) mavlink-command and
 * mavlink-payload hang their AckWaiter on: cancel fires once, and a release
 * cannot clear a newer run's handle.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { cancelSlot } = require('../../lib/command/ack');

test('cancelSlot cancels the active entry once and only once', () => {
  const slot = cancelSlot();
  let cancels = 0;
  const entry = { cancel: () => { cancels += 1; } };
  slot.active = entry;
  slot.cancel();
  assert.equal(cancels, 1);
  assert.equal(slot.active, null);
  slot.cancel();
  assert.equal(cancels, 1, 'cancel with no active entry is a no-op');
});

test('cancelSlot release is identity-guarded — a stale run cannot clear a newer handle', () => {
  const slot = cancelSlot();
  const first = { cancel: () => {} };
  const second = { cancel: () => {} };
  slot.active = first;
  assert.equal(slot.active, first);
  slot.active = second;
  slot.release(first);
  assert.equal(slot.active, second, 'releasing the superseded entry leaves the newer one');
  slot.release(second);
  assert.equal(slot.active, null);
});
