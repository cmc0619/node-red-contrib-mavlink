'use strict';

/**
 * mavlink-mission node tests (DESIGN.md §9 chain model, §6, §13). Exercises the
 * thin wrapper: the suppress/refuse guards, the Build tier plan, the clear
 * confirmation gate, firmware gating at the node, and an end-to-end download
 * whose progress and terminal records land on output 1 while success fires
 * output 0.
 */

const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');

const { makeStatusRecord, isStatusRecord } = require('../../lib/delivery');
const { StubConnection } = require('./stubs/connection');

/** Load the node type against a fresh RED stub with the given connection node. */
function loadNode(connNode) {
  const RED = {
    nodes: {
      types: {},
      createNode(node, config) {
        Object.setPrototypeOf(node, EventEmitter.prototype);
        EventEmitter.call(node);
        node.id = config.id || 'mission-node';
        node.status = () => {};
        node.error = () => {};
        node.send = () => {};
        node.log = () => {};
        node.warn = () => {};
      },
      registerType(name, ctor) {
        this.types[name] = ctor;
      },
      getNode(id) {
        return id === 'conn' ? connNode : undefined;
      },
    },
  };
  require('../../nodes/mavlink-mission')(RED);
  return RED.nodes.types['mavlink-mission'];
}

/** Fire one input and resolve with every emitted output once `done` is called. */
function runInput(node, msg) {
  return new Promise((resolve) => {
    const outputs = [];
    node.emit(
      'input',
      msg,
      (m) => outputs.push(m),
      (err) => resolve({ outputs, err })
    );
  });
}

test('payload === false suppresses: no output, no error', async () => {
  const Node = loadNode(new StubConnection());
  const node = new Node({ operation: 'download', connection: 'conn', delivery: 'confirm' });
  const { outputs } = await runInput(node, { payload: false });
  assert.equal(outputs.length, 0);
});

test('a status record on input is refused, not acted on', async () => {
  const Node = loadNode(new StubConnection());
  const node = new Node({ operation: 'download', connection: 'conn', delivery: 'confirm' });
  const { outputs } = await runInput(node, makeStatusRecord({ result: 'accepted', payload: {} }));
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0][0], null, 'continue port stays silent');
  assert.equal(outputs[0][1].payload.result, 'refused');
});

test('Build tier emits the protocol plan on output 0 and sends nothing', async () => {
  const conn = new StubConnection();
  const Node = loadNode(conn);
  const node = new Node({ operation: 'download', connection: 'conn', delivery: 'build', missionType: 'mission' });
  const { outputs } = await runInput(node, { payload: {} });

  assert.equal(outputs.length, 1);
  const plan = outputs[0][0].payload;
  assert.equal(plan.operation, 'download');
  assert.deepEqual(plan.messages.map((m) => m.name), ['MISSION_REQUEST_LIST']);
  assert.equal(conn.sent.length, 0, 'Build sends nothing');
  assert.equal(isStatusRecord(outputs[0][1].payload), true);
});

test('firmware gating: PX4 refuses a fence transfer at the node (§11)', async () => {
  const Node = loadNode(new StubConnection());
  const node = new Node({
    operation: 'download',
    connection: 'conn',
    delivery: 'confirm',
    firmware: 'px4',
    missionType: 'fence',
  });
  const { outputs } = await runInput(node, { payload: {} });
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0][0], null);
  assert.equal(outputs[0][1].payload.phase, 'gated');
});

test('clear is refused without confirmation and runs once confirmed', async () => {
  const conn = new StubConnection();
  conn.onSend((message, deliver) => {
    if (message.name === 'MISSION_CLEAR_ALL') {
      deliver({ name: 'MISSION_ACK', fields: { type: 0, mission_type: 0 } });
    }
  });

  const Node = loadNode(conn);

  const unconfirmed = new Node({ operation: 'clear', connection: 'conn', delivery: 'confirm', confirmClear: false });
  let res = await runInput(unconfirmed, { payload: {} });
  assert.equal(res.outputs[0][0], null);
  assert.equal(res.outputs[0][1].payload.phase, 'unconfirmed');
  assert.equal(conn.sent.length, 0, 'nothing sent without confirmation');

  const confirmed = new Node({ operation: 'clear', connection: 'conn', delivery: 'confirm', confirmClear: true });
  res = await runInput(confirmed, { payload: {} });
  const last = res.outputs.at(-1);
  assert.equal(last[0].payload.result, 'succeeded', 'continue port fires on success');
  assert.equal(last[1].payload.result, 'succeeded');
  assert.equal(conn.sentNames().includes('MISSION_CLEAR_ALL'), true);
});

test('download end-to-end: progress on output 1, success on both ports', async () => {
  const conn = new StubConnection();
  conn.onSend((message, deliver) => {
    if (message.name === 'MISSION_REQUEST_LIST') {
      deliver({ name: 'MISSION_COUNT', fields: { count: 2, mission_type: 0 } });
    } else if (message.name === 'MISSION_REQUEST_INT') {
      const seq = message.fields.seq;
      deliver({ name: 'MISSION_ITEM_INT', fields: { seq, command: 16, mission_type: 0 } });
    }
  });

  const Node = loadNode(conn);
  const node = new Node({ operation: 'download', connection: 'conn', delivery: 'confirm', missionType: 'mission' });
  const { outputs } = await runInput(node, { payload: {} });

  // Every emitted item is a status record on output 1.
  for (const out of outputs) assert.equal(isStatusRecord(out[1].payload), true);

  // Progress records appeared before the terminal one.
  const progress = outputs.filter((o) => o[1].payload.result === 'progress');
  assert.ok(progress.length >= 2, 'phase/count progress emitted on output 1');

  const terminal = outputs.at(-1);
  assert.equal(terminal[0].payload.result, 'succeeded', 'continue port fires only on success');
  assert.equal(terminal[1].payload.result, 'succeeded');
  assert.equal(terminal[1].payload.count, 2);
});

test('a busy lock refuses a second same-type transfer on the node', async () => {
  const conn = new StubConnection();
  // First transfer never completes (no reply), so the lock stays held.
  conn.onSend(() => {});
  const Node = loadNode(conn);

  const first = new Node({ operation: 'download', connection: 'conn', delivery: 'confirm', missionType: 'mission', id: 'a' });
  const second = new Node({ operation: 'download', connection: 'conn', delivery: 'confirm', missionType: 'mission', id: 'b' });

  // Start the first (leaves the lock held; its promise never settles here).
  const firstOutputs = [];
  first.emit('input', { payload: {} }, (m) => firstOutputs.push(m), () => {});

  const { outputs } = await runInput(second, { payload: {} });
  assert.equal(outputs.at(-1)[1].payload.phase, 'locked');

  // Clean up the held lock so the shared registry does not leak into other tests.
  first.emit('close', () => {});
});
