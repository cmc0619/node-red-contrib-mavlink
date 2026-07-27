'use strict';

/**
 * Mission clear state-machine tests (DESIGN.md §9 "Clear", §13). MISSION_CLEAR_ALL
 * → MISSION_ACK. A non-zero ack is a failure reported verbatim.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { MissionClear, MISSION_TYPE, MAV_MISSION_RESULT } = require('../../lib/mission');
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
