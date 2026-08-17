'use strict';

/**
 * mavlink-command carrier auto-resend tests (DESIGN.md §9 "resend in the other
 * form"; user requirement: warn on retry, fail loud if the second attempt also
 * fails, and only one carrier swap per transaction).
 *
 * The connection stub scripts one COMMAND_ACK per send in order, so a test can
 * make the first COMMAND_LONG ack COMMAND_INT_ONLY and then decide what the
 * COMMAND_INT resend acks. A minimal Node-RED stub drives the constructor.
 */

const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');

const { MAV_RESULT } = require('../../lib/command');

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
  const RED = redStub({ conn, ...extraNodes });
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
    ...config,
  });
  const warnings = [];
  node.warn = (m) => warnings.push(m);
  return { node, conn, warnings };
}

test('INT_ONLY then ACCEPTED: warns, resends as COMMAND_INT, continues', async () => {
  const { node, conn, warnings } = deploy([
    MAV_RESULT.COMMAND_INT_ONLY,
    MAV_RESULT.ACCEPTED,
  ]);

  const sent = await runInput(node, { payload: { 5: 47.1, 6: -122.5, 7: 100 } });

  assert.equal(conn.sent.length, 2, 'exactly two sends: one LONG then one INT');
  assert.equal(conn.sent[0].message.name, 'COMMAND_LONG');
  assert.equal(conn.sent[1].message.name, 'COMMAND_INT');
  // Global default frame → lat/lon scaled to degE7 on the INT carrier.
  assert.equal(conn.sent[1].message.fields.x, 471000000);
  assert.equal(conn.sent[1].message.fields.y, -1225000000);
  assert.equal(conn.sent[1].message.fields.z, 100);

  assert.equal(warnings.length, 1, 'warned once on the carrier swap');
  assert.match(warnings[0], /resending as COMMAND_INT/);

  assert.ok(sent, 'outputs fired');
  assert.ok(sent[0], 'output 0 (continue) fired on success');
  assert.equal(sent[1].result, 'accepted');
  assert.match(sent[1].detail, /carrier swap/);
});

test('INT_ONLY twice: fails loud, no third send, output 0 stays silent', async () => {
  const { node, conn, warnings } = deploy([
    MAV_RESULT.COMMAND_INT_ONLY,
    MAV_RESULT.COMMAND_INT_ONLY,
  ]);

  const sent = await runInput(node, { payload: { 5: 47.1, 6: -122.5, 7: 100 } });

  assert.equal(conn.sent.length, 2, 'only one carrier swap — no third attempt');
  assert.equal(warnings.length, 1);
  assert.equal(sent[0], null, 'output 0 must not fire when the swap also fails');
  assert.equal(sent[1].result, 'command_int_only');
  assert.match(sent[1].detail, /no carrier satisfies/);
});

test('INT_ONLY then DENIED: fails loud, noting the completed swap', async () => {
  const { node, conn } = deploy([
    MAV_RESULT.COMMAND_INT_ONLY,
    MAV_RESULT.DENIED,
  ]);

  const sent = await runInput(node, { payload: { 5: 47.1, 6: -122.5, 7: 100 } });

  assert.equal(conn.sent.length, 2);
  assert.equal(sent[0], null);
  assert.equal(sent[1].result, 'denied');
  assert.match(sent[1].detail, /carrier swap/);
});

test('ACCEPTED on the first COMMAND_LONG: no swap, no warn', async () => {
  const { node, conn, warnings } = deploy([MAV_RESULT.ACCEPTED]);

  const sent = await runInput(node, { payload: { 5: 47.1, 6: -122.5, 7: 100 } });

  assert.equal(conn.sent.length, 1, 'a single COMMAND_LONG send');
  assert.equal(conn.sent[0].message.name, 'COMMAND_LONG');
  assert.equal(warnings.length, 0, 'no warning without a carrier swap');
  assert.ok(sent[0], 'output 0 fired');
  assert.equal(sent[1].result, 'accepted');
  assert.equal(sent[1].detail, null);
});

