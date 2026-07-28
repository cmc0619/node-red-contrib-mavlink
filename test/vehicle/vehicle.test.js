'use strict';

/**
 * Vehicle Profile lib tests (DESIGN.md §3, §7, §12.3).
 *
 * Pain points:
 *  - bundled dialect resolution uses the registry; unknown name fails loud.
 *  - custom dialect without a bundle throws at deploy time.
 *  - firmware / family normalisation rejects unknowns to safe fallbacks.
 *  - parseTargetUint8 allows 0 (broadcast) unlike source ids which disallow it.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  FIRMWARE_TYPES,
  VEHICLE_FAMILIES,
  normalizeFirmware,
  normalizeFamily,
  resolveDialect,
  parseTargetUint8,
  knownDialects,
} = require('../../lib/vehicle');

const XML = (body) => `<?xml version="1.0"?>\n<mavlink>${body}</mavlink>`;

/* ---------- knownDialects ---------- */

test('knownDialects returns the 10 bundled dialect names', () => {
  const expected = [
    'minimal', 'standard', 'common', 'ardupilotmega',
    'uavionix', 'icarous', 'asluav', 'development', 'ualberta', 'storm32',
  ];
  const known = knownDialects();
  assert.deepEqual(known.sort(), expected.sort());
});

/* ---------- FIRMWARE_TYPES ---------- */

test('FIRMWARE_TYPES includes ardupilot, px4, custom', () => {
  assert.ok(FIRMWARE_TYPES.includes('ardupilot'));
  assert.ok(FIRMWARE_TYPES.includes('px4'));
  assert.ok(FIRMWARE_TYPES.includes('custom'));
});

/* ---------- VEHICLE_FAMILIES ---------- */

test('VEHICLE_FAMILIES includes copter, plane, rover, boat, sub, generic', () => {
  for (const f of ['copter', 'plane', 'rover', 'boat', 'sub', 'generic']) {
    assert.ok(VEHICLE_FAMILIES.includes(f), `expected ${f} in VEHICLE_FAMILIES`);
  }
});

/* ---------- normalizeFirmware ---------- */

test('normalizeFirmware passes through known values', () => {
  assert.equal(normalizeFirmware('ardupilot'), 'ardupilot');
  assert.equal(normalizeFirmware('px4'), 'px4');
  assert.equal(normalizeFirmware('custom'), 'custom');
});

test('normalizeFirmware returns custom for unknown input', () => {
  assert.equal(normalizeFirmware('unknown'), 'custom');
  assert.equal(normalizeFirmware(''), 'custom');
  assert.equal(normalizeFirmware(undefined), 'custom');
});

/* ---------- normalizeFamily ---------- */

test('normalizeFamily passes through known values', () => {
  for (const f of ['copter', 'plane', 'rover', 'boat', 'sub', 'antenna-tracker', 'generic']) {
    assert.equal(normalizeFamily(f), f);
  }
});

test('normalizeFamily returns generic for unknown input', () => {
  assert.equal(normalizeFamily('drone'), 'generic');
  assert.equal(normalizeFamily(''), 'generic');
  assert.equal(normalizeFamily(undefined), 'generic');
});

/* ---------- resolveDialect — bundled ---------- */

test('resolveDialect bundled + known name → returns DialectBundle', () => {
  const bundle = resolveDialect({ dialectSource: 'bundled', dialect: 'common' });
  assert.equal(bundle.dialect, 'common');
  assert.ok(typeof bundle.enums === 'object');
  assert.ok(typeof bundle.messages === 'object');
});

test('resolveDialect bundled defaults to ardupilotmega when dialect omitted', () => {
  const bundle = resolveDialect({ dialectSource: 'bundled' });
  assert.equal(bundle.dialect, 'ardupilotmega');
});

test('resolveDialect bundled + unknown name → throws naming the dialect', () => {
  assert.throws(
    () => resolveDialect({ dialectSource: 'bundled', dialect: 'nonexistent' }),
    /nonexistent/
  );
});

test('resolveDialect omitted dialectSource → defaults to bundled', () => {
  const bundle = resolveDialect({ dialect: 'minimal' });
  assert.equal(bundle.dialect, 'minimal');
});

