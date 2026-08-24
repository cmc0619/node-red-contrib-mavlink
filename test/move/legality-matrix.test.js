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
  goto: { deliveries: ['build', 'send', 'confirm', 'stream'], variants: ['home', 'msl', 'terrain'] },
  steer: { deliveries: ['build', 'send', 'stream'], variants: ['world', 'body', 'offset'] },
  // The acked motion commands (§9 roster). No Stream — a MAV_CMD has no
  // streaming semantics — and no frame variant, so the variant axis carries
  // the one operator choice that changes the wire.
  turn: { deliveries: ['build', 'send', 'confirm'], variants: ['absolute', 'relative'] },
  speed: { deliveries: ['build', 'send', 'confirm'], variants: ['groundspeed', 'airspeed'] },
  // Setpoint-shaped: no ack, streaming is the normal use. Attitude's variants
  // are its two presence modes (angles vs body rates); manual has one shape.
  attitude: { deliveries: ['build', 'send', 'stream'], variants: ['angles', 'rates'] },
  manual: { deliveries: ['build', 'send', 'stream'], variants: ['sticks'] },
};

/**
 * Cells the dropdowns cannot produce even though both axes are offered on
 * their own — `refreshDeliveryOptions` withdraws the tier for the reference.
 * Kept as an explicit set rather than a ragged OFFERED table so the hole is
 * visible: a combo silently dropped from a cross-product reads as covered.
 *
 * Offset × Stream: every setpoint on LOCAL_OFFSET_NED is resolved against the
 * vehicle's position at that moment, so repeating one walks the vehicle away
 * rather than holding a target (ArduCopter/Rover/Sub add
 * `get_relative_position_NED_origin()` per message; ArduPlane's handler is
 * `next_WP_loc.alt +=`, which accumulates outright). Source-read 2026-08-13,
 * not yet SITL-measured.
 */
const NOT_OFFERED = new Set(['steer/stream/offset']);

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
  if (action === 'attitude') {
    if (variant === 'rates') {
      // Each body rate has its own ignore bit, so one rate alone is a complete
      // command — the other two are genuinely not commanded.
      config.rollRate = 5;
    } else {
      // All three angles, because ATTITUDE_IGNORE is one bit over the whole
      // quaternion: there is no encoding for "roll 10, yaw unsaid", so the
      // minimal *valid* attitude names every angle (owner ruling, 2026-08-14).
      config.roll = 10;
      config.pitch = 0;
      config.yaw = 0;
      config.thrust = 0.5;
    }
  } else if (action === 'manual') {
    // All four sticks: MANUAL_CONTROL's per-axis "invalid" sentinel is not sent
    // any more, so a blank axis refuses rather than going out uncommanded.
    config.stickX = 0;
    config.stickY = 0;
    config.stickZ = 0.5;
    config.stickR = 0.5;
  } else if (action === 'turn') {
    config.heading = 90;
    config.relative = variant === 'relative';
  } else if (action === 'speed') {
    config.speed = 5;
    config.speedType = variant;
  } else if (action === 'goto') {
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
    // Body on Build is only offered through the Vehicle Profile dialect
    // escape — the editor reds any other dialect (Codex, #277), because a
    // concrete dialect gives Build no firmware source and the node would
    // deploy clean and refuse every input. The matrix drives the offered
    // shape, not the hidden-field shortcut it originally used.
    //
    // Body is now the ONLY variant that needs this. Turn briefly did, when it
    // refused off ArduPilot; that refusal was a guardrail (§9: a legal message
    // the vehicle ignores still sends) and is gone.
    if (variant === 'body') {
      config.dialect = '__vehicle';
      config.vehicle = 'veh';
    } else {
      config.dialect = 'common';
    }
  } else {
    config.connection = 'conn';
  }
  if (delivery === 'stream') {
    config.rateHz = 0.1;
    config.ttlMs = 0;
  }
  return config;
}

/**
 * The MAV_CMD each acked action rides, so the confirm tier's stub ack matches
 * the AckWaiter's command filter. A wrong id here does not fail the assertion —
 * it hangs the test, because the waiter ignores an ack for another command.
 */
const ACK_COMMAND = { goto: 192, turn: 115, speed: 178 };

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
    // offered combo can finish the way a real vehicle finishes it. Assert
    // the subscription instead of guarding on it (CodeRabbit, #277): a
    // confirm tier that stopped subscribing would otherwise hang the test
    // instead of failing with a name.
    if (config.delivery === 'confirm') {
      assert.ok(conn.subs.length, 'the confirm tier subscribes before the handler returns');
      const command = ACK_COMMAND[config.action] || ACK_COMMAND.goto;
      conn.subs[0].handler({ sysid: 1, compid: 1, fields: { command, result: 0 } });
    }
  });
}

// ── Every offered combo completes ────────────────────────────────────────────

const COMPLETES = { build: 'built', send: 'sent', confirm: 'accepted', stream: 'streaming' };

for (const [action, { deliveries, variants }] of Object.entries(OFFERED)) {
  for (const delivery of deliveries) {
    for (const variant of variants) {
      if (NOT_OFFERED.has(`${action}/${delivery}/${variant}`)) continue;
      test(`offered: ${action} × ${delivery} × ${variant} completes on the real node`, async () => {
        // Body is the one variant that derives per stack and so needs a profile.
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

// ── The combos the editor withholds ──────────────────────────────────────────
//
// The driver does not vet these (§0): the editor is what reds them, and its
// own red rings are covered in test/nodes/move-html.test.js. What the driver
// must never do is quietly pick a *different, legal* wire value for a
// selection that did not resolve. These assert that line — an unresolved
// selection either rides as non-finite or selects no behavior at all.

test('unoffered: a body reference with no firmware resolves no frame, and never guesses one', async () => {
  const { err, node, conn } = await drive(configFor('steer', 'send', 'body'));
  node.emit('close', () => {});
  assert.equal(err, undefined, 'the driver builds and hands off — no refusal of its own');
  assert.equal(conn.sends.length, 1, 'the message is built');
  const frame = conn.sends[0].message.fields.coordinate_frame;
  assert.ok(!Number.isFinite(frame), 'the unresolved frame is non-finite, not a substituted number');
});

test('unoffered: a steer mix with no MODES row selects no behavior and reaches no wire', async () => {
  // All three velocity axes blank: an explicit 0 is a value and names the
  // group, which would make this the measured PosVelAccel instead.
  const config = { ...configFor('steer', 'send', 'world'), vNorth: '', vEast: '', vUp: '', north: 5, aUp: 0.5 };
  const { err, node, conn } = await drive(config);
  node.emit('close', () => {});
  assert.ok(err instanceof Error, 'the build craters');
  assert.equal(conn.sends.length, 0, 'nothing reached the wire');
});

test('unoffered: an unknown delivery tier matches no case, so nothing is sent', async () => {
  const config = { ...configFor('steer', 'send', 'world'), delivery: 'sned' };
  const { out, err, node, conn } = await drive(config);
  node.emit('close', () => {});
  assert.equal(err, undefined);
  assert.equal(out, undefined, 'no tier ran, so no outcome was reported');
  assert.equal(conn.sends.length, 0, 'nothing reached the wire');
});

// ── Re-issue safety is per command, not per carrier ──────────────────────────

