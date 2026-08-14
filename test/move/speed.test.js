'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildSpeedMessage } = require('../../lib/move');

const target = { sysid: 5, compid: 1 };

/** A valid speed input; override per test. */
function input(overrides = {}) {
  return { speed: 12, target, ...overrides };
}

test('speed builds COMMAND_LONG / DO_CHANGE_SPEED with SPEED_TYPE in param1', () => {
  const message = buildSpeedMessage(input({ speedType: 'airspeed', throttle: 60 }));
  assert.equal(message.name, 'COMMAND_LONG');
  assert.equal(message.fields.command, 178);
  assert.equal(message.fields.target_system, 5);
  assert.equal(message.fields.target_component, 1);
  assert.equal(message.fields.param1, 0, 'SPEED_TYPE_AIRSPEED');
  assert.equal(message.fields.param2, 12);
  assert.equal(message.fields.param3, 60);
});

test('speed types map to the dialect enum', () => {
  const typeOf = (speedType) => buildSpeedMessage(input({ speedType })).fields.param1;
  assert.equal(typeOf('airspeed'), 0);
  assert.equal(typeOf('groundspeed'), 1);
  assert.equal(typeOf('climb'), 2);
  assert.equal(typeOf('descent'), 3);
});

test('speed blank sentinels: speed and throttle both −1 (no change)', () => {
  const blanks = buildSpeedMessage({ target });
  assert.equal(blanks.fields.param2, -1, 'blank speed → no change');
  assert.equal(blanks.fields.param3, -1, 'blank throttle → no change');
  // −2 is the dialect's "return to default" — a real value an operator types,
  // not a sentinel this node owns, so it passes straight through.
  assert.equal(buildSpeedMessage(input({ speed: -2 })).fields.param2, -2);
  // An explicit 0 is a commanded stop, not a blank.
  assert.equal(buildSpeedMessage(input({ speed: 0 })).fields.param2, 0);
});

test('speed type: blank is groundspeed, an unknown token fails loudly', () => {
  // Groundspeed is the reading that means something on every family; airspeed
  // is a fixed-wing concept. So a *blank* has a defined answer and coerces.
  for (const blank of [undefined, null, '']) {
    assert.equal(
      buildSpeedMessage(input({ speedType: blank })).fields.param1,
      1,
      `${JSON.stringify(blank)} resolves to groundspeed`
    );
  }
  // An unrecognised token does not (owner ruling, 2026-08-14). It used to land
  // on groundspeed, which answered a question nobody asked: payload.speedType
  // overrides the editor-validated config, so a typo'd 'airsped' became a
  // groundspeed command silently. A token that is not in the enum has no
  // meaning, so there is nothing safe to coerce *to*.
  for (const unknown of ['sideways', 'AIRSPEED', 7, {}]) {
    assert.throws(
      () => buildSpeedMessage(input({ speedType: unknown })),
      /unknown Move speed type/,
      `${JSON.stringify(unknown)} fails loudly`
    );
  }
  // Prototype keys are not members — hasOwnProperty is why 'constructor' is
  // rejected rather than resolving to a function.
  assert.throws(() => buildSpeedMessage(input({ speedType: 'constructor' })), /unknown Move speed type/);
});

test('speed asks no firmware question, and refuses only what would serialize as garbage', () => {
  // DO_CHANGE_SPEED is standard on both stacks and every moving family, so
  // unlike Turn there is nothing to derive and nothing to fail closed on.
  for (const firmware of ['ardupilot', 'px4', undefined]) {
    assert.equal(buildSpeedMessage(input({ firmware })).fields.command, 178);
  }
  assert.throws(() => buildSpeedMessage(input({ speed: 'fast' })), /expected a finite number/);
  assert.throws(() => buildSpeedMessage(input({ throttle: 'full' })), /expected a finite number/);
});
