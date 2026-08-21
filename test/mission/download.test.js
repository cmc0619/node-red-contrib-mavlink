'use strict';

/**
 * Mission download state-machine tests (DESIGN.md §9 "Download", §13). Covers
 * the happy path with N items, the count-zero short-circuit, mission_type
 * mismatch rejection, error-ack handling at any phase (§14), and the one-shot
 * legacy request fallback. Fixtures only — a scripted stub plays the vehicle
 * side.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { MissionDownload, MISSION_TYPE, MAV_MISSION_RESULT, buildItemInt } = require('../../lib/mission');
const { StubConnection, FakeTimers, fakeDeps } = require('./stubs/connection');

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
  // An INT-speaking vehicle never sees the legacy request form.
  assert.equal(stub.sentNames().includes('MISSION_REQUEST'), false);
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

test('a duplicate MISSION_COUNT mid-walk is ignored — no restart, no truncation (§9)', async () => {
  const stub = new StubConnection();
  stub.onSend((message, deliver) => {
    if (message.name === 'MISSION_REQUEST_LIST') {
      deliver({ name: 'MISSION_COUNT', fields: { count: 3, mission_type: 0 } });
      return;
    }
    if (message.name === 'MISSION_REQUEST_INT') {
      const seq = message.fields.seq;
      if (seq === 1) {
        // Retransmitted count mid-walk (the vehicle resends it for every
        // duplicated MISSION_REQUEST_LIST). Restarting from it would discard
        // progress and reset the retry ceiling; a smaller stale count would
        // truncate the mission while reporting success.
        deliver({ name: 'MISSION_COUNT', fields: { count: 2, mission_type: 0 } });
      }
      deliver({
        name: 'MISSION_ITEM_INT',
        fields: { seq, command: 16, x: seq, y: seq, z: 10, mission_type: 0 },
      });
    }
  });

  const outcome = await new MissionDownload(machineOpts(stub)).start();

  assert.equal(outcome.result, 'succeeded');
  // The original count (3) governed the walk; the stale count (2) changed nothing.
  assert.equal(outcome.count, 3);
  assert.equal(outcome.items.length, 3);
  assert.deepEqual(outcome.items.map((i) => i.seq), [0, 1, 2]);
  // Each sequence was requested exactly once — no restart from zero.
  const requested = stub.sent
    .filter((s) => s.message.name === 'MISSION_REQUEST_INT')
    .map((s) => s.message.fields.seq);
  assert.deepEqual(requested, [0, 1, 2]);
});

test('a mid-download error MISSION_ACK fails immediately with its result code (§14)', async () => {
  const stub = new StubConnection();
  let laterRequests = 0;
  stub.onSend((message, deliver) => {
    if (message.name === 'MISSION_REQUEST_LIST') {
      deliver({ name: 'MISSION_COUNT', fields: { count: 2, mission_type: 0 } });
    } else if (message.name === 'MISSION_REQUEST_INT') {
      const seq = message.fields.seq;
      if (seq === 0) {
        deliver({ name: 'MISSION_ITEM_INT', fields: { seq, command: 16, mission_type: 0 } });
      } else {
        // The vehicle abandons the transfer mid-walk. Its only channel for the
        // reason is an error MISSION_ACK — gating it on phase discarded the
        // code and stalled through the retry ceiling (§14 "An early error
        // MISSION_ACK is the rejection"; download mirrors upload).
        laterRequests += 1;
        deliver({ name: 'MISSION_ACK', fields: { type: MAV_MISSION_RESULT.DENIED, mission_type: 0 } });
      }
    }
  });

  const outcome = await new MissionDownload(machineOpts(stub)).start();

  assert.equal(outcome.result, 'failed');
  assert.equal(outcome.resultCode, MAV_MISSION_RESULT.DENIED);
  assert.match(outcome.reason, /DENIED/);
  // The ack ended the transfer on the spot — no retries of the refused step.
  assert.equal(laterRequests, 1);
});

test('a mid-download INVALID_SEQUENCE ack is dropped and the walk completes (upload exemption mirrored)', async () => {
  const stub = new StubConnection();
  stub.onSend((message, deliver) => {
    if (message.name === 'MISSION_REQUEST_LIST') {
      deliver({ name: 'MISSION_COUNT', fields: { count: 2, mission_type: 0 } });
    } else if (message.name === 'MISSION_REQUEST_INT') {
      const seq = message.fields.seq;
      if (seq === 0) {
        // ArduPilot emits INVALID_SEQUENCE mid-transfer for a duplicated
        // request while keeping the transfer alive — non-terminal.
        deliver({ name: 'MISSION_ACK', fields: { type: MAV_MISSION_RESULT.INVALID_SEQUENCE, mission_type: 0 } });
      }
      deliver({ name: 'MISSION_ITEM_INT', fields: { seq, command: 16, mission_type: 0 } });
    }
  });

  const outcome = await new MissionDownload(machineOpts(stub)).start();

  assert.equal(outcome.result, 'succeeded');
  assert.equal(outcome.items.length, 2);
});

test('a stray vehicle ACCEPTED ack mid-download is ignored — the closing ack is ours to send', async () => {
  const stub = new StubConnection();
  stub.onSend((message, deliver) => {
    if (message.name === 'MISSION_REQUEST_LIST') {
      deliver({ name: 'MISSION_COUNT', fields: { count: 2, mission_type: 0 } });
    } else if (message.name === 'MISSION_REQUEST_INT') {
      const seq = message.fields.seq;
      if (seq === 0) {
        // ACCEPTED from the vehicle is never a download's answer: it cannot
        // fake a success (we settle on our own closing ack), so treating it
        // as terminal could only abort a healthy walk.
        deliver({ name: 'MISSION_ACK', fields: { type: MAV_MISSION_RESULT.ACCEPTED, mission_type: 0 } });
      }
      deliver({ name: 'MISSION_ITEM_INT', fields: { seq, command: 16, mission_type: 0 } });
    }
  });

  const outcome = await new MissionDownload(machineOpts(stub)).start();

  assert.equal(outcome.result, 'succeeded');
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

test('a pre-INT vehicle: the first item step falls back once to legacy MISSION_REQUEST and sticks', async () => {
  const stub = new StubConnection();
  const clock = new FakeTimers();
  const maxRetries = 2;
  stub.onSend((message, deliver) => {
    if (message.name === 'MISSION_REQUEST_LIST') {
      // A pre-INT autopilot answers the list request but ignores
      // MISSION_REQUEST_INT entirely — only the legacy form gets items.
      deliver({ name: 'MISSION_COUNT', fields: { count: 2, mission_type: 0 } });
    } else if (message.name === 'MISSION_REQUEST') {
      const seq = message.fields.seq;
      deliver({ name: 'MISSION_ITEM', fields: { seq, command: 16, x: seq, y: seq, mission_type: 0 } });
    }
  });

  const machine = new MissionDownload(machineOpts(stub, { maxRetries, timeoutMs: 1000, ...fakeDeps(clock) }));
  const done = machine.start();
  clock.flush();
  const outcome = await done;

  assert.equal(outcome.result, 'succeeded');
  assert.equal(outcome.items.length, 2);
  // INT tried to its ceiling (1 + maxRetries sends of seq 0), then legacy —
  // and the rest of the walk stays legacy.
  const intSeqs = stub.sent
    .filter((s) => s.message.name === 'MISSION_REQUEST_INT')
    .map((s) => s.message.fields.seq);
  const legacySeqs = stub.sent
    .filter((s) => s.message.name === 'MISSION_REQUEST')
    .map((s) => s.message.fields.seq);
  assert.deepEqual(intSeqs, [0, 0, 0]);
  assert.deepEqual(legacySeqs, [0, 1]);
});

test('no fallback once an INT request was answered — a later stall aborts naming the sequence', async () => {
  const stub = new StubConnection();
  const clock = new FakeTimers();
  stub.onSend((message, deliver) => {
    if (message.name === 'MISSION_REQUEST_LIST') {
      deliver({ name: 'MISSION_COUNT', fields: { count: 2, mission_type: 0 } });
    } else if (message.name === 'MISSION_REQUEST_INT' && message.fields.seq === 0) {
      // Item 0 arrives over INT — the vehicle speaks INT; item 1 never comes.
      deliver({ name: 'MISSION_ITEM_INT', fields: { seq: 0, command: 16, mission_type: 0 } });
    }
  });

  const machine = new MissionDownload(machineOpts(stub, { maxRetries: 2, timeoutMs: 1000, ...fakeDeps(clock) }));
  const done = machine.start();
  clock.flush();
  const outcome = await done;

  assert.equal(outcome.result, 'failed');
  assert.equal(outcome.phase, 'aborted');
  assert.equal(outcome.seq, 1);
  assert.equal(stub.sentNames().includes('MISSION_REQUEST'), false, 'silence mid-walk is not a carrier problem');
});

test('cancelling a mid-flight download sends MISSION_ACK OPERATION_CANCELLED before settling (#261)', async () => {
  const stub = new StubConnection();
  stub.onSend((message, deliver) => {
    if (message.name === 'MISSION_REQUEST_LIST') {
      deliver({ name: 'MISSION_COUNT', fields: { count: 3, mission_type: 0 } });
    }
    // The vehicle never answers the item request — the download is mid-flight
    // when the operator cancels.
  });

  const machine = new MissionDownload(machineOpts(stub));
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

test('a cancel whose ack send throws (dead link) still settles cancelled — best-effort (#261)', async () => {
  const stub = new StubConnection();
  let dead = false;
  stub.onSend((message, deliver) => {
    if (message.name === 'MISSION_REQUEST_LIST') {
      deliver({ name: 'MISSION_COUNT', fields: { count: 3, mission_type: 0 } });
    }
  });

  const machine = new MissionDownload({
    ...machineOpts(stub),
    send: (m) => {
      if (dead) throw new Error('link is gone');
      stub.send(m);
    },
  });
  const done = machine.start();
  dead = true;
  machine.cancel();
  const outcome = await done;

  assert.equal(outcome.result, 'cancelled', 'a teardown-path throw never escapes cancel');
});

test('the subscription filters to the download messages — target telemetry never reaches the machine', async () => {
  const stub = new StubConnection();
  const machine = new MissionDownload(machineOpts(stub));
  const done = machine.start();

  assert.equal(stub.subscriberCount(), 4, 'one subscription per handled name');
  // The target's telemetry stream (HEARTBEAT at frame rate) is filtered out
  // at the subscription, not copied in and discarded by the name switch.
  assert.equal(stub.inject({ name: 'HEARTBEAT', fields: {} }), 0);
  assert.equal(stub.inject({ name: 'MISSION_COUNT', fields: { count: 1, mission_type: 0 } }), 1);

  machine.cancel();
  await done;
  assert.equal(stub.subscriberCount(), 0, 'settlement tears every subscription down');
});
