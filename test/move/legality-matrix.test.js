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
  steer: { deliveries: ['build', 'send', 'stream'], variants: ['world', 'body', 'offset'] },
  // The acked motion commands (§9 roster). No Stream — a MAV_CMD has no
  // streaming semantics — and no frame variant, so the variant axis carries
  // the one operator choice that changes the wire.
  turn: { deliveries: ['build', 'send', 'confirm'], variants: ['absolute', 'relative'] },
  speed: { deliveries: ['build', 'send', 'confirm'], variants: ['groundspeed', 'airspeed'] },
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
  if (action === 'turn') {
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
    // Body and Turn both need a firmware, and Build has no Connection to get
    // one from — the Vehicle Profile dialect escape is the only source, which
    // is exactly the shape the editor offers (Codex, #277).
    if (variant === 'body' || action === 'turn') {
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
        // Turn is CONDITION_YAW, an ArduPilot command; Body derives per stack.
        const firmware = (variant === 'body' || action === 'turn') ? 'ardupilot' : undefined;
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

// ── The combos that still refuse ─────────────────────────────────────────────
//
// Not "everything the editor does not offer": the altRef and reference
// vocabularies are coerced now rather than checked (AGENTS.md, input trust —
// both are payload-overridable, and msg is trusted). What is left refuses for
// reasons that are not about vetting operator input: an action the surface
// does not define; a body frame with no firmware to derive it from — we asked
// the vehicle what it is and got no answer, so there is no frame number to
// pick; and the one steer mix with no wire encoding we can vouch for —
// position + acceleration without velocity has no named ArduPilot submode and
// no §14 measurement, and a setpoint's missing ack would hide the failure.
// A steer with no field filled is not here any more: the editor requires one
// (mavlink-move.html `action`), and a payload that blanks every group builds
// the honest all-ignore packet.

const REFUSED = [
  // Turn is CONDITION_YAW and PX4 has no handler for it (§14). Fails closed
  // rather than sending a command the vehicle will never act on — the same
  // class as body-without-firmware: no right answer to give.
  {
    name: 'turn on PX4',
    config: { ...configFor('turn', 'send', 'absolute'), connection: 'conn' },
    firmware: 'px4',
    error: /Move turn needs a Vehicle Profile with firmware ardupilot/,
  },
  {
    name: 'turn without a firmware at all',
    config: { ...configFor('turn', 'send', 'absolute'), connection: 'conn' },
    error: /Move turn needs a Vehicle Profile with firmware ardupilot/,
  },
  // Relative changes what the heading number means, so it is a strict boolean
  // opt-in like changeMode — a truthy token must refuse, not silently pick.
  {
    name: 'turn relative as a truthy token',
    config: { ...configFor('turn', 'send', 'absolute'), connection: 'conn', relative: 'yes' },
    firmware: 'ardupilot',
    error: /relative must be boolean/,
  },
  // The action vocabulary is closed: goto and steer, nothing else.
  {
    name: 'unknown action',
    config: { ...configFor('goto', 'send', 'home'), action: 'orbit' },
    // 'orbit' is deliberately still unknown: DO_ORBIT is on the §9 roster as a
    // forward entry, PX4-only and unmeasured, so it is not on the surface yet.
    error: /unknown Move action "orbit" — expected one of goto, steer, turn, speed/,
  },
  // Body without a firmware fails closed — the stacks read different body
  // frames, and an unadapted guess is silently dropped by the vehicle (§14).
  {
    name: 'body reference without firmware',
    config: configFor('steer', 'send', 'body'),
    error: /Vehicle Profile with firmware ardupilot or px4/,
  },
  // The unmeasured steer mix. The editor reds the configured shape; a
  // hand-edited flow or a payload override still reaches the derivation,
  // which refuses with the actual reason rather than "unknown mode".
  {
    name: 'position + acceleration without velocity',
    // All three velocity axes blank: an explicit 0 is a value and names the
    // group, which would make this the measured PosVelAccel instead.
    config: { ...configFor('steer', 'send', 'world'), vNorth: '', vEast: '', vUp: '', north: 5, aUp: 0.5 },
    error: /position \+ acceleration needs a velocity too/,
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
