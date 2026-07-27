'use strict';

/**
 * Mission download state-machine tests (DESIGN.md §9 "Download", §13). Covers
 * the happy path with N items, the count-zero short-circuit, and mission_type
 * mismatch rejection. Fixtures only — a scripted stub plays the vehicle side.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { MissionDownload, MISSION_TYPE } = require('../../lib/mission');
const { StubConnection } = require('./stubs/connection');

const TARGET = { sysid: 1, compid: 1 };

function machineOpts(stub, extra) {
  return {
    send: (m) => stub.send(m),
    subscribe: (f, h) => stub.subscribe(f, h),
    target: TARGET,
    missionType: MISSION_TYPE.MISSION,
    ...extra,
  };
}

test('download requests each item by sequence and acks (happy path, N items)', async () => {
  const stub = new StubConnection();
  const count = 3;
  stub.onSend((message, deliver) => {
    if (message.name === 'MISSION_REQUEST_LIST') {
      deliver({ name: 'MISSION_COUNT', fields: { count, mission_type: 0 } });
    } else if (message.name === 'MISSION_REQUEST_INT') {
      const seq = message.fields.seq;
      deliver({
        name: 'MISSION_ITEM_INT',
        fields: { seq, command: 16, x: seq, y: seq, z: 10, mission_type: 0 },
      });
    }
  });

  const outcome = await new MissionDownload(machineOpts(stub)).start();

  assert.equal(outcome.result, 'succeeded');
  assert.equal(outcome.count, 3);
  assert.equal(outcome.items.length, 3);
  assert.deepEqual(outcome.items.map((i) => i.seq), [0, 1, 2]);
  // Opens with a list request, requests each item, closes with an ack.
  assert.equal(stub.sentNames()[0], 'MISSION_REQUEST_LIST');
  assert.equal(stub.sentNames().at(-1), 'MISSION_ACK');
  assert.equal(stub.sent.filter((s) => s.message.name === 'MISSION_REQUEST_INT').length, 3);
});

test('download with count zero acks immediately and waits for no items', async () => {
  const stub = new StubConnection();
  stub.onSend((message, deliver) => {
    if (message.name === 'MISSION_REQUEST_LIST') {
      deliver({ name: 'MISSION_COUNT', fields: { count: 0, mission_type: 0 } });
    }
  });

  const outcome = await new MissionDownload(machineOpts(stub)).start();

  assert.equal(outcome.result, 'succeeded');
  assert.equal(outcome.count, 0);
  assert.deepEqual(outcome.items, []);
  assert.deepEqual(stub.sentNames(), ['MISSION_REQUEST_LIST', 'MISSION_ACK']);
  // No item was ever requested.
  assert.equal(stub.sent.some((s) => s.message.name === 'MISSION_REQUEST_INT'), false);
});

test('download ignores replies whose mission_type mismatches', async () => {
  const stub = new StubConnection();
  let requestedItems = 0;
  stub.onSend((message, deliver) => {
    if (message.name === 'MISSION_REQUEST_LIST') {
      // A fence-typed count for a mission download is a mismatch, not a mission.
      deliver({ name: 'MISSION_COUNT', fields: { count: 5, mission_type: MISSION_TYPE.FENCE } });
      // The correct mission-typed count follows.
      deliver({ name: 'MISSION_COUNT', fields: { count: 1, mission_type: MISSION_TYPE.MISSION } });
    } else if (message.name === 'MISSION_REQUEST_INT') {
      requestedItems += 1;
      // A mismatched item is ignored; the matching one completes the download.
      deliver({ name: 'MISSION_ITEM', fields: { seq: 0, command: 16, mission_type: MISSION_TYPE.FENCE } });
      deliver({ name: 'MISSION_ITEM_INT', fields: { seq: 0, command: 16, mission_type: MISSION_TYPE.MISSION } });
    }
  });

  const outcome = await new MissionDownload(machineOpts(stub)).start();

  assert.equal(outcome.result, 'succeeded');
  // The fence count (5) was ignored; only the mission count (1) drove requests.
  assert.equal(outcome.count, 1);
  assert.equal(requestedItems, 1);
  assert.equal(outcome.items.length, 1);
});
