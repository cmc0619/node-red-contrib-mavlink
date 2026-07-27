'use strict';

/**
 * Mission upload state-machine tests (DESIGN.md §9 "Upload", §13). Covers the
 * vehicle-driven order (out-of-order and re-requested items), carrier-format
 * matching (MISSION_REQUEST_INT → MISSION_ITEM_INT, never MISSION_ITEM), and
 * the rule that a failed upload fails without degrading into a clear.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { MissionUpload, MISSION_TYPE, MAV_MISSION_RESULT } = require('../../lib/mission');
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

test('a premature/stale ACCEPTED before items are delivered is ignored, not a phantom success (§9)', async () => {
  const stub = new StubConnection();
  const items = makeItems(2);
  let sentAck = false;

  stub.onSend((message, deliver) => {
    if (message.name === 'MISSION_COUNT') {
      // A stale ACCEPTED (e.g. left over from a prior transfer) arrives before
      // the vehicle has requested a single item — it must not complete the
      // upload that never actually happened.
      deliver({ name: 'MISSION_ACK', fields: { type: MAV_MISSION_RESULT.ACCEPTED, mission_type: 0 } });
      deliver({ name: 'MISSION_REQUEST_INT', fields: { seq: 0, mission_type: 0 } });
      return;
    }
    if (message.name === 'MISSION_ITEM_INT') {
      const seq = message.fields.seq;
      if (seq === 0) {
        deliver({ name: 'MISSION_REQUEST_INT', fields: { seq: 1, mission_type: 0 } });
      } else if (!sentAck) {
        sentAck = true;
        deliver({ name: 'MISSION_ACK', fields: { type: MAV_MISSION_RESULT.ACCEPTED, mission_type: 0 } });
      }
    }
  });

  const outcome = await new MissionUpload(uploadOpts(stub, items)).start();

  assert.equal(outcome.result, 'succeeded');
  assert.equal(outcome.count, 2);
  // Both items were actually delivered before the real completion.
  assert.deepEqual(itemSends(stub).map((s) => s.seq), [0, 1]);
});

test('a stale rejection ACK before all items is ignored; a real one after delivery fails (§9)', async () => {
  const stub = new StubConnection();
  const items = makeItems(2);
  let sentFinal = false;

  stub.onSend((message, deliver) => {
    if (message.name === 'MISSION_COUNT') {
      // Stale DENIED from a prior transfer — must not abort this upload.
      deliver({ name: 'MISSION_ACK', fields: { type: MAV_MISSION_RESULT.INVALID, mission_type: 0 } });
      deliver({ name: 'MISSION_REQUEST_INT', fields: { seq: 0, mission_type: 0 } });
      return;
    }
    if (message.name === 'MISSION_ITEM_INT') {
      const seq = message.fields.seq;
      if (seq === 0) {
        deliver({ name: 'MISSION_REQUEST_INT', fields: { seq: 1, mission_type: 0 } });
      } else if (!sentFinal) {
        sentFinal = true;
        // After every item has been answered, a rejection is this transfer's.
        deliver({ name: 'MISSION_ACK', fields: { type: MAV_MISSION_RESULT.INVALID, mission_type: 0 } });
      }
    }
  });

  const outcome = await new MissionUpload(uploadOpts(stub, items)).start();

  assert.equal(outcome.result, 'failed');
  assert.equal(outcome.resultCode, MAV_MISSION_RESULT.INVALID);
  assert.deepEqual(itemSends(stub).map((s) => s.seq), [0, 1]);
});

test('global-frame item x/y are scaled to degE7 in the INT carrier (§9 coordinate frames)', () => {
  const { buildItemInt } = require('../../lib/mission');
  const msg = buildItemInt({ frame: 3, command: 16, x: 47.397742, y: 8.545594, z: 25 }, TARGET, 0, 0);
  assert.equal(msg.name, 'MISSION_ITEM_INT');
  assert.equal(msg.fields.x, Math.round(47.397742 * 1e7));
  assert.equal(msg.fields.y, Math.round(8.545594 * 1e7));
  // z (altitude) stays a float.
  assert.equal(msg.fields.z, 25);
});
