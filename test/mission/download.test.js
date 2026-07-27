'use strict';

/**
 * Mission download state-machine tests (DESIGN.md §9 "Download", §13). Covers
 * the happy path with N items, the count-zero short-circuit, and mission_type
 * mismatch rejection. Fixtures only — a scripted stub plays the vehicle side.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { MissionDownload, MISSION_TYPE, MAV_MISSION_RESULT, buildItemInt } = require('../../lib/mission');
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

test('a MISSION_ACK arriving mid-download (after the count) is ignored, not an abort (§9)', async () => {
  const stub = new StubConnection();
  const count = 2;
  stub.onSend((message, deliver) => {
    if (message.name === 'MISSION_REQUEST_LIST') {
      deliver({ name: 'MISSION_COUNT', fields: { count, mission_type: 0 } });
    } else if (message.name === 'MISSION_REQUEST_INT') {
      const seq = message.fields.seq;
      if (seq === 0) {
        // A stray/duplicate MISSION_ACK once items are already flowing is stale
        // (only the ack *we* send closes a download). It must not abort.
        deliver({ name: 'MISSION_ACK', fields: { type: MAV_MISSION_RESULT.ERROR, mission_type: 0 } });
      }
      deliver({ name: 'MISSION_ITEM_INT', fields: { seq, command: 16, mission_type: 0 } });
    }
  });

  const outcome = await new MissionDownload(machineOpts(stub)).start();

  assert.equal(outcome.result, 'succeeded');
  assert.equal(outcome.count, 2);
  assert.equal(outcome.items.length, 2);
});

test('an early MISSION_ACK before the count is still an abort (vehicle refuses the request)', async () => {
  const stub = new StubConnection();
  stub.onSend((message, deliver) => {
    if (message.name === 'MISSION_REQUEST_LIST') {
      // The vehicle refuses the download outright, before any MISSION_COUNT.
      deliver({ name: 'MISSION_ACK', fields: { type: MAV_MISSION_RESULT.UNSUPPORTED, mission_type: 0 } });
    }
  });

  const outcome = await new MissionDownload(machineOpts(stub)).start();

  assert.equal(outcome.result, 'failed');
  assert.equal(outcome.resultCode, MAV_MISSION_RESULT.UNSUPPORTED);
});

test('MISSION_ITEM_INT global lat/lon are normalized to degrees, so a round-trip does not double-scale (§9)', async () => {
  const stub = new StubConnection();
  const latE7 = Math.round(47.397742 * 1e7);
  const lonE7 = Math.round(8.545594 * 1e7);
  stub.onSend((message, deliver) => {
    if (message.name === 'MISSION_REQUEST_LIST') {
      deliver({ name: 'MISSION_COUNT', fields: { count: 1, mission_type: 0 } });
    } else if (message.name === 'MISSION_REQUEST_INT') {
      deliver({
        name: 'MISSION_ITEM_INT',
        fields: { seq: 0, frame: 3, command: 16, x: latE7, y: lonE7, z: 25, mission_type: 0 },
      });
    }
  });

  const outcome = await new MissionDownload(machineOpts(stub)).start();
  const item = outcome.items[0];

  assert.ok(Math.abs(item.x - 47.397742) < 1e-6, 'lat restored to float degrees');
  assert.ok(Math.abs(item.y - 8.545594) < 1e-6, 'lon restored to float degrees');
  assert.equal(item.z, 25, 'altitude passes through unscaled');

  // Re-encoding the canonical item reproduces the original wire integers.
  const rebuilt = buildItemInt(item, TARGET, 0, 0);
  assert.equal(rebuilt.fields.x, latE7);
  assert.equal(rebuilt.fields.y, lonE7);
});

test('non-global-frame MISSION_ITEM_INT x/y (metres) pass through unscaled', async () => {
  const stub = new StubConnection();
  stub.onSend((message, deliver) => {
    if (message.name === 'MISSION_REQUEST_LIST') {
      deliver({ name: 'MISSION_COUNT', fields: { count: 1, mission_type: 0 } });
    } else if (message.name === 'MISSION_REQUEST_INT') {
      // frame 1 = LOCAL_NED — x/y are metres, not degE7.
      deliver({
        name: 'MISSION_ITEM_INT',
        fields: { seq: 0, frame: 1, command: 16, x: 12, y: -7, z: 5, mission_type: 0 },
      });
    }
  });

  const outcome = await new MissionDownload(machineOpts(stub)).start();
  assert.equal(outcome.items[0].x, 12);
  assert.equal(outcome.items[0].y, -7);
});
