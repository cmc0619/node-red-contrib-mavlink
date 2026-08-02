'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { OutboundQueue, QueueOverflowError } = require('../../lib/connection/queue');
const { BAND } = require('../../lib/connection/bands');
const { fakeClock } = require('./helpers');

/**
 * @param {string} name
 * @returns {{name: string}}
 */
function msg(name) {
  return { name };
}

test('dequeues strictly by band when nothing has aged', () => {
  const q = new OutboundQueue({ now: () => 0 });
  q.enqueue({ band: BAND.BULK, message: msg('B'), identityId: 'a' });
  q.enqueue({ band: BAND.STREAMING, message: msg('S'), identityId: 'a', target: '1.1' });
  q.enqueue({ band: BAND.CONTROL, message: msg('C'), identityId: 'a' });
  q.enqueue({ band: BAND.LIVENESS, message: msg('L'), identityId: 'a' });
  q.enqueue({ band: BAND.EMERGENCY, message: msg('E'), identityId: 'a' });

  const order = [];
  let item;
  while ((item = q.dequeue())) order.push(item.message.name);
  assert.deepEqual(order, ['E', 'L', 'C', 'S', 'B']);
});

test('ageing promotes a waiting bulk item but clamps at Control — never above Liveness', () => {
  const clock = fakeClock(0);
  const q = new OutboundQueue({ now: clock.now, ageStepMs: 100 });

  // A bulk item waits a long time; a heartbeat and an emergency arrive fresh.
  q.enqueue({ band: BAND.BULK, message: msg('oldBulk'), identityId: 'a' });
  clock.set(100000); // far past any number of age steps
  q.enqueue({ band: BAND.LIVENESS, message: msg('hb'), identityId: 'a' });
  q.enqueue({ band: BAND.EMERGENCY, message: msg('stop'), identityId: 'a' });

  // Emergency and Liveness still win: the aged bulk clamps at Control (band 2)
  // and cannot reach band 1 or 0 no matter how old it is.
  assert.equal(q.dequeue(clock.now()).message.name, 'stop');
  assert.equal(q.dequeue(clock.now()).message.name, 'hb');
  assert.equal(q.dequeue(clock.now()).message.name, 'oldBulk');
});

test('a clamped aged item wins an age tie-break against fresh control', () => {
  const clock = fakeClock(0);
  const q = new OutboundQueue({ now: clock.now, ageStepMs: 100 });
  q.enqueue({ band: BAND.BULK, message: msg('oldBulk'), identityId: 'a' });
  clock.set(100000);
  q.enqueue({ band: BAND.CONTROL, message: msg('freshControl'), identityId: 'a' });

  // Both sit at effective band 2; the older (bulk, lower seq) dequeues first.
  assert.equal(q.dequeue(clock.now()).message.name, 'oldBulk');
  assert.equal(q.dequeue(clock.now()).message.name, 'freshControl');
});

test('peek returns the next item without removing it', () => {
  const q = new OutboundQueue({ now: () => 0 });
  q.enqueue({ band: BAND.BULK, message: msg('B'), identityId: 'a' });
  q.enqueue({ band: BAND.CONTROL, message: msg('C'), identityId: 'a' });

  const next = q.peek();

  assert.equal(next.message.name, 'C');
  assert.equal(q.size(), 2);
  assert.equal(q.dequeue(), next);
});

test('Streaming coalescing key includes identity — two identities do not collapse', () => {
  const q = new OutboundQueue({ now: () => 0 });
  q.enqueue({ band: BAND.STREAMING, message: msg('SETPOINT'), identityId: 'gcs', target: '1.1' });
  q.enqueue({ band: BAND.STREAMING, message: msg('SETPOINT'), identityId: 'companion', target: '1.1' });
  assert.equal(q.sizeOf(BAND.STREAMING), 2);
});

test('Streaming coalesces same identity+message+target to the last value', () => {
  const q = new OutboundQueue({ now: () => 0 });
  q.enqueue({
    band: BAND.STREAMING,
    message: { name: 'SETPOINT', v: 1 },
    identityId: 'gcs',
    target: '1.1',
  });
  q.enqueue({
    band: BAND.STREAMING,
    message: { name: 'SETPOINT', v: 2 },
    identityId: 'gcs',
    target: '1.1',
  });
  assert.equal(q.sizeOf(BAND.STREAMING), 1);
  assert.equal(q.dequeue().message.v, 2);
});

test('Streaming overflow drops the oldest', () => {
  const q = new OutboundQueue({ now: () => 0, capacities: { [BAND.STREAMING]: 2 } });
  q.enqueue({ band: BAND.STREAMING, message: msg('A'), identityId: 'g', target: 'a' });
  q.enqueue({ band: BAND.STREAMING, message: msg('B'), identityId: 'g', target: 'b' });
  q.enqueue({ band: BAND.STREAMING, message: msg('C'), identityId: 'g', target: 'c' });
  assert.equal(q.sizeOf(BAND.STREAMING), 2);
  const names = [q.dequeue().message.name, q.dequeue().message.name];
  assert.deepEqual(names, ['B', 'C']); // 'A' (oldest) was dropped
});

test('Bulk overflow rejects the newest with an error', () => {
  const q = new OutboundQueue({ now: () => 0, capacities: { [BAND.BULK]: 1 } });
  q.enqueue({ band: BAND.BULK, message: msg('A'), identityId: 'g' });
  assert.throws(
    () => q.enqueue({ band: BAND.BULK, message: msg('B'), identityId: 'g' }),
    QueueOverflowError
  );
  assert.equal(q.sizeOf(BAND.BULK), 1);
});

test('Control overflow raises rather than silently discarding', () => {
  const q = new OutboundQueue({ now: () => 0, capacities: { [BAND.CONTROL]: 1 } });
  q.enqueue({ band: BAND.CONTROL, message: msg('A'), identityId: 'g' });
  assert.throws(
    () => q.enqueue({ band: BAND.CONTROL, message: msg('B'), identityId: 'g' }),
    QueueOverflowError
  );
});

test('Emergency overflow is a fault, not a drop', () => {
  const q = new OutboundQueue({ now: () => 0, capacities: { [BAND.EMERGENCY]: 1 } });
  q.enqueue({ band: BAND.EMERGENCY, message: msg('A'), identityId: 'g' });
  assert.throws(
    () => q.enqueue({ band: BAND.EMERGENCY, message: msg('B'), identityId: 'g' }),
    QueueOverflowError
  );
});

test('Liveness holds at most one outstanding per identity', () => {
  const q = new OutboundQueue({ now: () => 0 });
  q.enqueue({ band: BAND.LIVENESS, message: { name: 'HEARTBEAT', n: 1 }, identityId: 'gcs' });
  q.enqueue({ band: BAND.LIVENESS, message: { name: 'HEARTBEAT', n: 2 }, identityId: 'gcs' });
  q.enqueue({ band: BAND.LIVENESS, message: { name: 'HEARTBEAT', n: 1 }, identityId: 'companion' });
  assert.equal(q.sizeOf(BAND.LIVENESS), 2); // one per identity
  const gcs = q.dequeue();
  assert.equal(gcs.message.n, 2); // the second replaced the first
});

test('dequeue returns the band DSCP mark and null when empty', () => {
  const q = new OutboundQueue({ now: () => 0 });
  q.enqueue({ band: BAND.EMERGENCY, message: msg('E'), identityId: 'g' });
  assert.equal(q.dequeue().dscp, 46);
  assert.equal(q.dequeue(), null);
});
