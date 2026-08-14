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




