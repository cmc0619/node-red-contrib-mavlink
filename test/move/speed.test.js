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

test('speed type is total by construction — a blank or unknown token is groundspeed', () => {
  // Groundspeed is the reading that means something on every family; airspeed
  // is a fixed-wing concept. Coerced rather than checked, like frameForAltRef:
  // there is a defined answer to give, so nothing throws.
  for (const unknown of [undefined, null, '', 'sideways', 'AIRSPEED', 7, {}]) {
    assert.equal(
      buildSpeedMessage(input({ speedType: unknown })).fields.param1,
      1,
      `${JSON.stringify(unknown)} resolves to groundspeed`
    );
  }
  // Prototype keys must not resolve either — a plain object inherits
  // 'constructor', and hasOwnProperty is why that lands on groundspeed rather
  // than becoming a function.
  assert.equal(buildSpeedMessage(input({ speedType: 'constructor' })).fields.param1, 1);
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
