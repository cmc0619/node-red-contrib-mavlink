'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildTurnMessage } = require('../../lib/move');

const target = { sysid: 5, compid: 1 };

/** A valid turn input; override per test. */
function input(overrides = {}) {
  return { heading: 90, firmware: 'ardupilot', target, ...overrides };
}

test('turn builds COMMAND_LONG / CONDITION_YAW with the dialect param order', () => {
  const message = buildTurnMessage(input({ rate: 25, direction: 1, relative: true }));
  assert.equal(message.name, 'COMMAND_LONG');
  assert.equal(message.fields.command, 115);
  assert.equal(message.fields.target_system, 5);
  assert.equal(message.fields.target_component, 1);
  // param1 angle deg, param2 angular speed deg/s, param3 direction,
  // param4 relative — common.xml's order, degrees on the wire (unlike
  // DO_REPOSITION's param4, which the dialect declares in radians).
  assert.equal(message.fields.param1, 90);
  assert.equal(message.fields.param2, 25);
  assert.equal(message.fields.param3, 1);
  assert.equal(message.fields.param4, 1);
});

test('turn blank sentinels: rate 0 (vehicle default), direction 0 (shortest way round)', () => {
  const message = buildTurnMessage(input());
  assert.equal(message.fields.param2, 0, 'blank rate → the vehicle default');
  // 0 is not a hole we are filling: common.xml defines param3 0 as "shortest
  // direction", so the default is the dialect's own.
  assert.equal(message.fields.param3, 0, 'blank direction → shortest');
  assert.equal(message.fields.param4, 0, 'absolute unless relative is opted into');

  // An explicit 0 heading is north, not a blank.
  assert.equal(buildTurnMessage(input({ heading: 0 })).fields.param1, 0);
  assert.equal(buildTurnMessage(input({ direction: -1 })).fields.param3, -1, 'counter-clockwise');
});

test('turn is ArduPilot-only and fails closed elsewhere — CONDITION_YAW has no PX4 handler', () => {
  // Same refusal class as the body reference: not input-vetting, simply no
  // right answer to give. The message names the escape that works on PX4.
  for (const firmware of ['px4', 'custom', undefined, '']) {
    assert.throws(
      () => buildTurnMessage(input({ firmware })),
      /Move turn needs a Vehicle Profile with firmware ardupilot/,
      `firmware ${JSON.stringify(firmware)} must refuse`
    );
  }
  assert.throws(
    () => buildTurnMessage(input({ firmware: 'px4' })),
    /Steer setpoint/,
    'the refusal points at the yaw path PX4 does honour'
  );
});

test('turn relative is a strict boolean opt-in, like changeMode', () => {
  // It changes what the heading number means — absolute bearing vs offset from
  // current — so a truthy token must refuse rather than silently pick one.
  assert.equal(buildTurnMessage(input()).fields.param4, 0);
  assert.equal(buildTurnMessage(input({ relative: false })).fields.param4, 0);
  assert.equal(buildTurnMessage(input({ relative: true })).fields.param4, 1);
  for (const bad of ['yes', 1, 'true']) {
    assert.throws(
      () => buildTurnMessage(input({ relative: bad })),
      /relative must be boolean/,
      `relative ${JSON.stringify(bad)} must refuse`
    );
  }
});

test('turn does not range-check the heading — the vehicle judges it, the editor warns', () => {
  // ArduCopter answers MAV_RESULT_FAILED outside 0-360, so the range lives in
  // the editor (mavlink-move.html `heading`). The driver coerces and sends: it
  // is a legal message and the vehicle's answer is the feedback (§2).
  assert.equal(buildTurnMessage(input({ heading: 400 })).fields.param1, 400);
  assert.equal(buildTurnMessage(input({ heading: -20 })).fields.param1, -20);
  // Non-numeric is a different thing — it would serialize as garbage.
  assert.throws(() => buildTurnMessage(input({ heading: 'north' })), /expected a finite number/);
  assert.throws(() => buildTurnMessage(input({ rate: 'fast' })), /expected a finite number/);
});
