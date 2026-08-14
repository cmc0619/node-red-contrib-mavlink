'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildTurnMessage } = require('../../lib/move');

const target = { sysid: 5, compid: 1 };

/** A valid turn input; override per test. */
function input(overrides = {}) {
  return { heading: 90, target, ...overrides };
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




