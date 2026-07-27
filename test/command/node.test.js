'use strict';

/**
 * mavlink-command node tests (DESIGN.md §9). Covers the review findings:
 *   - safety confirmation requires a strict boolean true (not a truthy token)
 *   - the status record is emitted as the top-level message on output 1 so the
 *     shared marker sits where isStatusRecord() looks, making a miswire refuse
 *   - the Build tier reports a 'built' status record on output 1
 *   - the async input handler contains throws/rejections as a terminal status
 *     plus done(err), never an unhandled rejection
 *
 * A minimal Node-RED stub drives the node constructor; no live runtime.
 */

const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');

const { isStatusRecord } = require('../../lib/command');

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('Build tier: output 0 carries the COMMAND_LONG and output 1 a top-level status record', async () => {
  const RED = redStub({});
  require('../../nodes/mavlink-command')(RED);
  const Node = RED.nodes.types['mavlink-command'];
  const node = new Node({ mode: 'preset', preset: 'arm', delivery: 'build' });

  let sent;
  node.emit('input', { payload: null }, (m) => { sent = m; }, () => {});
  await tick();

  assert.ok(sent, 'outputs fired');
  assert.equal(sent[0].payload.name, 'COMMAND_LONG');
  assert.ok(isStatusRecord(sent[1]), 'output 1 marker is on the message itself');
  assert.equal(sent[1].result, 'built');
});

test('Wiring output 1 back into the input is refused as a miswire, not executed', async () => {
  const RED = redStub({});
  require('../../nodes/mavlink-command')(RED);
  const Node = RED.nodes.types['mavlink-command'];
  const node = new Node({ mode: 'preset', preset: 'arm', delivery: 'build' });

  // Capture a real output-1 status record from a Build.
  let first;
  node.emit('input', { payload: null }, (m) => { first = m; }, () => {});
  await tick();
  const statusRecord = first[1];
  assert.ok(isStatusRecord(statusRecord));

  // Feed that status record straight back in as the input message.
  let second;
  node.emit('input', statusRecord, (m) => { second = m; }, () => {});
  await tick();

  assert.equal(second[0], null, 'output 0 must not fire on a miswire');
  assert.equal(second[1].result, 'miswire');
});

test('Safety preset refuses a truthy-but-non-boolean confirmation token', async () => {
  const conn = connStub();
  const RED = redStub({ conn });
  require('../../nodes/mavlink-command')(RED);
  const Node = RED.nodes.types['mavlink-command'];
  const node = new Node({
    mode: 'preset',
    preset: 'flight_termination',
    delivery: 'confirm',
    connection: 'conn',
    targetSysid: '1',
    targetCompid: '1',
  });

  let sent;
  // The string "false" is truthy — it must NOT arm a safety command.
  node.emit('input', { payload: { 1: 1 }, confirmed: 'false' }, (m) => { sent = m; }, () => {});
  await tick();

  assert.equal(sent[0], null, 'output 0 must not fire');
  assert.equal(sent[1].result, 'unconfirmed');
  assert.equal(conn.sent.length, 0, 'nothing is sent to the vehicle');
});

test('Safety preset with confirmed === true proceeds to send the command', async () => {
  const conn = connStub();
  const RED = redStub({ conn });
  require('../../nodes/mavlink-command')(RED);
  const Node = RED.nodes.types['mavlink-command'];
  const node = new Node({
    mode: 'preset',
    preset: 'flight_termination',
    delivery: 'confirm',
    connection: 'conn',
    targetSysid: '1',
    targetCompid: '1',
    timeout: '2000',
  });

  node.emit('input', { payload: { 1: 1 }, confirmed: true }, () => {}, () => {});
  await tick();

  assert.equal(conn.sent.length, 1, 'boolean true arms the command');
  assert.equal(conn.sent[0].message.fields.command, 185);

  node.emit('close', () => {});
});

test('Async handler contains a throw as a terminal failed status plus done(err)', async () => {
  const conn = {
    // Throws when the AckWaiter tries to subscribe.
    subscribe() { throw new Error('boom'); },
    send() {},
  };
  const RED = redStub({ conn });
  require('../../nodes/mavlink-command')(RED);
  const Node = RED.nodes.types['mavlink-command'];
  const node = new Node({
    mode: 'preset',
    preset: 'arm',
    delivery: 'confirm',
    connection: 'conn',
    targetSysid: '1',
    targetCompid: '1',
  });

  let sent;
  let doneErr;
  node.emit('input', { payload: { 1: 1 } }, (m) => { sent = m; }, (err) => { doneErr = err; });
  await tick();

  assert.ok(sent, 'a terminal status was emitted');
  assert.equal(sent[0], null);
  assert.equal(sent[1].result, 'failed');
  assert.ok(sent[1].detail.includes('boom'));
  assert.ok(doneErr instanceof Error, 'done(err) was called');
});

function connStub() {
  const subs = [];
  const sent = [];
  return {
    subs,
    sent,
    peerTable: null,
    send(message, opts) { sent.push({ message, opts }); },
    subscribe(filter, handler) {
      const entry = { filter, handler };
      subs.push(entry);
      return () => {
        const i = subs.indexOf(entry);
        if (i >= 0) subs.splice(i, 1);
      };
    },
  };
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
      },
      registerType(name, ctor) {
        this.types[name] = ctor;
      },
      getNode(id) {
        return nodesById[id];
      },
    },
    httpAdmin: { get() {} },
    auth: { needsPermission() { return (_req, _res, next) => next && next(); } },
  };
}
