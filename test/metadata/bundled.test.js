'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const {
  knownDialects,
  loadBundled,
  seedRoot,
  readManifest,
  seedStamp,
} = require('../../lib/metadata/bundled');

const CORE = [
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

test('seed ships as a single gzipped blob with stamp + MIT notice', () => {
  const blob = seedRoot();
  assert.ok(blob.endsWith('mavlink.seed.gz'));
  assert.ok(fs.existsSync(blob));
  const manifest = readManifest();
  assert.equal(manifest.license, 'MIT');
  assert.ok(manifest.commit && manifest.commit.length >= 7);
  assert.ok(manifest.stamp);
  assert.equal(seedStamp(), manifest.stamp);
  assert.ok(manifest.dialects.length >= CORE.length);
});

test('knownDialects lists every seeded dialect, including the classic ten', () => {
  const names = knownDialects();
  for (const name of CORE) {
    assert.ok(names.includes(name), `missing ${name}`);
  }
  assert.ok(names.includes('cubepilot'));
  assert.ok(names.includes('csairlink'));
});

test('seeded dialects load with real include files and provenance', () => {
  for (const name of CORE) {
    const bundle = loadBundled(name);
    assert.equal(bundle.dialect, name);
    assert.ok(bundle.fetched && bundle.fetched.commit);
    assert.ok(bundle.files.length >= 1);
    assert.ok(
      bundle.files[bundle.files.length - 1].toLowerCase().startsWith(name),
      `${name} entry should be last in files`
    );
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
  assert.ok(bundle.messages.HEARTBEAT);
  assert.ok(bundle.enums.MAV_AUTOPILOT);
  assert.ok(
    bundle.enums.MAV_AUTOPILOT.entries.some(
      (e) => e.name === 'MAV_AUTOPILOT_ARDUPILOTMEGA' && e.value === 3
    )
  );
  assert.deepEqual(bundle.files, ['minimal.xml', 'standard.xml', 'common.xml']);
});

test('messagesById maps a string key to a name — messagesById["0"] is HEARTBEAT', () => {
  const bundle = loadBundled('common');
  assert.equal(bundle.messagesById['0'], 'HEARTBEAT');
  assert.equal(bundle.messages.HEARTBEAT.id, 0);
});

test('XML field enums survive compile — HEARTBEAT.type -> MAV_TYPE', () => {
  const fields = loadBundled('common').messages.HEARTBEAT.fields;
  const type = fields.find((f) => f.name === 'type');
  assert.equal(type.enum, 'MAV_TYPE');
  assert.equal(type.type, 'uint8_t');
  const custom = fields.find((f) => f.name === 'custom_mode');
  assert.equal(custom.enum, null);
});

test('bitmask detection: MAV_MODE_FLAG is a bitmask, MAV_TYPE is not', () => {
  const bundle = loadBundled('common');
  assert.equal(bundle.enums.MAV_MODE_FLAG.bitmask, true);
  assert.equal(bundle.enums.MAV_TYPE.bitmask, false);
  const baseMode = bundle.messages.HEARTBEAT.fields.find((f) => f.name === 'base_mode');
  assert.equal(baseMode.enum, 'MAV_MODE_FLAG');
});

test('command-param enums come from XML — DO_CHANGE_SPEED / ARM / REPOSITION', () => {
  const common = loadBundled('common');
  const speed = common.commands.MAV_CMD_DO_CHANGE_SPEED;
  assert.equal(speed.params.find((p) => p.index === 1).enum, 'SPEED_TYPE');
  assert.equal(speed.params.find((p) => p.index === 1).label, 'Speed Type');
  assert.equal(speed.params.find((p) => p.index === 2).units, 'm/s');
  assert.equal(
    common.commands.MAV_CMD_COMPONENT_ARM_DISARM.params.find((p) => p.index === 1).enum,
    'MAV_BOOL'
  );
  const repo = common.commands.MAV_CMD_DO_REPOSITION;
  assert.equal(repo.params.find((p) => p.index === 2).enum, 'MAV_DO_REPOSITION_FLAGS');
  assert.equal(repo.params.find((p) => p.index === 5).enum, null);
});

test('never assume a dialect includes common.xml — icarous is self-contained', () => {
  const bundle = loadBundled('icarous');
  assert.deepEqual(bundle.files, ['icarous.xml']);
  assert.ok(bundle.messages.ICAROUS_HEARTBEAT);
  assert.equal(bundle.messages.HEARTBEAT, undefined);
});

test('ardupilotmega include closure follows upstream (uAvionix, icarous, …)', () => {
  const bundle = loadBundled('ardupilotmega');
  assert.ok(bundle.files.includes('uAvionix.xml'));
  assert.ok(bundle.files.includes('icarous.xml'));
  assert.ok(bundle.messages.ICAROUS_HEARTBEAT);
  assert.ok(bundle.messages.HEARTBEAT);
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

test('a seeded bundle is plain JSON-serializable data', () => {
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(loadBundled('ardupilotmega'))));
});
