'use strict';

/**
 * Mission upload state-machine tests (DESIGN.md §9 "Upload", §13). Covers the
 * vehicle-driven order (out-of-order and re-requested items), carrier-format
 * matching (MISSION_REQUEST_INT → MISSION_ITEM_INT, never MISSION_ITEM), and
 * the rule that a failed upload fails without degrading into a clear.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { MissionUpload } = require('../../lib/mission/upload');
const { MISSION_TYPE, MAV_MISSION_RESULT } = require('../../lib/mission/types');
const { StubConnection } = require('./stubs/connection');

const TARGET = { sysid: 1, compid: 1 };

function makeItems(n) {
  return Array.from({ length: n }, (_v, seq) => ({
    frame: 3,
    command: 16,
    param1: seq,
    x: 10 + seq,
    y: 20 + seq,
    z: 30 + seq,
  }));
}

function uploadOpts(stub, items, extra) {
  return {
    send: (m) => stub.send(m),
    subscribe: (f, h) => stub.subscribe(f, h),
    target: TARGET,
    missionType: MISSION_TYPE.MISSION,
    items,
    ...extra,
  };
}

/** Names of item-carrier messages actually sent, in order, with their seq. */
function itemSends(stub) {
  return stub.sent
    .filter((s) => s.message.name === 'MISSION_ITEM_INT' || s.message.name === 'MISSION_ITEM')
    .map((s) => ({ name: s.message.name, seq: s.message.fields.seq }));
}

test('upload answers whatever sequence the vehicle asks, including re-requests', async () => {
  const stub = new StubConnection();
  const items = makeItems(3);
  const answered = [];

  stub.onSend((message, deliver) => {
    if (message.name === 'MISSION_COUNT') {
      deliver({ name: 'MISSION_REQUEST_INT', fields: { seq: 2, mission_type: 0 } });
      return;
    }
    if (message.name === 'MISSION_ITEM_INT') {
      answered.push(message.fields.seq);
      // Vehicle order: 2, then 0, re-request 0, then 1, then ack.
      const next = { 1: 0, 2: 0, 3: 1 }[answered.length];
      if (next !== undefined) {
        deliver({ name: 'MISSION_REQUEST_INT', fields: { seq: next, mission_type: 0 } });
      } else {
        deliver({ name: 'MISSION_ACK', fields: { type: MAV_MISSION_RESULT.ACCEPTED, mission_type: 0 } });
      }
    }
  });

  const outcome = await new MissionUpload(uploadOpts(stub, items)).start();

  assert.equal(outcome.result, 'succeeded');
  assert.equal(outcome.count, 3);
  // Answered exactly what was asked, in the vehicle's order (with a re-request).
  assert.deepEqual(itemSends(stub).map((s) => s.seq), [2, 0, 0, 1]);
  assert.equal(stub.sentNames()[0], 'MISSION_COUNT');
});

test('MISSION_REQUEST_INT is answered with MISSION_ITEM_INT', async () => {
  const stub = new StubConnection();
  stub.onSend((message, deliver) => {
    if (message.name === 'MISSION_COUNT') {
      deliver({ name: 'MISSION_REQUEST_INT', fields: { seq: 0, mission_type: 0 } });
    } else if (message.name === 'MISSION_ITEM_INT') {
      deliver({ name: 'MISSION_ACK', fields: { type: 0, mission_type: 0 } });
    }
  });

  const outcome = await new MissionUpload(uploadOpts(stub, makeItems(1))).start();

  assert.equal(outcome.result, 'succeeded');
  const sends = itemSends(stub);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].name, 'MISSION_ITEM_INT');
  assert.equal(stub.sent.some((s) => s.message.name === 'MISSION_ITEM'), false);
});

