'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  listCommandsForDialect,
  resolveBundledDialect,
  commandLabel,
} = require('../../lib/metadata');

test('commandLabel strips MAV_CMD_ and shows the value in parentheses (§6)', () => {
  assert.equal(commandLabel('MAV_CMD_NAV_TAKEOFF', 22), 'NAV_TAKEOFF (22)');
  assert.equal(commandLabel('MAV_CMD_COMPONENT_ARM_DISARM', 400), 'COMPONENT_ARM_DISARM (400)');
});

test('resolveBundledDialect allow-lists known names and rejects unknown ones (§6)', () => {
  assert.equal(resolveBundledDialect('ardupilotmega'), 'ardupilotmega');
  assert.throws(() => resolveBundledDialect('../etc/passwd'), /unknown dialect/);
  assert.throws(() => resolveBundledDialect(''), /unknown dialect/);
});

test('listCommandsForDialect returns sorted MAV_CMD entries for ardupilotmega', () => {
  const list = listCommandsForDialect('ardupilotmega');
  assert.ok(list.length > 50, `expected a full MAV_CMD table, got ${list.length}`);
  const arm = list.find((c) => c.value === 400);
  assert.ok(arm, 'COMPONENT_ARM_DISARM (400) is present');
  assert.match(arm.label, /ARM_DISARM \(400\)/);
  const takeoff = list.find((c) => c.value === 22);
  assert.ok(takeoff, 'NAV_TAKEOFF (22) is present');
  // Sorted by numeric value.
  for (let i = 1; i < list.length; i += 1) {
    assert.ok(list[i].value >= list[i - 1].value, 'commands are sorted by value');
  }
});
