'use strict';

/**
 * mavlink-command on the wire: the configured carrier is the one sent, its
 * positional params scale per carrier (DESIGN.md §9 "Coordinate frames"), and
 * the COMMAND_ACK it earns — a wrong-carrier code included — is the result.
 *
 * The connection stub scripts one COMMAND_ACK per send in order. A minimal
 * Node-RED stub drives the constructor.
 */

const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');

const { MAV_RESULT } = require('../../lib/command');
const { loadBundled } = require('../../lib/metadata');

const COMMON_BUNDLE = loadBundled('common');

function runInput(node, msg, done = () => {}) {
  return new Promise((resolve) => {
    node.emit('input', msg, resolve, done);
  });
}

/**
 * A connection stub that replies to each send() with the next scripted ACK
 * result (delivered asynchronously so the AckWaiter promise is pending first).
 *
 * @param {number[]} results  MAV_RESULT code per send, in order
 */
function scriptedConn(results) {
  const subs = [];
  const sent = [];
  let n = 0;
  return {
    subs,
    sent,
    peerTable: null,
    send(message, opts) {
      sent.push({ message, opts });
      const result = results[n];
      n += 1;
      if (result === undefined) return; // no reply → let it time out
      setTimeout(() => {
        const decoded = {
          name: 'COMMAND_ACK',
          sysid: opts.target.sysid,
          compid: opts.target.compid,
          // Omitted target extensions decode as 0 (§14).
          fields: { command: message.fields.command, result, target_system: 0, target_component: 0 },
        };
        for (const { handler } of subs.slice()) handler(decoded);
      }, 0);
    },
    resolveSourceIds: () => ({ sysid: 255, compid: 190 }),
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
        node.warn = () => {};
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

/**
 * Construct a deployed mavlink-command node against a scripted connection.
 *
 * @param {number[]} ackResults
 * @param {object} [config]  extra node config overrides
 * @returns {{node: object, conn: object, warnings: string[]}}
 */
function deploy(ackResults, config = {}, extraNodes = {}) {
  const conn = scriptedConn(ackResults);
  conn.vehicle = Object.freeze({ id: 'veh' });
  const RED = redStub({
    conn,
    veh: { getDialect: () => COMMON_BUNDLE },
    ...extraNodes,
  });
  require('../../nodes/mavlink-command')(RED);
  const Node = RED.nodes.types['mavlink-command'];
  const node = new Node({
    params: '{}',
    sendAs: config.sendAs || 'long',
    mode: 'preset',
    preset: 'reposition',
    delivery: 'confirm',
    connection: 'conn',
    targetSystem: '1',
    targetComponent: '1',
    timeout: '1000',
    frame: '3',
    ...config,
  });
  const warnings = [];
  node.warn = (m) => warnings.push(m);
  return { node, conn, warnings };
}

test('ACCEPTED on the first COMMAND_LONG: one send, no warn', async () => {
  const { node, conn, warnings } = deploy([MAV_RESULT.ACCEPTED]);

  const sent = await runInput(node, { payload: { 5: 47.1, 6: -122.5, 7: 100 } });

  assert.equal(conn.sent.length, 1, 'a single COMMAND_LONG send');
  assert.equal(conn.sent[0].message.name, 'COMMAND_LONG');
  assert.equal(warnings.length, 0);
  assert.ok(sent[0], 'output 0 fired');
  assert.equal(sent[1].result, 'accepted');
  assert.equal(sent[1].detail, null);
});

test('a wrong-carrier ack is the result: one send, reported on output 1 as-is', async () => {
  const { node, conn, warnings } = deploy([MAV_RESULT.COMMAND_INT_ONLY]);

  const sent = await runInput(node, { payload: { 5: 47.1, 6: -122.5, 7: 100 } });

  assert.equal(conn.sent.length, 1, 'the configured carrier is sent once; nothing is resent');
  assert.equal(conn.sent[0].message.name, 'COMMAND_LONG');
  assert.equal(warnings.length, 0);
  assert.equal(sent[0], null, 'output 0 stays silent on a rejection');
  assert.equal(sent[1].result, 'command_int_only');
  assert.equal(sent[1].resultCode, MAV_RESULT.COMMAND_INT_ONLY);
  assert.equal(sent[1].detail, null, 'the ack rides out unchanged');
});

test('INT-first: configured carrier int sends COMMAND_INT with degrees scaled to degE7', async () => {
  const { node, conn, warnings } = deploy([MAV_RESULT.ACCEPTED], { sendAs: 'int' });

  const sent = await runInput(node, { payload: { 5: -35, 6: 149, 7: 100 } });

  assert.equal(conn.sent.length, 1, 'a single COMMAND_INT send');
  assert.equal(conn.sent[0].message.name, 'COMMAND_INT');
  // Whole-degree operator input scales like any other degrees value (§9) —
  // the old integer/|v|>180 pass-through guesses are gone.
  assert.equal(conn.sent[0].message.fields.x, -350000000);
  assert.equal(conn.sent[0].message.fields.y, 1490000000);
  assert.equal(conn.sent[0].message.fields.z, 100);
  assert.equal(warnings.length, 0);
  assert.ok(sent[0], 'output 0 fired');
  assert.equal(sent[1].result, 'accepted');
  assert.equal(sent[1].detail, null);
});

test('msg.mavFrame selects a non-global frame so INT x/y scale by 1e4, not 1e7', async () => {
  const { node, conn } = deploy([MAV_RESULT.ACCEPTED], { sendAs: 'int' });

  const sent = await runInput(
    node,
    { payload: { 5: 10.4, 6: -3.6, 7: 12 }, mavFrame: 1 }, // LOCAL_NED
  );

  assert.equal(conn.sent[0].message.name, 'COMMAND_INT');
  assert.equal(conn.sent[0].message.fields.frame, 1);
  // Local frame scales metres × 1e4, not degE7 — measured against PX4 SITL
  // (DESIGN.md §14). 10.4 m on the wire is 104000.
  assert.equal(conn.sent[0].message.fields.x, 104000, 'metres × 1e4, not degE7-scaled');
  assert.equal(conn.sent[0].message.fields.y, -36000);
  assert.equal(sent[1].result, 'accepted');
});

// ── Ask-the-XML kinds and the NaN refusal at node level (§9) ─────────────────

test('INT + non-location command: XML kinds keep param5 raw on the wire', async () => {
  // Production contract: the connection's vehicle snapshot exposes only the
  // profile node id; the compiled bundle comes from getDialect() (Codex #61).
  const { node, conn } = deploy(
    [MAV_RESULT.ACCEPTED],
    {
      sendAs: 'int',
      mode: 'advanced',
      advancedCommand: '1000', // DO_GIMBAL_MANAGER_PITCHYAW — param5 is flags
    },
    { veh: { getDialect: () => COMMON_BUNDLE } }
  );
  conn.vehicle = Object.freeze({ id: 'veh' });

  const sent = await runInput(node, { payload: { 1: -15, 2: 90, 5: 8 } });

  assert.equal(conn.sent[0].message.name, 'COMMAND_INT');
  assert.equal(conn.sent[0].message.fields.x, 8, 'gimbal flags must not be ×1e7-scaled');
  assert.equal(sent[1].result, 'accepted');
});

test('INT + NaN lat/lon builds non-finite — never coerced to null island', async () => {
  // int32 cannot express NaN. The driver does not coerce it to 0 (null
  // island) and does not refuse it either: it builds what it was handed.
  const { node, conn } = deploy(
    [MAV_RESULT.ACCEPTED],
    {
      sendAs: 'int',
      mode: 'advanced',
      advancedCommand: '192', // DO_REPOSITION
    },
    { veh: { getDialect: () => COMMON_BUNDLE } }
  );
  conn.vehicle = Object.freeze({ id: 'veh' });

  await runInput(node, { payload: { 5: NaN, 6: 149, 7: 50 } }, () => {});

  assert.equal(conn.sent.length, 1, 'the stub connection does not serialize');
  assert.ok(Number.isNaN(conn.sent[0].message.fields.x), 'the coordinate is never coerced to 0');
});
