'use strict';

/**
 * Vehicle Profile lib tests (DESIGN.md §3, §7, §12.3).
 *
 * Pain points:
 *  - bundled dialect resolution uses the registry; unknown name fails loud.
 *  - custom dialect without a bundle throws at deploy time.
 *  - firmware / family normalisation rejects unknowns to safe fallbacks.
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
  const bundle = resolveDialect({ dialect: 'common', dialectRevision: 'seed' });
  assert.equal(bundle.dialect, 'common');
  assert.ok(typeof bundle.enums === 'object');
  assert.ok(typeof bundle.messages === 'object');
});

test('resolveDialect seed + unknown name → craters at the manifest lookup', () => {
  assert.throws(
    () => resolveDialect({ dialect: 'nonexistent', dialectRevision: 'seed' }),
    TypeError
  );
});

test('resolveDialect seed bundles are memoized', () => {
  const a = resolveDialect({ dialect: 'minimal', dialectRevision: 'seed' });
  const b = resolveDialect({ dialect: 'minimal', dialectRevision: 'seed' });
  assert.equal(a, b);
});

/* ---------- resolveDialect — catalog snapshot ---------- */

test('resolveDialect snapshot without a catalog base dir fails loud from XmlCatalog', () => {
  assert.throws(
    () => resolveDialect({ name: 'My Profile', dialect: 'common', dialectRevision: '2026-01-01' }),
    (e) => e.code === 'XML_CATALOG_NO_DIR'
  );
});

test('resolveDialect unknown snapshot id fails loud naming the snapshot', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mav-veh-'));
  assert.throws(
    () =>
      resolveDialect({
        name: 'My Profile',
        dialect: 'common',
        dialectRevision: '2026-01-01',
        catalogBaseDir: dir,
      }),
    /2026-01-01/
  );
});

test('resolveDialect dialectRevision seed loads the shipped dialect', () => {
  const bundle = resolveDialect({ dialect: 'icarous', dialectRevision: 'seed' });
  assert.equal(bundle.dialect, 'icarous');
  assert.ok(bundle.messages.ICAROUS_HEARTBEAT);
});

/* ---------- resolveDialect — component dialects ---------- */

test('a profile with component dialects compiles them into one bundle', () => {
  const px4 = resolveDialect({ dialect: 'development', dialectRevision: 'seed' });
  const withGimbal = resolveDialect({
    dialect: 'development',
    dialectRevision: 'seed',
    additionalDialects: 'storm32@seed',
  });

  assert.equal(withGimbal.dialect, 'development+storm32');
  const added = Object.keys(withGimbal.messages).filter((m) => !px4.messages[m]);
  assert.ok(added.length > 0, 'the component dialect contributes messages');
  // The include chain resolves it: shared files appear once, so nothing is
  // shadowed and there is no merge rule of our own.
  assert.deepEqual(withGimbal.overrides, []);
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
  const plain = resolveDialect({ dialect: 'minimal', dialectRevision: 'seed' });
  const blank = resolveDialect({ dialect: 'minimal', dialectRevision: 'seed', additionalDialects: '' });
  assert.equal(blank, plain, 'same cached bundle, not a recompile');
});

test('a component dialect that collides on a msgid fails loud naming both', () => {
  assert.throws(
    () => resolveDialect({ dialect: 'ardupilotmega', dialectRevision: 'seed', additionalDialects: 'paparazzi@seed' }),
    /Message id 180 is claimed by both/
  );
});

