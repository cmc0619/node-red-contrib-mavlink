'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  listCommandsForDialect,
  listCommandsCatalog,
  catalogFromBundle,
  loadBundled,
  resolveBundledDialect,
  commandLabel,
  isHiddenParam,
  enumOptionLabel,
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

test('isHiddenParam follows the §6 reserved / Empty / Reserved cases', () => {
  assert.equal(isHiddenParam({ reserved: true, description: 'Anything' }), true);
  assert.equal(isHiddenParam({ reserved: false, description: 'Empty' }), true);
  assert.equal(isHiddenParam({ reserved: false, description: 'Empty.' }), true);
  assert.equal(isHiddenParam({ reserved: false, description: 'Reserved' }), true);
  assert.equal(isHiddenParam({ reserved: false, description: 'Minimum pitch' }), false);
});

test('enumOptionLabel prefers description and shows the value in parentheses (§6)', () => {
  assert.equal(
    enumOptionLabel({ name: 'SPEED_TYPE_AIRSPEED', value: 0, description: 'Airspeed' }),
    'Airspeed (0)'
  );
});

test('listCommandsCatalog includes params and referenced enums for Advanced UI', () => {
  const catalog = listCommandsCatalog('ardupilotmega');
  assert.equal(catalog.dialect, 'ardupilotmega');
  assert.ok(catalog.commands.length > 50);

  const arm = catalog.commands.find((c) => c.value === 400);
  assert.ok(arm, 'COMPONENT_ARM_DISARM (400)');
  assert.ok(arm.params.some((p) => p.index === 1 && p.label === 'Arm'));
  assert.ok(arm.params.every((p) => typeof p.hidden === 'boolean'));

  const changeSpeed = catalog.commands.find((c) => c.value === 178);
  assert.ok(changeSpeed, 'DO_CHANGE_SPEED (178)');
  const speedType = changeSpeed.params.find((p) => p.index === 1);
  assert.equal(speedType.enum, 'SPEED_TYPE');
  assert.ok(Array.isArray(catalog.enums.SPEED_TYPE));
  assert.ok(catalog.enums.SPEED_TYPE.some((e) => e.value === 0 && /Airspeed/.test(e.label)));

  // No raw Param-N placeholders — only metadata-backed params.
  for (const p of changeSpeed.params) {
    assert.ok(p.label || p.description, 'every param has a label or description');
  }
});

test('listCommandsForDialect returns the commands array from the catalog', () => {
  const list = listCommandsForDialect('ardupilotmega');
  assert.ok(list.length > 50);
  assert.ok(list.find((c) => c.value === 22));
});

test('catalogFromBundle works for any DialectBundle (custom profiles inclusive)', () => {
  const bundle = loadBundled('common');
  const catalog = catalogFromBundle(bundle, 'common');
  assert.equal(catalog.dialect, 'common');
  assert.ok(catalog.commands.some((c) => c.value === 400));
});
