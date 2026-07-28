'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { knownDialects, loadBundled } = require('../../lib/metadata');

/**
 * Registry-load pain points and ground truths (DESIGN.md §4, §13, §14): all ten
 * bundled dialects assemble from `mavlink-mappings`; the include-chain merge
 * surfaces HEARTBEAT / MAV_AUTOPILOT on `common` (they live in `minimal.xml`);
 * `.d.ts` recovery fills field->enum; the control-hint table supplies
 * DO_CHANGE_SPEED param 1 -> SPEED_TYPE; an unknown dialect fails loud.
 */

const TEN = [
  'minimal',
  'standard',
  'common',
  'ardupilotmega',
  'uavionix',
  'icarous',
  'asluav',
  'development',
  'ualberta',
  'storm32',
];

test('knownDialects lists exactly the ten bundled dialects', () => {
  assert.deepEqual(knownDialects().sort(), [...TEN].sort());
});

test('all ten bundled dialects assemble with the entry module last and no fetch/overrides', () => {
  for (const name of TEN) {
    const bundle = loadBundled(name);
    assert.equal(bundle.dialect, name);
    assert.equal(bundle.version, null);
    assert.equal(bundle.fetched, null);
    assert.deepEqual(bundle.overrides, []);
    assert.equal(bundle.files[bundle.files.length - 1], name);
    assert.ok(Object.keys(bundle.enums).length > 0, `${name} has enums`);
    assert.ok(Object.keys(bundle.messages).length > 0, `${name} has messages`);
  }
});

test('bundles are memoized — the same object is returned on a second load', () => {
  assert.equal(loadBundled('common'), loadBundled('common'));
});

test('an unknown dialect fails loud, naming the available set (no common fallback)', () => {
  assert.throws(() => loadBundled('px4'), /Unknown bundled dialect 'px4'.*Available:/s);
});

test('HEARTBEAT and MAV_AUTOPILOT resolve when loading common — they live in minimal.xml', () => {
  const bundle = loadBundled('common');
  assert.ok(bundle.messages.HEARTBEAT, 'HEARTBEAT present via include merge');
  assert.ok(bundle.enums.MAV_AUTOPILOT, 'MAV_AUTOPILOT present via include merge');
  assert.equal(bundle.enums.MAV_AUTOPILOT.name, 'MAV_AUTOPILOT');
  assert.ok(bundle.enums.MAV_AUTOPILOT.entries.some((e) => e.name === 'MAV_AUTOPILOT_ARDUPILOTMEGA' && e.value === 3));
});

test('messagesById maps a string key to a name — messagesById["0"] is HEARTBEAT', () => {
  const bundle = loadBundled('common');
  assert.equal(bundle.messagesById['0'], 'HEARTBEAT');
  assert.equal(bundle.messages.HEARTBEAT.id, 0);
});

test('.d.ts recovery fills a message field enum — HEARTBEAT.type -> MAV_TYPE', () => {
  const fields = loadBundled('common').messages.HEARTBEAT.fields;
  const type = fields.find((f) => f.name === 'type');
  assert.equal(type.enum, 'MAV_TYPE');
  assert.equal(type.type, 'uint8_t');
  const custom = fields.find((f) => f.name === 'custom_mode');
  assert.equal(custom.enum, null, 'a plain wire field has no enum');
});

test('bitmask detection: MAV_MODE_FLAG is a bitmask, MAV_TYPE is not; base_mode displays bitmask', () => {
  const bundle = loadBundled('common');
  assert.equal(bundle.enums.MAV_MODE_FLAG.bitmask, true);
  assert.equal(bundle.enums.MAV_TYPE.bitmask, false);
  const baseMode = bundle.messages.HEARTBEAT.fields.find((f) => f.name === 'base_mode');
  assert.equal(baseMode.enum, 'MAV_MODE_FLAG');
  assert.equal(baseMode.display, 'bitmask');
});

