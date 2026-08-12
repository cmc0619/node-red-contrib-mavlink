'use strict';

/**
 * The vocabulary pin: one node, one result vocabulary.
 *
 * No result word mavlink-move emits may carry two meanings, and the words it
 * shares with mavlink-command must mean the same thing there — the reposition
 * confirm path IS Command's AckWaiter, publishing its outcome verbatim.
 * 'succeeded' is banned from this node outright: it once meant both "on the
 * wire" (setpoints) and "the vehicle agreed" (reposition ACCEPTED), and that
 * double meaning is how SITL 27 could never pass while 30 measured silence as
 * success (#267, one carrier over).
 *
 * Every test drives the REAL node (stub-over-fiction lesson, #252/#267) and
 * pins the exact word per path. Every record any path emits is collected, and
 * the last test sweeps the collection for the banned word — so a new emitting
 * path added without a pin still cannot reintroduce 'succeeded' unnoticed.
 */

const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');
const { RESULT_NAME } = require('../../lib/command');

/** Every record seen by any drive in this file, for the final banned-word sweep. */
const allRecords = [];

function record(m) {
  if (m && m[1] && m[1].result !== undefined) allRecords.push(m[1]);
  if (m && m[0] && m[0].payload && m[0].payload.result !== undefined) allRecords.push(m[0].payload);
  return m;
}

function redStub(nodesById) {
  return {
    nodes: {
      types: {},
      createNode(node, config) {
        Object.setPrototypeOf(node, EventEmitter.prototype);
        EventEmitter.call(node);
        node.id = config.id || 'node';
        node.status = () => {};
        node.error = () => {};
        node.warn = () => {};
        node.send = (m) => record(m);
      },
      registerType(name, ctor) {
        this.types[name] = ctor;
      },
      getNode(id) {
        return nodesById[id];
      },
    },
  };
}

function makeNode(config, nodesById = {}) {
  const RED = redStub(nodesById);
  require('../../nodes/mavlink-move')(RED);
  const Node = RED.nodes.types['mavlink-move'];
  return new Node(config);
}

function conn() {
  const sends = [];
  const subs = [];
  return {
    id: 'conn',
    vehicle: {},
    sends,
    subs,
    send(message, opts) { sends.push({ message, opts }); },
    subscribe(filter, handler) { subs.push({ filter, handler }); return () => {}; },
    resolveSourceIds() { return { sysid: 255, compid: 190 }; },
  };
}

// Blank, not 0: a zero is a commanded value under the derived mask, and a
// placeholder 0 here would turn the velocity stream fixtures into
// position-velocity commanding the local origin (CodeRabbit, #277).
const setpointCfg = {
  action: 'steer', north: '', east: '', up: '', targetSystem: 5, targetComponent: 1,
};
const repositionCfg = {
  action: 'goto', altRef: 'home',
  lat: 47.1, lon: 8.5, alt: 25, targetSystem: 1, targetComponent: 1,
};

/** Drive one input; resolve on done() with everything the input emitted. */
function drive(node, payload) {
  return new Promise((resolve) => {
    const out = [];
    node.emit(
      'input',
      { payload },
      (m) => { out.push(record(m)); },
      (err) => resolve({ out, err })
    );
  });
}

// ── Silent paths: each word is its own outcome, nobody will answer ──────────

test('build emits result "built"', async () => {
  const node = makeNode({ ...setpointCfg, delivery: 'build', dialect: 'common' });
  const { out, err } = await drive(node, { position: { north: 1, east: 2, up: 3 } });
  assert.equal(err, undefined);
  assert.equal(out[0][1].result, 'built');
  assert.equal(out[0][1].detail, null);
});

test('setpoint send emits result "sent" — shared word, shared meaning with mavlink-command\'s send tier', async () => {
  const c = conn();
  const node = makeNode({ ...setpointCfg, delivery: 'send', connection: 'conn' }, { conn: c });
  const { out, err } = await drive(node, { position: { north: 1, east: 2, up: 3 } });
  assert.equal(err, undefined);
  assert.equal(c.sends.length, 1);
  assert.equal(out[0][0].payload.result, 'sent');
  assert.equal(out[0][1].result, 'sent');
});

test('reposition send tier emits result "sent" — same word as the setpoint send, same meaning', async () => {
  const c = conn();
  const node = makeNode({ ...repositionCfg, delivery: 'send', connection: 'conn' }, { conn: c });
  const { out, err } = await drive(node, {});
  assert.equal(err, undefined);
  assert.equal(c.sends[0].message.name, 'COMMAND_INT');
  assert.equal(out[0][1].result, 'sent');
});

