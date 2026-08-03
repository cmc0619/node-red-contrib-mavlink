'use strict';

/**
 * mavlink-payload carrier auto-resend (DESIGN.md §9 "resend in the other
 * form") — the same rule mavlink-command follows, through the same
 * `carrierWantedBy`.
 *
 * This matters more on Payload than on Command. The editor shows the Carrier
 * control only for a verb whose command carries a location (gimbal ROI-set)
 * and pins the other 13 command verbs to COMMAND_INT, so an operator cannot
 * choose LONG for them. On a LONG-only vehicle the swap is the only thing
 * between those verbs and a flat refusal.
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
    // servo set: a command verb whose Carrier row the editor hides, so `int`
    // here is the pin, not an operator choice.
    topic: 'servo',
    verb: 'set',
    carrier: 'int',
    delivery: 'confirm',
    dialect: 'common',
    connection: 'conn',
    targetSystem: '1',
    targetComponent: '1',
    timeout: '1000',
    values: { servo: 8, pwm: 1600 },
    ...config,
  });
  const warnings = [];
  node.warn = (m) => warnings.push(m);
  return { node, conn, warnings };
}

function runInput(node, msg = {}, done = () => {}) {
  return new Promise((resolve) => node.emit('input', msg, resolve, done));
}

test('LONG_ONLY on a pinned-INT verb resends as COMMAND_LONG and continues', async () => {
  const { node, conn, warnings } = deploy([
    MAV_RESULT.COMMAND_LONG_ONLY,
    MAV_RESULT.ACCEPTED,
  ]);
  await runInput(node, {}, () => {});
  await tick();
  await tick();

  assert.equal(conn.sent.length, 2, 'exactly two sends: one INT then one LONG');
  assert.equal(conn.sent[0].message.name, 'COMMAND_INT', 'first attempt is the pinned carrier');
  assert.equal(conn.sent[1].message.name, 'COMMAND_LONG', 'resent in the form the vehicle asked for');
  assert.equal(conn.sent[1].message.fields.command, 183, 'same command, rebuilt not mutated');
  assert.equal(conn.sent[1].message.fields.param1, 8, 'params survive the rebuild');
  assert.equal(conn.sent[1].message.fields.param2, 1600);
  assert.equal(warnings.length, 1, 'the swap is announced, never silent');
  assert.match(warnings[0], /carrier swap/);
});

test('INT_ONLY on a LONG-carrier verb resends as COMMAND_INT', async () => {
  // The other direction. gimbal roi-set is the one verb whose Carrier control
  // the editor still shows, so `long` here is an operator choice rather than
  // the pin — and it is the verb where the carrier is observable at all.
  const { node, conn, warnings } = deploy(
    [MAV_RESULT.COMMAND_INT_ONLY, MAV_RESULT.ACCEPTED],
    {
      topic: 'gimbal',
      verb: 'roi-set',
      carrier: 'long',
      values: { lat: 47.397742, lon: 8.545594, alt: 30 },
    }
  );
  await runInput(node, {}, () => {});
  await tick();
  await tick();

  assert.equal(conn.sent.length, 2);
  assert.equal(conn.sent[0].message.name, 'COMMAND_LONG', 'first attempt is the configured carrier');
  assert.equal(conn.sent[1].message.name, 'COMMAND_INT', 'resent in the form the vehicle asked for');
  // The rebuild re-runs the recipe, so INT scaling is applied to the resend
  // rather than the LONG floats being copied across.
  assert.equal(conn.sent[1].message.fields.x, Math.round(47.397742 * 1e7), 'lat rebuilt as degE7');
  assert.equal(conn.sent[1].message.fields.y, Math.round(8.545594 * 1e7), 'lon rebuilt as degE7');
  assert.equal(conn.sent[0].message.fields.param5, 47.397742, 'the LONG attempt carried raw degrees');
  assert.equal(warnings.length, 1);
});

test('a second wrong-carrier ack fails loud rather than ping-ponging', async () => {
  const { node, conn } = deploy([
    MAV_RESULT.COMMAND_LONG_ONLY,
    MAV_RESULT.COMMAND_INT_ONLY,
  ]);
  await runInput(node, {}, () => {});
  await tick();
  await tick();
  await tick();

  assert.equal(conn.sent.length, 2, 'no third send — one swap per message');
});

test('ACCEPTED first time does not swap and does not warn', async () => {
  const { node, conn, warnings } = deploy([MAV_RESULT.ACCEPTED]);
  await runInput(node, {}, () => {});
  await tick();

  assert.equal(conn.sent.length, 1);
  assert.equal(conn.sent[0].message.name, 'COMMAND_INT');
  assert.deepEqual(warnings, []);
});

test('an ordinary DENIED is not a carrier problem and is not resent', async () => {
  const { node, conn, warnings } = deploy([MAV_RESULT.DENIED]);
  await runInput(node, {}, () => {});
  await tick();

  assert.equal(conn.sent.length, 1, 'DENIED means no, not wrong envelope');
  assert.deepEqual(warnings, []);
});
