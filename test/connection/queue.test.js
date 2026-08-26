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

test('a Liveness replacement moves behind other identities and the replaced item never surfaces', () => {
  const q = new OutboundQueue({ now: () => 0 });
  const replaced = q.enqueue({ band: BAND.LIVENESS, message: { name: 'HB', n: 1 }, identityId: 'a' });
  q.enqueue({ band: BAND.LIVENESS, message: { name: 'HB', n: 1 }, identityId: 'b' });
  q.enqueue({ band: BAND.LIVENESS, message: { name: 'HB', n: 2 }, identityId: 'a' });

  // The replacement re-enqueued at the band tail, so 'b' now dequeues first,
  // and the replaced item is gone: the queue drains without ever yielding it.
  const first = q.dequeue();
  const second = q.dequeue();
  assert.equal(first.identityId, 'b');
  assert.equal(second.identityId, 'a');
  assert.equal(second.message.n, 2);
  assert.notEqual(second, replaced);
  assert.equal(q.dequeue(), null);
  assert.equal(q.size(), 0);
});

test('a Streaming coalesce keeps its position and the newest value surfaces', () => {
  // Updated for age-inheriting in-place replacement (PR ports/wire-queue-armor):
  // a replaced slot keeps the position and age of its key's first arrival
  // instead of re-enqueueing at the tail. The old tail-move let a producer
  // outrunning the link reset its own age on every tick, so a continuously
  // replaced slot never promoted toward Control and never aged out as the
  // overflow drop candidate — a starvation hole. Liveness is unchanged:
  // band 1 never ages, so its replacement still moves to the tail.
  const q = new OutboundQueue({ now: () => 0 });
  q.enqueue({ band: BAND.STREAMING, message: { name: 'SP', v: 1 }, identityId: 'g', target: 'a' });
  q.enqueue({ band: BAND.STREAMING, message: { name: 'SP', v: 1 }, identityId: 'g', target: 'b' });
  q.enqueue({ band: BAND.STREAMING, message: { name: 'SP', v: 2 }, identityId: 'g', target: 'a' });

  // 'a' kept its head position; the dequeued value is the newest (v: 2),
  // and the stale v: 1 never surfaces.
  const first = q.dequeue();
  assert.equal(first.target, 'a');
  assert.equal(first.message.v, 2);
  assert.equal(q.dequeue().target, 'b');
  assert.equal(q.dequeue(), null);
});

test('a coalesced Streaming replacement inherits the slot’s age and promotes on it', () => {
  const clock = fakeClock(0);
  const q = new OutboundQueue({ now: clock.now, ageStepMs: 100 });

  q.enqueue({ band: BAND.STREAMING, message: { name: 'SP', v: 1 }, identityId: 'g', target: 'a' });
  clock.set(100);
  const replacement = q.enqueue({
    band: BAND.STREAMING,
    message: { name: 'SP', v: 2 },
    identityId: 'g',
    target: 'a',
  });
  assert.equal(replacement.enqueuedAt, 0, 'the replacement inherits the slot’s original enqueue time');
  assert.equal(replacement.message.v, 2, 'the newest value still wins');
  q.enqueue({ band: BAND.BULK, message: msg('laterBulk'), identityId: 'g' });

  // At t=300 the streaming slot has aged three full steps off its inherited
  // t=0 and clamps at Control; the younger bulk has aged two and sits at
  // band 2 as well — but the slot's original seq wins the tie.
  clock.set(300);
  assert.equal(q.dequeue(clock.now()).message.name, 'SP', 'the aged slot promotes ahead of the later bulk item');
  assert.equal(q.dequeue(clock.now()).message.name, 'laterBulk');
});

test('Streaming overflow drops the oldest by first arrival, unchanged by coalescing', () => {
  // Updated for age-inheriting in-place replacement (PR ports/wire-queue-armor):
  // coalescing no longer reorders the band, so the oldest slot is the key
  // that arrived first — a replaced slot stays the drop candidate it was.
  // (The previous version of this test used distinct message names for the
  // "replacement", which never coalesced at all — the name is part of the
  // coalescing key.)
  const q = new OutboundQueue({ now: () => 0, capacities: { [BAND.STREAMING]: 2 } });
  q.enqueue({ band: BAND.STREAMING, message: { name: 'SP', v: 1 }, identityId: 'g', target: 'a' });
  q.enqueue({ band: BAND.STREAMING, message: msg('B'), identityId: 'g', target: 'b' });
  q.enqueue({ band: BAND.STREAMING, message: { name: 'SP', v: 2 }, identityId: 'g', target: 'a' });
  q.enqueue({ band: BAND.STREAMING, message: msg('C'), identityId: 'g', target: 'c' });

  // The replaced 'a' slot kept its head position, so it (carrying v: 2) was
  // the oldest when 'C' overflowed — 'B' and 'C' survive.
  assert.equal(q.sizeOf(BAND.STREAMING), 2);
  const names = [q.dequeue().message.name, q.dequeue().message.name];
  assert.deepEqual(names, ['B', 'C']);
});

test('items aged to the clamp in different bands interleave by insertion order', () => {
  const clock = fakeClock(0);
  const q = new OutboundQueue({ now: clock.now, ageStepMs: 100 });
  q.enqueue({ band: BAND.BULK, message: msg('bulk'), identityId: 'g' });
  q.enqueue({ band: BAND.STREAMING, message: msg('stream'), identityId: 'g', target: '1.1' });
  clock.set(100000); // both clamp at Control
  q.enqueue({ band: BAND.CONTROL, message: msg('control'), identityId: 'g' });

  // All three sit at effective band 2; insertion order (seq) breaks the ties.
  const order = [];
  let item;
  while ((item = q.dequeue(clock.now()))) order.push(item.message.name);
  assert.deepEqual(order, ['bulk', 'stream', 'control']);
});

test('a band stays FIFO across interleaved enqueue and dequeue', () => {
  const q = new OutboundQueue({ now: () => 0 });
  q.enqueue({ band: BAND.BULK, message: msg('A'), identityId: 'g' });
  q.enqueue({ band: BAND.BULK, message: msg('B'), identityId: 'g' });
  q.enqueue({ band: BAND.BULK, message: msg('C'), identityId: 'g' });
  assert.equal(q.dequeue().message.name, 'A');
  q.enqueue({ band: BAND.BULK, message: msg('D'), identityId: 'g' });

  const order = [];
  let item;
  while ((item = q.dequeue())) order.push(item.message.name);
  assert.deepEqual(order, ['B', 'C', 'D']);
});

test('dequeue returns the band DSCP mark and null when empty', () => {
  const q = new OutboundQueue({ now: () => 0 });
  q.enqueue({ band: BAND.EMERGENCY, message: msg('E'), identityId: 'g' });
  assert.equal(q.dequeue().dscp, 46);
  assert.equal(q.dequeue(), null);
});