test('stream lifecycle: "streaming", "stopped", "stopped"/"no stream", "expired"', async () => {
  const c = conn();
  const node = makeNode(
    { ...setpointCfg, vNorth: 1, vEast: 0, vUp: 0, delivery: 'stream', connection: 'conn', rateHz: 50, ttlMs: 0 },
    { conn: c }
  );
  const started = await drive(node, { velocity: { north: 1, east: 0, up: 0 } });
  assert.equal(started.err, undefined);
  assert.equal(started.out[0][1].result, 'streaming');
  assert.equal(started.out[0][1].detail, null);

  const stopped = await drive(node, { action: 'stop' });
  assert.equal(stopped.err, undefined);
  assert.equal(stopped.out[0][1].result, 'stopped');
  assert.equal(stopped.out[0][1].detail, null);

  const again = await drive(node, { action: 'stop' });
  assert.equal(again.err, undefined);
  assert.equal(again.out[0][1].result, 'stopped');
  assert.equal(again.out[0][1].detail, 'no stream', 'the second press is distinguished, not punished');

  // Expiry: restart with a TTL and let it lapse. The report rides node.send
  // (status port only) — captured by the stub's recorder.
  const expiring = makeNode(
    { ...setpointCfg, vNorth: 1, vEast: 0, vUp: 0, delivery: 'stream', connection: 'conn', rateHz: 50, ttlMs: 30 },
    { conn: c }
  );
  const seen = [];
  expiring.send = (m) => { record(m); if (m && m[1]) seen.push(m[1]); };
  await drive(expiring, { velocity: { north: 1, east: 0, up: 0 } });
  const deadline = Date.now() + 2000;
  while (!seen.some((r) => r.result === 'expired') && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expiring.emit('close', () => {});
  const expired = seen.find((r) => r.result === 'expired');
  assert.ok(expired, 'TTL expiry reported result "expired"');
  assert.equal(expired.detail, null);
  node.emit('close', () => {});
});

// ── Acked path: AckWaiter words verbatim — mavlink-command's vocabulary ─────

function feedAck(c, resultCode) {
  assert.equal(c.subs[0].filter.message, 'COMMAND_ACK');
  c.subs[0].handler({ sysid: 1, compid: 1, fields: { command: 192, result: resultCode } });
}

function driveConfirm(resultCode, cfg = {}) {
  const c = conn();
  const node = makeNode({ ...repositionCfg, delivery: 'confirm', connection: 'conn', ...cfg }, { conn: c });
  return new Promise((resolve) => {
    let out;
    node.emit(
      'input',
      { payload: {} },
      (m) => { out = record(m); },
      (err) => resolve({ out, err, node, c })
    );
    if (resultCode !== null) feedAck(c, resultCode);
  });
}

test('reposition ACCEPTED emits result "accepted" — never "succeeded"', async () => {
  const { out, err, node } = await driveConfirm(0);
  assert.equal(err, undefined);
  assert.ok(out[0], 'continue port fired');
  assert.equal(out[0].payload.result, 'accepted');
  assert.equal(out[1].result, 'accepted');
  assert.equal(out[1].resultCode, 0);
  assert.equal(out[1].confirmedBy, 'ack');
  node.emit('close', () => {});
});

test('reposition terminal refusals carry the MAV_RESULT name verbatim — the AckWaiter word IS the result', async () => {
  // DENIED (2): the word must be RESULT_NAME's, not a paraphrase — the pin
  // that keeps Move and Command from ever drifting apart again.
  const denied = await driveConfirm(2);
  assert.match(denied.err.message, /denied/);
  assert.equal(denied.out[0], null, 'no continue on a refusal');
  assert.equal(denied.out[1].result, RESULT_NAME[2]);
  assert.equal(denied.out[1].result, 'denied');
  assert.equal(denied.out[1].resultCode, 2);
  assert.equal(denied.out[1].confirmedBy, 'ack');
  denied.node.emit('close', () => {});

  // COMMAND_INT_ONLY (8): the same verbatim rule for the code Move can never
  // resolve by swapping (DO_REPOSITION is INT by construction).
  const intOnly = await driveConfirm(8);
  assert.equal(intOnly.out[1].result, RESULT_NAME[8]);
  assert.equal(intOnly.out[1].resultCode, 8);
  intOnly.node.emit('close', () => {});
});

test('reposition lost ack emits result "unconfirmed" (§9: a missing ack is not a failure)', async () => {
  const { out, err, node } = await driveConfirm(null, { ackTimeout: 25 });
  assert.match(err.message, /timed out waiting for COMMAND_ACK/);
  assert.equal(out[0], null);
  assert.equal(out[1].result, 'unconfirmed');
  assert.equal(out[1].resultCode, null);
  assert.equal(out[1].confirmedBy, 'none');
  node.emit('close', () => {});
});

test('a refusal before the wire is result "failed" — the one word for "nothing happened"', async () => {
  const c = conn();
  const node = makeNode({ ...repositionCfg, delivery: 'confirm', targetSystem: 0, connection: 'conn' }, { conn: c });
  const { out, err } = await drive(node, {});
  assert.match(err.message, /broadcast/);
  assert.equal(out[0][1].result, 'failed');
  assert.equal(out[0][1].resultCode, undefined, 'no ack, no code');
});

// ── The ban ──────────────────────────────────────────────────────────────────

test('no path in this file ever emitted the banned word', () => {
  assert.ok(allRecords.length >= 12, `the drives above populated the sweep (got ${allRecords.length})`);
  const banned = allRecords.filter((r) => r.result === 'succeeded');
  assert.deepEqual(banned, [], "'succeeded' is dead in mavlink-move — two meanings, zero uses");
});
