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


test('setpoint send emits result "sent" — shared word, shared meaning with mavlink-command\'s send tier', async () => {
  const c = conn();
  const node = makeNode({ ...setpointCfg, delivery: 'send', connection: 'conn' }, { conn: c });
  const { out, err } = await drive(node, { position: { north: 1, east: 2, up: 3 } });
  assert.equal(err, undefined);
  assert.equal(c.sends.length, 1);
  assert.equal(out[0][0].payload.result, 'sent');
  assert.equal(out[0][1].result, 'sent');
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





// ── The ban ──────────────────────────────────────────────────────────────────

