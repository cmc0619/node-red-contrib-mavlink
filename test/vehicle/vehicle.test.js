'use strict';

/**
 * Vehicle Profile lib tests (DESIGN.md §3, §7, §12.3).
 *
 * Pain points:
 *  - bundled dialect resolution uses the registry; unknown name fails loud.
 *  - custom dialect without a bundle throws at deploy time.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  resolveDialect,
  knownDialects,
} = require('../../lib/vehicle');
const { seedSources } = require('../../lib/metadata/bundled');

/* ---------- knownDialects ---------- */

test('knownDialects returns seeded dialect names including the classic ten', () => {
  const classic = [
    'minimal', 'standard', 'common', 'ardupilotmega',
    'uavionix', 'icarous', 'asluav', 'development', 'ualberta', 'storm32',
  ];
  const known = knownDialects();
  for (const name of classic) {
    assert.ok(known.includes(name), `missing seeded dialect ${name}`);
  }
  assert.ok(known.length >= classic.length);
});

/* ---------- resolveDialect — seed ---------- */

test('resolveDialect seed + known name → returns DialectBundle', () => {
  const bundle = resolveDialect({ dialect: 'common', dialectRevision: 'seed', additionalDialects: '' });
  assert.equal(bundle.dialect, 'common');
  assert.ok(typeof bundle.enums === 'object');
  assert.ok(typeof bundle.messages === 'object');
});

test('resolveDialect seed + unknown name → craters at the manifest lookup', () => {
  assert.throws(
    () => resolveDialect({ dialect: 'nonexistent', dialectRevision: 'seed', additionalDialects: '' }),
    TypeError
  );
});

test('resolveDialect seed bundles are memoized', () => {
  const a = resolveDialect({ dialect: 'minimal', dialectRevision: 'seed', additionalDialects: '' });
  const b = resolveDialect({ dialect: 'minimal', dialectRevision: 'seed', additionalDialects: '' });
  assert.equal(a, b);
});

/* ---------- resolveDialect — catalog snapshot ---------- */

test('resolveDialect unknown snapshot id fails loud naming the snapshot', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mav-veh-'));
  assert.throws(
    () =>
      resolveDialect({
        name: 'My Profile',
        dialect: 'common',
        dialectRevision: '2026-01-01',
        additionalDialects: '',
        catalogBaseDir: dir,
      }),
    /2026-01-01/
  );
});

test('resolveDialect dialectRevision seed loads the shipped dialect', () => {
  const bundle = resolveDialect({ dialect: 'icarous', dialectRevision: 'seed', additionalDialects: '' });
  assert.equal(bundle.dialect, 'icarous');
  assert.ok(bundle.messages.ICAROUS_HEARTBEAT);
});

/* ---------- resolveDialect — component dialects ---------- */

test('a profile with component dialects compiles them into one bundle', () => {
  const px4 = resolveDialect({ dialect: 'development', dialectRevision: 'seed', additionalDialects: '' });
  const withGimbal = resolveDialect({
    dialect: 'development',
    dialectRevision: 'seed',
    additionalDialects: 'storm32@seed',
  });

  assert.equal(withGimbal.dialect, 'development+storm32');
  const added = Object.keys(withGimbal.messages).filter((m) => !px4.messages[m]);
  assert.ok(added.length > 0, 'the component dialect contributes messages');
  // Everything the airframe had survives.
  for (const name of Object.keys(px4.messages)) {
    assert.ok(withGimbal.messages[name], `${name} survives`);
  }
});

test('component dialects are order-independent for a clean set', () => {
  const a = resolveDialect({ dialect: 'common', dialectRevision: 'seed', additionalDialects: 'icarous@seed' });
  assert.ok(a.messages.ICAROUS_HEARTBEAT);
  assert.ok(a.messages.HEARTBEAT);
});

test('a blank additionalDialects field resolves exactly like no field at all', () => {
  const plain = resolveDialect({ dialect: 'minimal', dialectRevision: 'seed', additionalDialects: '' });
  const blank = resolveDialect({ dialect: 'minimal', dialectRevision: 'seed', additionalDialects: '' });
  assert.equal(blank, plain, 'same cached bundle, not a recompile');
});

test('a snapshot component dialect brings only its own include chain, not the whole snapshot', () => {
  // A downloaded snapshot is a whole definitions directory. Layering all of
  // it over the seed made `minimal@seed` + `icarous@<snap>` compile the
  // snapshot's minimal.xml, though icarous includes nothing.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mav-veh-'));
  const id = '2026-09-01-abc';
  fs.mkdirSync(path.join(dir, 'snapshots', id), { recursive: true });
  fs.mkdirSync(path.join(dir, 'manifests'), { recursive: true });
  const files = [];
  for (const [name, text] of Object.entries(seedSources())) {
    const marked = name === 'minimal.xml'
      ? text.replace('<messages>', '<messages><message id="9999" name="SNAPSHOT_ONLY"><description>x</description>'
        + '<field type="uint8_t" name="a">a</field></message>')
      : text;
    fs.writeFileSync(path.join(dir, 'snapshots', id, name), marked);
    files.push({ name });
  }
  fs.writeFileSync(path.join(dir, 'manifests', `${id}.json`), JSON.stringify({ snapshotId: id, files }));
  const profile = (dialect, dialectRevision, additionalDialects) => resolveDialect({
    name: 'P', dialect, dialectRevision, additionalDialects, catalogBaseDir: dir,
  });

  const seedAirframe = profile('minimal', 'seed', `icarous@${id}`);
  assert.ok(seedAirframe.messages.ICAROUS_HEARTBEAT);
  assert.equal(seedAirframe.messages.SNAPSHOT_ONLY, undefined, 'minimal stays the seed revision it was picked at');
  const snapAirframe = profile('minimal', id, 'icarous@seed');
  assert.ok(snapAirframe.messages.SNAPSHOT_ONLY, 'a snapshot pick still takes its own chain from the snapshot');
});

test('a component dialect that collides on a msgid fails loud naming both', () => {
  assert.throws(
    () => resolveDialect({ dialect: 'ardupilotmega', dialectRevision: 'seed', additionalDialects: 'paparazzi@seed' }),
    /Message id 180 is claimed by both/
  );
});