test('resolveDialect bundled bundles are memoized', () => {
  const a = resolveDialect({ dialectSource: 'bundled', dialect: 'minimal' });
  const b = resolveDialect({ dialectSource: 'bundled', dialect: 'minimal' });
  assert.equal(a, b);
});

/* ---------- resolveDialect — custom ---------- */

test('resolveDialect custom with bundle → returns the supplied bundle', () => {
  const fakeBundle = { dialect: 'custom-test', enums: {}, messages: {} };
  const result = resolveDialect({
    dialectSource: 'custom',
    customDialectBundle: fakeBundle,
  });
  assert.equal(result, fakeBundle);
});

test('resolveDialect custom with a path → compiles the XML from disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mav-veh-'));
  const base = path.join(dir, 'base.xml');
  const entry = path.join(dir, 'entry.xml');
  fs.writeFileSync(base, XML('<messages><message id="0" name="HEARTBEAT"><field type="uint8_t" name="t">t</field></message></messages>'));
  fs.writeFileSync(entry, XML('<include>base.xml</include><messages><message id="42" name="ENTRY"><field type="uint8_t" name="e">e</field></message></messages>'));

  const bundle = resolveDialect({ dialectSource: 'custom', customDialectPath: entry });
  assert.equal(bundle.dialect, 'entry');
  assert.deepEqual(Object.keys(bundle.messages).sort(), ['ENTRY', 'HEARTBEAT']);
});

test('resolveDialect custom with a bad path → fails loud (never falls back)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mav-veh-'));
  assert.throws(
    () => resolveDialect({ dialectSource: 'custom', customDialectPath: path.join(dir, 'nope.xml') }),
    (e) => e.code === 'XML_DIALECT_READ_FAILED'
  );
});

test('resolveDialect custom prefers a supplied bundle over a path', () => {
  const fakeBundle = { dialect: 'custom-test', enums: {}, messages: {} };
  const result = resolveDialect({
    dialectSource: 'custom',
    customDialectPath: '/does/not/matter.xml',
    customDialectBundle: fakeBundle,
  });
  assert.equal(result, fakeBundle);
});

test('resolveDialect custom without path or bundle → throws mentioning the XML path', () => {
  assert.throws(
    () => resolveDialect({ name: 'My Profile', dialectSource: 'custom' }),
    /xml path/i
  );
});

test('resolveDialect custom without path or bundle names the profile', () => {
  let message = '';
  try {
    resolveDialect({ name: 'My Profile', dialectSource: 'custom' });
  } catch (err) {
    message = err.message;
  }
  assert.ok(message.includes('My Profile'));
});

/* ---------- parseTargetUint8 ---------- */

test('parseTargetUint8: undefined → fallback, no error', () => {
  const r = parseTargetUint8(undefined, 'Target SysID', 1);
  assert.equal(r.value, 1);
  assert.equal(r.error, null);
});

test('parseTargetUint8: 0 is allowed (broadcast)', () => {
  const r = parseTargetUint8(0, 'Target SysID', 1);
  assert.equal(r.value, 0);
  assert.equal(r.error, null);
});

test('parseTargetUint8: 255 is allowed', () => {
  const r = parseTargetUint8(255, 'Target CompID', 1);
  assert.equal(r.value, 255);
  assert.equal(r.error, null);
});

test('parseTargetUint8: 256 → error', () => {
  const r = parseTargetUint8(256, 'Target SysID', 1);
  assert.notEqual(r.error, null);
  assert.equal(r.value, 1);
});

test('parseTargetUint8: -1 → error', () => {
  const r = parseTargetUint8(-1, 'Target SysID', 1);
  assert.notEqual(r.error, null);
});

test('parseTargetUint8: non-numeric string → error naming the field', () => {
  const r = parseTargetUint8('abc', 'Target SysID', 1);
  assert.notEqual(r.error, null);
  assert.ok(r.error.includes('Target SysID'));
});

test('parseTargetUint8: float 1.5 → error', () => {
  const r = parseTargetUint8(1.5, 'Target SysID', 1);
  assert.notEqual(r.error, null);
});