test('contradictory LONG_ONLY on the first LONG send fails loud without swapping', async () => {
  const { node, conn, warnings } = deploy([MAV_RESULT.COMMAND_LONG_ONLY]);

  const sent = await runInput(node, { payload: { 5: 47.1, 6: -122.5, 7: 100 } });

  assert.equal(conn.sent.length, 1, 'no swap: the demanded carrier was already sent');
  assert.equal(warnings.length, 0);
  assert.equal(sent[0], null);
  assert.equal(sent[1].result, 'command_long_only');
  assert.match(sent[1].detail, /already sent/);
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
  assert.equal(warnings.length, 0, 'no warning without a carrier swap');
  assert.ok(sent[0], 'output 0 fired');
  assert.equal(sent[1].result, 'accepted');
  assert.equal(sent[1].detail, null, 'no swap note when the configured carrier was accepted');
});

test('INT-first LONG_ONLY: swaps back to COMMAND_LONG with unscaled degrees', async () => {
  const { node, conn, warnings } = deploy(
    [MAV_RESULT.COMMAND_LONG_ONLY, MAV_RESULT.ACCEPTED],
    { sendAs: 'int' }
  );

  const sent = await runInput(node, { payload: { 5: 47.1, 6: -122.5, 7: 100 } });

  assert.equal(conn.sent.length, 2, 'exactly two sends: one INT then one LONG');
  assert.equal(conn.sent[0].message.name, 'COMMAND_INT');
  assert.equal(conn.sent[1].message.name, 'COMMAND_LONG');
  // The resend rebuilds from the canonical degree params — float degrees on
  // the LONG carrier, not a degE7 leak.
  assert.equal(conn.sent[1].message.fields.param5, 47.1);
  assert.equal(conn.sent[1].message.fields.param6, -122.5);
  assert.equal(conn.sent[1].message.fields.param7, 100);

  assert.equal(warnings.length, 1, 'warned once on the carrier swap');
  assert.match(warnings[0], /resending as COMMAND_LONG/);
  assert.ok(sent[0], 'output 0 fired');
  assert.equal(sent[1].result, 'accepted');
  assert.match(sent[1].detail, /COMMAND_LONG carrier swap/);
});

test('INT-first contradictory INT_ONLY fails loud without swapping', async () => {
  const { node, conn, warnings } = deploy(
    [MAV_RESULT.COMMAND_INT_ONLY],
    { sendAs: 'int' }
  );

  const sent = await runInput(node, { payload: { 5: 47.1, 6: -122.5, 7: 100 } });

  assert.equal(conn.sent.length, 1, 'no swap: the demanded carrier was already sent');
  assert.equal(warnings.length, 0);
  assert.equal(sent[0], null);
  assert.equal(sent[1].result, 'command_int_only');
  assert.match(sent[1].detail, /already sent/);
});

test('msg.mavFrame selects a non-global frame so INT x/y scale by 1e4, not 1e7', async () => {
  const { node, conn } = deploy(
    [MAV_RESULT.COMMAND_INT_ONLY, MAV_RESULT.ACCEPTED]
  );

  const sent = await runInput(
    node,
    { payload: { 5: 10.4, 6: -3.6, 7: 12 }, mavFrame: 1 }, // LOCAL_NED
  );

  assert.equal(conn.sent[1].message.name, 'COMMAND_INT');
  assert.equal(conn.sent[1].message.fields.frame, 1);
  // Local frame scales metres × 1e4, not degE7 — measured against PX4 SITL
  // (DESIGN.md §14). 10.4 m on the wire is 104000.
  assert.equal(conn.sent[1].message.fields.x, 104000, 'metres × 1e4, not degE7-scaled');
  assert.equal(conn.sent[1].message.fields.y, -36000);
  assert.equal(sent[1].result, 'accepted');
});

// ── Ask-the-XML kinds and the NaN refusal at node level (§9) ─────────────────

const { loadBundled } = require('../../lib/metadata');

// Compiled once like a real Vehicle Profile node — getDialect() returns a
// held bundle, it does not re-parse per call.
const COMMON_BUNDLE = loadBundled('common');

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

test('INT + NaN lat/lon builds non-finite — the wire is what refuses it', async () => {
  // int32 cannot express NaN. The driver does not coerce it to 0 (null
  // island) and does not refuse it either: it builds what it was handed, and
  // the real Connection.send serializes before enqueueing, so
  // lib/connection/wire.js throws synchronously into this node's error path
  // (test/connection/wire-nonfinite.test.js covers that half).
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