test('control-hint table gives DO_CHANGE_SPEED param 1 the SPEED_TYPE enum with a recovered label', () => {
  const cmd = loadBundled('common').commands.MAV_CMD_DO_CHANGE_SPEED;
  assert.ok(cmd, 'command present');
  const p1 = cmd.params.find((p) => p.index === 1);
  assert.equal(p1.label, 'Speed Type');
  assert.equal(p1.enum, 'SPEED_TYPE');
  const p2 = cmd.params.find((p) => p.index === 2);
  assert.equal(p2.units, 'm/s', 'units recovered from the command class .d.ts');
});

test('DO_REPOSITION hint maps flags (param 2), not latitude (param 5)', () => {
  const cmd = loadBundled('common').commands.MAV_CMD_DO_REPOSITION;
  assert.equal(cmd.params.find((p) => p.index === 2).enum, 'MAV_DO_REPOSITION_FLAGS');
  assert.equal(cmd.params.find((p) => p.index === 5).enum, null);
});

test('control hints attach verified orbit and reboot enums from the bundled XML', () => {
  const bundle = loadBundled('common');

  assert.ok(bundle.enums.ORBIT_YAW_BEHAVIOUR, 'orbit yaw enum is present in the bundle');
  assert.equal(
    bundle.commands.MAV_CMD_DO_ORBIT.params.find((p) => p.index === 3).enum,
    'ORBIT_YAW_BEHAVIOUR'
  );

  assert.ok(bundle.enums.REBOOT_SHUTDOWN_ACTION, 'reboot action enum is present in the bundle');
  const reboot = bundle.commands.MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN;
  assert.equal(reboot.params.find((p) => p.index === 1).enum, 'REBOOT_SHUTDOWN_ACTION');
  assert.equal(reboot.params.find((p) => p.index === 2).enum, 'REBOOT_SHUTDOWN_ACTION');
});

test('all 85 common.xml command-param enum links are recovered (Arm is MAV_BOOL)', () => {
  const { COMMAND_PARAM_ENUMS } = require('../../lib/metadata/hints');
  let links = 0;
  for (const name of Object.keys(COMMAND_PARAM_ENUMS)) {
    links += Object.keys(COMMAND_PARAM_ENUMS[name]).length;
  }
  assert.equal(links, 85);
  const arm = loadBundled('common').commands.MAV_CMD_COMPONENT_ARM_DISARM;
  assert.equal(arm.params.find((p) => p.index === 1).enum, 'MAV_BOOL');
  assert.equal(
    loadBundled('common').commands.MAV_CMD_DO_CHANGE_ALTITUDE.params.find((p) => p.index === 2)
      .enum,
    'MAV_FRAME'
  );
});

test('never assume a dialect includes common.xml — icarous is self-contained', () => {
  const bundle = loadBundled('icarous');
  assert.deepEqual(bundle.files, ['icarous']);
  assert.ok(bundle.messages.ICAROUS_HEARTBEAT);
  assert.equal(bundle.messages.HEARTBEAT, undefined);
});

test('extension fields are flagged and ordered after base fields — SYS_STATUS', () => {
  const fields = loadBundled('common').messages.SYS_STATUS.fields;
  assert.ok(fields.some((f) => f.extension), 'has extension fields');
  let seenExtension = false;
  for (const f of fields) {
    if (f.extension) {
      seenExtension = true;
    } else {
      assert.equal(seenExtension, false, 'no base field appears after an extension field');
    }
  }
});

test('ardupilotmega extends MAV_CMD with entries common does not carry', () => {
  assert.ok(loadBundled('ardupilotmega').commands.MAV_CMD_NAV_ALTITUDE_WAIT);
  assert.equal(loadBundled('common').commands.MAV_CMD_NAV_ALTITUDE_WAIT, undefined);
});

test('a bundled bundle is plain JSON-serializable data', () => {
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(loadBundled('ardupilotmega'))));
});