test('legacy MISSION_REQUEST is answered with MISSION_ITEM (not the INT form)', async () => {
  const stub = new StubConnection();
  stub.onSend((message, deliver) => {
    if (message.name === 'MISSION_COUNT') {
      deliver({ name: 'MISSION_REQUEST', fields: { seq: 0, mission_type: 0 } });
    } else if (message.name === 'MISSION_ITEM') {
      deliver({ name: 'MISSION_ACK', fields: { type: 0, mission_type: 0 } });
    }
  });

  const outcome = await new MissionUpload(uploadOpts(stub, makeItems(1))).start();

  assert.equal(outcome.result, 'succeeded');
  const sends = itemSends(stub);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].name, 'MISSION_ITEM');
  assert.equal(stub.sent.some((s) => s.message.name === 'MISSION_ITEM_INT'), false);
});

test('a rejected upload fails and never sends MISSION_CLEAR_ALL', async () => {
  const stub = new StubConnection();
  stub.onSend((message, deliver) => {
    if (message.name === 'MISSION_COUNT') {
      deliver({ name: 'MISSION_REQUEST_INT', fields: { seq: 0, mission_type: 0 } });
    } else if (message.name === 'MISSION_ITEM_INT') {
      // Vehicle refuses the plan.
      deliver({ name: 'MISSION_ACK', fields: { type: MAV_MISSION_RESULT.NO_SPACE, mission_type: 0 } });
    }
  });

  const outcome = await new MissionUpload(uploadOpts(stub, makeItems(1))).start();

  assert.equal(outcome.result, 'failed');
  assert.equal(outcome.resultCode, MAV_MISSION_RESULT.NO_SPACE);
  assert.match(outcome.reason, /NO_SPACE/);
  assert.equal(stub.sentNames().includes('MISSION_CLEAR_ALL'), false);
});

test('a premature ACCEPTED before items are delivered fails as a protocol error, never a phantom success (§9)', async () => {
  const stub = new StubConnection();
  const items = makeItems(2);

  stub.onSend((message, deliver) => {
    if (message.name === 'MISSION_COUNT') {
      // ACCEPTED before the vehicle requested a single item: the vehicle
      // cannot be holding the mission it just "accepted". MAVSDK settles
      // ProtocolError, QGC VehicleAckError — a failure either way, and
      // never a silent ignore (an ignored ack would stall into the retry
      // ceiling with the real signal discarded).
      deliver({ name: 'MISSION_ACK', fields: { type: MAV_MISSION_RESULT.ACCEPTED, mission_type: 0 } });
    }
  });

  const outcome = await new MissionUpload(uploadOpts(stub, items)).start();

  assert.equal(outcome.result, 'failed');
  assert.match(outcome.reason, /protocol error/);
  assert.match(outcome.reason, /0 of 2/);
  // No item was ever delivered, and the failure must not degrade into a clear.
  assert.deepEqual(itemSends(stub), []);
  assert.equal(stub.sentNames().includes('MISSION_CLEAR_ALL'), false);
});

test('an early error ACK right after MISSION_COUNT fails immediately with the vehicle\'s code (§9)', async () => {
  const stub = new StubConnection();
  const items = makeItems(2);

  stub.onSend((message, deliver) => {
    if (message.name === 'MISSION_COUNT') {
      // ArduPilot's MissionItemProtocol answers an oversized count with
      // NO_SPACE before requesting any item — this is the vehicle's only
      // channel for that rejection, not a stale leftover. It must surface
      // now, with the code, instead of stalling through count retries.
      deliver({ name: 'MISSION_ACK', fields: { type: MAV_MISSION_RESULT.NO_SPACE, mission_type: 0 } });
    }
  });

  const outcome = await new MissionUpload(uploadOpts(stub, items)).start();

  assert.equal(outcome.result, 'failed');
  assert.equal(outcome.resultCode, MAV_MISSION_RESULT.NO_SPACE);
  assert.match(outcome.reason, /NO_SPACE/);
  // Exactly one count was sent — no retry burn against a vehicle that said no.
  assert.equal(stub.sentNames().filter((n) => n === 'MISSION_COUNT').length, 1);
  assert.deepEqual(itemSends(stub), []);
  assert.equal(stub.sentNames().includes('MISSION_CLEAR_ALL'), false);
});

