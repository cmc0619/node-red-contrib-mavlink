'use strict';

/**
 * Mission clear state-machine tests (DESIGN.md §9 "Clear", §13). MISSION_CLEAR_ALL
 * → MISSION_ACK. A non-zero ack is a failure reported verbatim.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { MissionClear } = require('../../lib/mission/clear');
const { MISSION_TYPE, MAV_MISSION_RESULT } = require('../../lib/mission/types');
const { StubConnection } = require('./stubs/connection');

const TARGET = { sysid: 1, compid: 1 };

function clearOpts(stub, extra) {
  return {
    send: (m) => stub.send(m),
    subscribe: (f, h) => stub.subscribe(f, h),
    target: TARGET,
    missionType: MISSION_TYPE.FENCE,
    ...extra,
  };
}

test('clear sends MISSION_CLEAR_ALL and succeeds on an accepted ack', async () => {
  const stub = new StubConnection();
  stub.onSend((message, deliver) => {
    if (message.name === 'MISSION_CLEAR_ALL') {
      deliver({ name: 'MISSION_ACK', fields: { type: MAV_MISSION_RESULT.ACCEPTED, mission_type: MISSION_TYPE.FENCE } });
    }
  });

  const outcome = await new MissionClear(clearOpts(stub)).start();

  assert.equal(outcome.result, 'succeeded');
  assert.equal(outcome.phase, 'done');
  assert.deepEqual(stub.sentNames(), ['MISSION_CLEAR_ALL']);
  // The clear was typed to the fence plan.
  assert.equal(stub.sent[0].message.fields.mission_type, MISSION_TYPE.FENCE);
});

test('clear reports a non-zero ack as a failure', async () => {
  const stub = new StubConnection();
  stub.onSend((message, deliver) => {
    if (message.name === 'MISSION_CLEAR_ALL') {
      deliver({ name: 'MISSION_ACK', fields: { type: MAV_MISSION_RESULT.ERROR, mission_type: MISSION_TYPE.FENCE } });
    }
  });

  const outcome = await new MissionClear(clearOpts(stub)).start();

  assert.equal(outcome.result, 'failed');
  assert.equal(outcome.resultCode, MAV_MISSION_RESULT.ERROR);
});

test('clear ignores an ack for a different mission_type', async () => {
  const stub = new StubConnection();
  stub.onSend((message, deliver) => {
    if (message.name === 'MISSION_CLEAR_ALL') {
      // A mission-typed ack must not close a fence clear.
      deliver({ name: 'MISSION_ACK', fields: { type: 0, mission_type: MISSION_TYPE.MISSION } });
      // The correctly-typed ack does.
      deliver({ name: 'MISSION_ACK', fields: { type: 0, mission_type: MISSION_TYPE.FENCE } });
    }
  });

  const outcome = await new MissionClear(clearOpts(stub)).start();
  assert.equal(outcome.result, 'succeeded');
});

// ── Ack attribution and broadcast reply matching (mavlink-audit-20260905 #3, #8) ──

test('clear ignores an ack explicitly addressed to a different GCS on a shared link', async () => {
  const stub = new StubConnection();
  stub._sourceIds = { sysid: 255, compid: 190 }; // our own station
  stub.onSend((message, deliver) => {
    if (message.name === 'MISSION_CLEAR_ALL') {
      // Correctly sourced from the vehicle, correctly typed — but named for a
      // different ground station on the link.
      deliver({
        name: 'MISSION_ACK',
        fields: { type: MAV_MISSION_RESULT.ACCEPTED, mission_type: MISSION_TYPE.FENCE, target_system: 254, target_component: 190 },
      });
    }
  });

  const machine = new MissionClear(
    clearOpts(stub, { sourceIds: stub.resolveSourceIds(), timeoutMs: 10_000, maxRetries: 0 })
  );
  const outcome = await Promise.race([
    machine.start(),
    new Promise((resolve) => setTimeout(() => resolve('still-pending'), 20)),
  ]);
  assert.equal(outcome, 'still-pending', 'a reply addressed elsewhere must not settle our transfer');
  machine.cancel();
});

test('clear accepts an ack with no target fields (v1 / unaddressed) and one addressed to us', async () => {
  const stub = new StubConnection();
  stub._sourceIds = { sysid: 255, compid: 190 };
  stub.onSend((message, deliver) => {
    if (message.name === 'MISSION_CLEAR_ALL') {
      deliver({
        name: 'MISSION_ACK',
        fields: { type: MAV_MISSION_RESULT.ACCEPTED, mission_type: MISSION_TYPE.FENCE, target_system: 255, target_component: 190 },
      });
    }
  });

  const outcome = await new MissionClear(clearOpts(stub, { sourceIds: stub.resolveSourceIds() })).start();
  assert.equal(outcome.result, 'succeeded');
});

test('a broadcast clear (target sysid 0) still matches a real vehicle\'s reply', async () => {
  // 0 is a destination address, never a source — filtering the reply's
  // source to sysid 0 would never match any real vehicle's ack.
  const stub = new StubConnection();
  stub.onSend((message, deliver) => {
    if (message.name === 'MISSION_CLEAR_ALL') {
      deliver({
        name: 'MISSION_ACK',
        fields: { type: MAV_MISSION_RESULT.ACCEPTED, mission_type: MISSION_TYPE.FENCE },
        sysid: 1,
        compid: 1,
      });
    }
  });

  const outcome = await new MissionClear(clearOpts(stub, { target: { sysid: 0, compid: 0 } })).start();
  assert.equal(outcome.result, 'succeeded');
});
