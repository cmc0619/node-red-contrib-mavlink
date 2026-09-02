'use strict';

/**
 * mavlink-payload on the confirm tier: the pinned or chosen carrier is sent
 * once, and the COMMAND_ACK it earns — a wrong-carrier code included — is the
 * result (DESIGN.md §9). A redeploy-cancelled wait finishes quietly.
 */

const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');

const { MAV_RESULT } = require('../../lib/command');

const tick = () => new Promise((resolve) => setTimeout(resolve, 25));

/** Replies to each send() with the next scripted MAV_RESULT, asynchronously. */
function scriptedConn(results) {
  const subs = [];
  const sent = [];
  let n = 0;
  return {
    subs,
    sent,
    peerTable: null,
    vehicle: null,
    send(message, opts) {
      sent.push({ message, opts });
      const result = results[n];
      n += 1;
      if (result === undefined) return;
      setTimeout(() => {
        const decoded = {
          name: 'COMMAND_ACK',
          sysid: opts.target.sysid,
          compid: opts.target.compid,
          fields: { command: message.fields.command, result },
        };
        for (const { handler } of subs.slice()) handler(decoded);
      }, 0);
    },
    resolveSourceIds: () => null,
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

function deploy(ackResults, config = {}) {
  const conn = scriptedConn(ackResults);
  const RED = {
    nodes: {
      types: {},
      createNode(node, cfg) {
        Object.setPrototypeOf(node, EventEmitter.prototype);
        EventEmitter.call(node);
        node.id = cfg.id || 'node';
        node.status = () => {};
        node.error = () => {};
        node.warn = () => {};
      },
      registerType(name, ctor) { this.types[name] = ctor; },
      getNode(id) { return id === 'conn' ? conn : null; },
    },
    log: { error() {} },
  };
  require('../../nodes/mavlink-payload')(RED);
  const Node = RED.nodes.types['mavlink-payload'];
  const node = new Node({
    // servo set: a command verb whose Send-as row the editor hides, so `int`
    // here is the pin, not an operator choice.
    topic: 'servo',
    verb: 'set',
    sendAs: 'int',
    delivery: 'confirm',
    dialect: 'common',
    connection: 'conn',
    targetSystem: '1',
    targetComponent: '1',
    timeout: '1000',
    values: { servo: 8, pwm: 1600 },
    frame: '3',
    ...config,
  });
  const warnings = [];
  node.warn = (m) => warnings.push(m);
  return { node, conn, warnings };
}

function runInput(node, msg = {}, done = () => {}) {
  return new Promise((resolve) => node.emit('input', msg, resolve, done));
}

test('a wrong-carrier ack is the result: one send, reported on output 1 as-is', async () => {
  // servo set is pinned to COMMAND_INT by the editor; a LONG-only vehicle's
  // answer rides out as the rejection it is, and the flow decides.
  const { node, conn, warnings } = deploy([MAV_RESULT.COMMAND_LONG_ONLY]);
  const sent = await runInput(node, {}, () => {});

  assert.equal(conn.sent.length, 1, 'the pinned carrier is sent once; nothing follows it');
  assert.equal(conn.sent[0].message.name, 'COMMAND_INT');
  assert.deepEqual(warnings, []);
  assert.equal(sent[0], null, 'output 0 stays silent on a rejection');
  assert.equal(sent[1].result, 'command_long_only');
  assert.equal(sent[1].resultCode, MAV_RESULT.COMMAND_LONG_ONLY);
  assert.equal(sent[1].detail, null, 'the ack rides out unchanged');
});

test('ACCEPTED: one send, no warn', async () => {
  const { node, conn, warnings } = deploy([MAV_RESULT.ACCEPTED]);
  await runInput(node, {}, () => {});
  await tick();

  assert.equal(conn.sent.length, 1);
  assert.equal(conn.sent[0].message.name, 'COMMAND_INT');
  assert.deepEqual(warnings, []);
});

test('DENIED: one send, no warn', async () => {
  const { node, conn, warnings } = deploy([MAV_RESULT.DENIED]);
  await runInput(node, {}, () => {});
  await tick();

  assert.equal(conn.sent.length, 1);
  assert.deepEqual(warnings, []);
});

test('a redeploy-cancelled ack wait finishes quietly, not as a payload failure (#54/#57)', async () => {
  // Same rule as mavlink-command and mavlink-mission: close() cancels the
  // in-flight waiter, and a cancel is not a failure. Routing it through
  // failAck emitted and raised on a node being torn down, tripping any Catch
  // node wired for "payload failed → failsafe" on a mere redeploy.
  // An empty script means the connection never acks, so only the cancel ends it.
  const { node, conn } = deploy([], { timeout: '60000' });

  let emitted = false;
  let doneErr = 'not-called';
  node.emit('input', { payload: {} }, () => { emitted = true; }, (err) => { doneErr = err; });
  await tick();

  assert.equal(conn.sent.length, 1, 'the command went out before the redeploy');

  await new Promise((resolve) => node.emit('close', resolve));
  await tick();
  await tick();

  assert.equal(doneErr, undefined, 'done() called with no error — a cancel is not a failure');
  assert.equal(emitted, false, 'nothing is emitted onto a node being torn down');
});