test('a mid-transfer INVALID_SEQUENCE ack is dropped and the upload completes (ArduPilot lossy-link noise, §9)', async () => {
  const stub = new StubConnection();
  const items = makeItems(2);

  stub.onSend((message, deliver) => {
    if (message.name === 'MISSION_COUNT') {
      deliver({ name: 'MISSION_REQUEST_INT', fields: { seq: 0, mission_type: 0 } });
      return;
    }
    if (message.name === 'MISSION_ITEM_INT') {
      const seq = message.fields.seq;
      if (seq === 0) {
        // ArduPilot acks a duplicated/reordered item with INVALID_SEQUENCE
        // while keeping the transfer alive and re-requesting — non-terminal.
        deliver({ name: 'MISSION_ACK', fields: { type: MAV_MISSION_RESULT.INVALID_SEQUENCE, mission_type: 0 } });
        deliver({ name: 'MISSION_REQUEST_INT', fields: { seq: 1, mission_type: 0 } });
      } else {
        deliver({ name: 'MISSION_ACK', fields: { type: MAV_MISSION_RESULT.ACCEPTED, mission_type: 0 } });
      }
    }
  });

  const outcome = await new MissionUpload(uploadOpts(stub, items)).start();

  assert.equal(outcome.result, 'succeeded');
  assert.equal(outcome.count, 2);
  assert.deepEqual(itemSends(stub).map((s) => s.seq), [0, 1]);
});

test('global-frame item x/y are scaled to degE7 in the INT carrier (§9 coordinate frames)', () => {
  const { buildItemInt } = require('../../lib/mission/items');
  const msg = buildItemInt({ frame: 3, command: 16, x: 47.397742, y: 8.545594, z: 25 }, TARGET, 0, 0);
  assert.equal(msg.name, 'MISSION_ITEM_INT');
  assert.equal(msg.fields.x, Math.round(47.397742 * 1e7));
  assert.equal(msg.fields.y, Math.round(8.545594 * 1e7));
  // z (altitude) stays a float.
  assert.equal(msg.fields.z, 25);
});

test('cancelling a mid-flight upload sends MISSION_ACK OPERATION_CANCELLED before settling (#261)', async () => {
  const stub = new StubConnection();
  stub.onSend((message, deliver) => {
    if (message.name === 'MISSION_COUNT') {
      deliver({ name: 'MISSION_REQUEST_INT', fields: { seq: 0, mission_type: 0 } });
    }
    // The vehicle never requests further items — the upload is mid-flight
    // when the operator cancels.
  });

  const machine = new MissionUpload(uploadOpts(stub, makeItems(3)));
  const done = machine.start();
  machine.cancel();
  const outcome = await done;

  assert.equal(outcome.result, 'cancelled');
  assert.equal(outcome.phase, 'cancelled');
  const acks = stub.sent.filter((s) => s.message.name === 'MISSION_ACK');
  assert.equal(acks.length, 1, 'the cancel notified the wire');
  assert.equal(acks[0].message.fields.type, MAV_MISSION_RESULT.OPERATION_CANCELLED);
  assert.equal(acks[0].message.fields.target_system, TARGET.sysid);
  assert.equal(acks[0].message.fields.target_component, TARGET.compid);
  assert.equal(acks[0].message.fields.mission_type, MISSION_TYPE.MISSION);
  assert.equal(stub.subscriberCount(), 0, 'cancel still tears the subscription down');
});

test('the subscription filters to the upload messages — target telemetry never reaches the machine', async () => {
  const stub = new StubConnection();
  const machine = new MissionUpload(uploadOpts(stub, makeItems(1)));
  const done = machine.start();

  assert.equal(stub.subscriberCount(), 3, 'one subscription per handled name');
  // The target's telemetry stream (HEARTBEAT at frame rate) is filtered out
  // at the subscription, not copied in and discarded by the name switch.
  assert.equal(stub.inject({ name: 'HEARTBEAT', fields: {} }), 0);
  assert.equal(stub.inject({ name: 'MISSION_REQUEST_INT', fields: { seq: 0, mission_type: 0 } }), 1);

  machine.cancel();
  await done;
  assert.equal(stub.subscriberCount(), 0, 'settlement tears every subscription down');
});
