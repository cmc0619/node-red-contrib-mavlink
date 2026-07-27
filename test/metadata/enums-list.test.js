'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_ENUM_NAMES,
  catalogEnumsFromBundle,
  listEnumsCatalog,
  loadBundled,
} = require('../../lib/metadata');

const FIXTURE_BUNDLE = {
  dialect: 'fixture',
  enums: {
    MAV_TYPE: {
      name: 'MAV_TYPE',
      bitmask: false,
      description: 'Vehicle type',
      entries: [
        { name: 'MAV_TYPE_GENERIC', value: 0, description: 'Generic vehicle.' },
        { name: 'MAV_TYPE_GCS', value: 6, description: 'Ground control station.' },
      ],
    },
    MAV_COMP_ID: {
      name: 'MAV_COMP_ID',
      bitmask: false,
      description: 'Component id',
      entries: [
        { name: 'MAV_COMP_ID_AUTOPILOT1', value: 1, description: 'Autopilot.' },
      ],
    },
    CUSTOM_ENUM: {
      name: 'CUSTOM_ENUM',
      bitmask: true,
      description: 'Custom flags',
      entries: [
        { name: 'CUSTOM_ENUM_ONE', value: 1, description: 'First bit.' },
      ],
    },
  },
};

test('DEFAULT_ENUM_NAMES includes the editor pulldown common set', () => {
  assert.deepEqual(DEFAULT_ENUM_NAMES, [
    'MAV_TYPE',
    'MAV_AUTOPILOT',
    'MAV_COMP_ID',
    'MAV_STATE',
    'MAV_MODE',
    'SPEED_TYPE',
    'CAMERA_MODE',
    'MAV_MOUNT_MODE',
    'ORBIT_YAW_BEHAVIOUR',
    'MAV_DO_REPOSITION_FLAGS',
  ]);
});

test('catalogEnumsFromBundle returns default enums with name/value labels', () => {
  const catalog = catalogEnumsFromBundle(FIXTURE_BUNDLE, 'fixture');

  assert.equal(catalog.dialect, 'fixture');
  assert.deepEqual(Object.keys(catalog.enums), ['MAV_TYPE', 'MAV_COMP_ID']);
  assert.deepEqual(catalog.enums.MAV_TYPE[1], {
    name: 'MAV_TYPE_GCS',
    value: 6,
    label: 'MAV_TYPE_GCS (6)',
    description: 'Ground control station.',
  });
});

test('catalogEnumsFromBundle adds requested names to the default set', () => {
  const catalog = catalogEnumsFromBundle(FIXTURE_BUNDLE, 'fixture', ['CUSTOM_ENUM']);

  assert.ok(catalog.enums.MAV_TYPE, 'default enum remains present');
  assert.deepEqual(catalog.enums.CUSTOM_ENUM[0], {
    name: 'CUSTOM_ENUM_ONE',
    value: 1,
    label: 'CUSTOM_ENUM_ONE (1)',
    description: 'First bit.',
  });
});

test('listEnumsCatalog loads bundled dialect enum entries', () => {
  const catalog = listEnumsCatalog('ardupilotmega', ['MAV_TYPE']);
  const expectedCount = loadBundled('ardupilotmega').enums.MAV_TYPE.entries.length;

  assert.equal(catalog.dialect, 'ardupilotmega');
  assert.equal(catalog.enums.MAV_TYPE.length, expectedCount);
  assert.ok(catalog.enums.MAV_TYPE.some((entry) => entry.label === 'MAV_TYPE_GCS (6)'));
});

test('catalogEnumsFromBundle preserves values outside MAX_SAFE_INTEGER as strings', () => {
  const huge = String(Number.MAX_SAFE_INTEGER + 10);
  const catalog = catalogEnumsFromBundle(
    {
      dialect: 'fixture',
      enums: {
        MAV_TYPE: { entries: [] },
        MAV_AUTOPILOT: { entries: [] },
        MAV_COMP_ID: { entries: [] },
        MAV_STATE: { entries: [] },
        MAV_MODE: { entries: [] },
        SPEED_TYPE: { entries: [] },
        CAMERA_MODE: { entries: [] },
        MAV_MOUNT_MODE: { entries: [] },
        ORBIT_YAW_BEHAVIOUR: { entries: [] },
        MAV_DO_REPOSITION_FLAGS: { entries: [] },
        HUGE_ENUM: { entries: [{ name: 'HUGE_ENUM_X', value: huge, description: '' }] },
      },
    },
    'fixture',
    ['HUGE_ENUM']
  );

  assert.equal(catalog.enums.HUGE_ENUM[0].value, huge);
  assert.equal(typeof catalog.enums.HUGE_ENUM[0].value, 'string');
});
