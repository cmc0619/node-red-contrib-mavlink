'use strict';

/**
 * MISSION_SET_CURRENT → broadcast MISSION_CURRENT exchange. The response has
 * no target or mission_type fields, so the machine still uses the transport's
 * target source filter and matches the echoed sequence itself.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { MissionSetCurrent } = require('../../lib/mission/set-current');
const { MISSION_TYPE } = require('../../lib/mission/types');
const { StubConnection, FakeTimers, fakeDeps } = require('./stubs/connection');

const TARGET = { sysid: 42, compid: 1 };

function machine(stub, clock, options = {}) {
  return new MissionSetCurrent({
    send: (message) => stub.send(message),
    subscribe: (filter, handler) => stub.subscribe(filter, handler),
    target: TARGET,
    missionType: MISSION_TYPE.MISSION,
    seq: 0,
    timeoutMs: 10,
    maxRetries: 2,
    ...fakeDeps(clock),
    ...options,
  });
}

test('set-current succeeds on a matching legacy MISSION_CURRENT echo', async () => {
  const stub = new StubConnection();
  const clock = new FakeTimers();
  stub.onSend((message, deliver) => {
    assert.deepEqual(message, {
      name: 'MISSION_SET_CURRENT',
      fields: { target_system: 42, target_component: 1, seq: 0 },
    });
    // A legacy decoded MISSION_CURRENT has only its core seq field. It has no
    // target_system, target_component, or mission_type to use as an ack gate.
    deliver({ name: 'MISSION_CURRENT', sysid: 42, compid: 1, fields: { seq: 0 } });
  });

  const outcome = await machine(stub, clock).start();

  assert.equal(outcome.result, 'succeeded');
  assert.equal(outcome.phase, 'done');
  assert.equal(outcome.seq, 0, 'zero is a valid echoed sequence');
  assert.deepEqual(stub.sentNames(), ['MISSION_SET_CURRENT']);
  assert.equal(stub.subscriberCount(), 0);
  assert.equal(clock.pending(), 0);
});

test('set-current ignores a MISSION_CURRENT from the wrong source', async () => {
  const stub = new StubConnection();
  const clock = new FakeTimers();
  stub.onSend((_message, deliver) => {
    assert.equal(
      deliver({ name: 'MISSION_CURRENT', sysid: 7, compid: 1, fields: { seq: 0 } }),
      0,
      'the target source filter rejects a different system'
    );
  });

  const done = machine(stub, clock).start();
  assert.equal(stub.subscriberCount(), 1);
  stub.inject({ name: 'MISSION_CURRENT', sysid: 42, compid: 1, fields: { seq: 0 } });
  const outcome = await done;

  assert.equal(outcome.result, 'succeeded');
  assert.equal(stub.sentNames().length, 1);
});

test('set-current ignores a matching-source MISSION_CURRENT for another sequence', async () => {
  const stub = new StubConnection();
  const clock = new FakeTimers();
  stub.onSend((_message, deliver) => {
    deliver({ name: 'MISSION_CURRENT', sysid: 42, compid: 1, fields: { seq: 1 } });
  });

  const done = machine(stub, clock).start();
  assert.equal(stub.subscriberCount(), 1);
  stub.inject({ name: 'MISSION_CURRENT', sysid: 42, compid: 1, fields: { seq: 0 } });
  const outcome = await done;

  assert.equal(outcome.result, 'succeeded');
  assert.equal(stub.sentNames().length, 1);
});

test('set-current retries the request then aborts at the retry ceiling', async () => {
  const stub = new StubConnection();
  const clock = new FakeTimers();
  stub.onSend(() => {});

  const done = machine(stub, clock).start();
  clock.flush();
  const outcome = await done;

  assert.equal(outcome.result, 'failed');
  assert.equal(outcome.phase, 'aborted');
  assert.equal(outcome.seq, 0);
  assert.match(outcome.reason, /stalled at set-current after 2 retries/);
  assert.equal(stub.sentNames().filter((name) => name === 'MISSION_SET_CURRENT').length, 3);
  assert.equal(clock.pending(), 0);
});

test('set-current cancellation settles without sending MISSION_ACK', async () => {
  const stub = new StubConnection();
  const clock = new FakeTimers();
  stub.onSend(() => {});

  const current = machine(stub, clock);
  const done = current.start();
  current.cancel();
  const outcome = await done;

  assert.equal(outcome.result, 'cancelled');
  assert.equal(outcome.phase, 'cancelled');
  assert.deepEqual(stub.sentNames(), ['MISSION_SET_CURRENT']);
  assert.equal(stub.subscriberCount(), 0);
  assert.equal(clock.pending(), 0);
});

test('set-current accepts an addressless echo with source attribution enabled', async () => {
  const stub = new StubConnection();
  stub._sourceIds = { sysid: 255, compid: 190 };
  const clock = new FakeTimers();
  stub.onSend((_message, deliver) => {
    deliver({ name: 'MISSION_CURRENT', sysid: 42, compid: 1, fields: { seq: 0 } });
  });

  const outcome = await machine(stub, clock, { sourceIds: stub._sourceIds }).start();

  assert.equal(outcome.result, 'succeeded');
});
