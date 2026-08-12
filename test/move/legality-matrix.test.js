'use strict';

/**
 * The legality matrix: the redesign's enforcement test (§6, 2026-08-12).
 *
 * OFFERED below hardcodes the editor's offered surface as the spec — every
 * Action × Delivery × frame-choice combo the dropdowns can produce. This file
 * is the lint for "no dropdown offers an option the current selection makes
 * illegal": every offered combo drives the REAL node with minimal valid
 * fields and must complete without result 'failed'; every combo the editor
 * does NOT offer must refuse loud at the runtime boundary — never a silent
 * downgrade, never a wrong wire message. If a combo is added to the editor it
 * MUST be added here, and the runtime must accept it.
 */

const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');

/** The offered surface, verbatim from the editor (nodes/mavlink-move.html). */
const OFFERED = {
  goto: { deliveries: ['build', 'send', 'confirm', 'stream'], variants: ['home', 'msl'] },
  steer: { deliveries: ['build', 'send', 'stream'], variants: ['world', 'body'] },
};

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
        node.send = () => {};
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

/** Wire connection stub with the subscribe surface the confirm tier consumes. */
function makeConn(vehicle) {
  const sends = [];
  const subs = [];
  return {
    id: 'conn',
    vehicle,
    sends,
    subs,
    send(message, opts) { sends.push({ message, opts }); },
    subscribe(filter, handler) { subs.push({ filter, handler }); return () => {}; },
    resolveSourceIds() { return { sysid: 255, compid: 190 }; },
  };
}

/**
 * Minimal valid config for a combo: goto needs a position, steer a velocity;
 * body needs a firmware — from the connection's Vehicle Profile on the wire
 * tiers, from the node's own Vehicle Profile on Build (which has no
 * connection).
 */
function configFor(action, delivery, variant) {
  const config = { action, delivery, targetSystem: 1, targetComponent: 1 };
  if (action === 'goto') {
    config.altRef = variant;
    config.lat = 47;
    config.lon = 8;
    config.alt = 10;
  } else {
    config.reference = variant;
    config.vNorth = 1;
    config.vEast = 0;
    config.vUp = 0;
  }
  if (delivery === 'build') {
    config.dialect = 'common';
    if (variant === 'body') config.vehicle = 'veh';
  } else {
    config.connection = 'conn';
  }
  if (delivery === 'stream') {
    config.rateHz = 0.1;
    config.ttlMs = 0;
  }
  return config;
}

/** Drive one input on a fresh real node; resolve on done(). */
function drive(config, { firmware } = {}) {
  const conn = makeConn(firmware ? { firmware } : {});
  const veh = firmware ? { firmware } : undefined;
  const RED = redStub({ conn, veh });
  require('../../nodes/mavlink-move')(RED);
  const Node = RED.nodes.types['mavlink-move'];
  const node = new Node(config);
  return new Promise((resolve) => {
    let out;
    node.emit(
      'input',
      { payload: {} },
      (m) => { out = m; },
      (err) => resolve({ out, err, node, conn })
    );
    // The confirm tier completes on its COMMAND_ACK: feed ACCEPTED so the
    // offered combo can finish the way a real vehicle finishes it.
    if (config.delivery === 'confirm' && conn.subs.length) {
      conn.subs[0].handler({ sysid: 1, compid: 1, fields: { command: 192, result: 0 } });
    }
  });
}

// ── Every offered combo completes ────────────────────────────────────────────

const COMPLETES = { build: 'built', send: 'sent', confirm: 'accepted', stream: 'streaming' };

for (const [action, { deliveries, variants }] of Object.entries(OFFERED)) {
  for (const delivery of deliveries) {
    for (const variant of variants) {
      test(`offered: ${action} × ${delivery} × ${variant} completes on the real node`, async () => {
        const firmware = variant === 'body' ? 'ardupilot' : undefined;
        const { out, err, node } = await drive(configFor(action, delivery, variant), { firmware });
        // Streams and waiters must not leak into the next combo: the stream
        // lock is module-global, keyed on (connection, target).
        node.emit('close', () => {});
        assert.equal(err, undefined, `${action}/${delivery}/${variant} must not fail the input`);
        assert.ok(out, 'the input produced an outcome');
        assert.notEqual(out[1].result, 'failed', 'an offered combo never fails');
        assert.equal(out[1].result, COMPLETES[delivery], 'the combo completes with its tier word');
        assert.ok(out[0], 'the continue port fired');
      });
    }
  }
}

// ── Every unoffered combo refuses loud ───────────────────────────────────────

const REFUSED = [
  // Setpoints carry no acknowledgement — confirm exists on goto only.
  {
    name: 'steer × confirm (world)',
    config: configFor('steer', 'confirm', 'world'),
    error: /Send & confirm exists on the Go to action only/,
  },
  {
    name: 'steer × confirm (body)',
    config: configFor('steer', 'confirm', 'body'),
    firmware: 'ardupilot',
    error: /Send & confirm exists on the Go to action only/,
  },
  // The action vocabulary is closed: goto and steer, nothing else.
  {
    name: 'unknown action',
    config: { ...configFor('goto', 'send', 'home'), action: 'orbit' },
    error: /unknown Move action "orbit" — expected goto or steer/,
  },
  // altRef has no terrain: unmeasured on both stacks, dropped from the
  // surface until it isn't (§14).
  {
    name: "altRef 'terrain'",
    config: { ...configFor('goto', 'send', 'home'), altRef: 'terrain' },
    error: /unknown Move altitude reference "terrain"/,
  },
  // The reference vocabulary is closed too.
  {
    name: 'unknown reference',
    config: { ...configFor('steer', 'send', 'world'), reference: 'diagonal' },
    error: /unknown Move reference "diagonal"/,
  },
  // Body without a firmware fails closed — the stacks read different body
  // frames, and an unadapted guess is silently dropped by the vehicle (§14).
  {
    name: 'body reference without firmware',
    config: configFor('steer', 'send', 'body'),
    error: /Vehicle Profile with firmware ardupilot or px4/,
  },
];

for (const { name, config, firmware, error } of REFUSED) {
  test(`unoffered: ${name} refuses loud`, async () => {
    const { out, err, node, conn } = await drive(config, { firmware });
    node.emit('close', () => {});
    assert.ok(err instanceof Error, 'the input fails');
    assert.match(err.message, error, 'the refusal names the rule');
    assert.equal(out[0], null, 'the continue port must not fire');
    assert.equal(out[1].result, 'failed');
    assert.equal(conn.sends.length, 0, 'nothing reached the wire');
  });
}
