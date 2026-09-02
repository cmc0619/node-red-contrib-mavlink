'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  listCommandsCatalog,
  catalogFromBundle,
  loadBundled,
  commandLabel,
  isHiddenParam,
} = require('../../lib/metadata');
const { enumOptionLabel } = require('../../lib/metadata/commands-list');

test('commandLabel shows the full command name and value in parentheses (§6)', () => {
  assert.equal(commandLabel('MAV_CMD_NAV_TAKEOFF', 22), 'MAV_CMD_NAV_TAKEOFF (22)');
  assert.equal(commandLabel('MAV_CMD_COMPONENT_ARM_DISARM', 400), 'MAV_CMD_COMPONENT_ARM_DISARM (400)');
});

test('isHiddenParam follows the §6 reserved / Empty / Reserved cases', () => {
  assert.equal(isHiddenParam({ reserved: true, description: 'Anything' }), true);
  assert.equal(isHiddenParam({ reserved: false, description: 'Empty' }), true);
  assert.equal(isHiddenParam({ reserved: false, description: 'Empty.' }), true);
  assert.equal(isHiddenParam({ reserved: false, description: 'Reserved' }), true);
  assert.equal(isHiddenParam({ reserved: false, description: 'Minimum pitch' }), false);
});

test('enumOptionLabel shows the enum entry name and value in parentheses (§6)', () => {
  assert.equal(
    enumOptionLabel({ name: 'SPEED_TYPE_AIRSPEED', value: 0, description: 'Airspeed' }),
    'SPEED_TYPE_AIRSPEED (0)'
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
  const airspeed = catalog.enums.SPEED_TYPE.find((e) => e.value === 0);
  assert.ok(airspeed && airspeed.label === 'SPEED_TYPE_AIRSPEED (0)');
  assert.equal(typeof airspeed.description, 'string');
  assert.ok(airspeed.description.length > 0, 'nested command-catalog enums carry seed descriptions');

  // Active params carry labels/descriptions; reserved slots may be blank.
  for (const p of changeSpeed.params) {
    if (p.reserved) continue;
    assert.ok(p.label || p.description, 'every active param has a label or description');
  }
});

test('seed carries common.xml command-param enum= links (no hints.js overlay)', () => {
  const bundle = loadBundled('common');
  const arm = bundle.commands.MAV_CMD_COMPONENT_ARM_DISARM;
  assert.ok(arm, 'ARM command present in common seed');
  const armParam = arm.params.find((p) => Number(p.index) === 1);
  assert.equal(armParam && armParam.enum, 'MAV_BOOL', 'Arm param enum comes from seed XML');

  const changeSpeed = bundle.commands.MAV_CMD_DO_CHANGE_SPEED;
  const speedType = changeSpeed.params.find((p) => Number(p.index) === 1);
  assert.equal(speedType && speedType.enum, 'SPEED_TYPE');
});

test('catalogFromBundle works for any DialectBundle (custom profiles inclusive)', () => {
  const bundle = loadBundled('common');
  const catalog = catalogFromBundle(bundle, 'common');
  assert.equal(catalog.dialect, 'common');
  assert.ok(catalog.commands.some((c) => c.value === 400));
});

/**
 * Stable local DialectBundle — does not depend on mavlink-mappings contents.
 * Covers hidden params, enum references, ordering, and custom dialect names.
 */
const FIXTURE_BUNDLE = {
  dialect: 'fixture-custom',
  commands: {
    MAV_CMD_Z_LAST: {
      name: 'MAV_CMD_Z_LAST',
      value: 200,
      description: 'sorts after',
      params: [
        { index: 1, label: 'Empty', description: 'Empty', reserved: false },
        { index: 2, label: 'Speed', description: 'Speed', units: 'm/s', enum: 'FIXTURE_SPEED', reserved: false },
      ],
    },
    MAV_CMD_A_FIRST: {
      name: 'MAV_CMD_A_FIRST',
      value: 100,
      description: 'sorts first',
      params: [
        { index: 1, label: 'Reserved slot', description: 'Reserved', reserved: false },
        { index: 2, label: 'Force', description: 'Force arm', minValue: 0, maxValue: 1, increment: 1, reserved: false },
        { index: 3, label: 'Hidden reserved', description: 'x', reserved: true },
      ],
    },
  },
  enums: {
    FIXTURE_SPEED: {
      name: 'FIXTURE_SPEED',
      entries: [
        { name: 'FIXTURE_SPEED_AIR', value: 0, description: 'Airspeed' },
        { name: 'FIXTURE_SPEED_GROUND', value: 1, description: 'Ground speed' },
      ],
    },
    FIXTURE_FLAGS: {
      name: 'FIXTURE_FLAGS',
      bitmask: true,
      entries: [
        { name: 'FIXTURE_FLAG_ONE', value: 1, description: 'First flag' },
        { name: 'FIXTURE_FLAG_TWO', value: 2, description: 'Second flag' },
      ],
    },
  },
};

test('catalogFromBundle fixture: custom name, ordering, hidden params, enums (§13)', () => {
  const catalog = catalogFromBundle(FIXTURE_BUNDLE, 'fixture-custom');
  assert.equal(catalog.dialect, 'fixture-custom');
  assert.deepEqual(
    catalog.commands.map((c) => c.value),
    [100, 200],
    'commands are ordered by numeric value'
  );

  const first = catalog.commands[0];
  assert.equal(first.label, 'MAV_CMD_A_FIRST (100)');
  const hidden = first.params.filter((p) => p.hidden);
  assert.equal(hidden.length, 2, 'Reserved description and reserved:true are hidden');
  assert.ok(first.params.find((p) => p.index === 2 && p.label === 'Force' && !p.hidden));

  const last = catalog.commands[1];
  const speed = last.params.find((p) => p.index === 2);
  assert.equal(speed.enum, 'FIXTURE_SPEED');
  assert.ok(last.params.find((p) => p.index === 1 && p.hidden), 'Empty description is hidden');
  assert.ok(Array.isArray(catalog.enums.FIXTURE_SPEED));
  assert.ok(catalog.enums.FIXTURE_SPEED.some((e) => e.value === 0 && e.label === 'FIXTURE_SPEED_AIR (0)'));
  assert.equal(Object.keys(catalog.enums).length, 1, 'only referenced enums are included');
});

test('catalogFromBundle marks command params backed by bitmask enums', () => {
  const bundle = {
    dialect: 'fixture-bitmask',
    commands: {
      MAV_CMD_FLAGS: {
        name: 'MAV_CMD_FLAGS',
        value: 300,
        params: [
          { index: 1, label: 'Flags', description: 'Flags', enum: 'FIXTURE_FLAGS' },
        ],
      },
    },
    enums: FIXTURE_BUNDLE.enums,
  };

  const catalog = catalogFromBundle(bundle, 'fixture-bitmask');
  const flags = catalog.commands[0].params[0];

  assert.equal(flags.enum, 'FIXTURE_FLAGS');
  assert.equal(flags.bitmask, true);
  assert.ok(Array.isArray(catalog.enums.FIXTURE_FLAGS), 'enum table shape stays an array');
});
