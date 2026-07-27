'use strict';

/**
 * Role presets and uint8 validation tests (DESIGN.md §7, §13).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { ROLE_PRESETS, normalizeRole, rolePreset, parseIdentityUint8 } = require('../../lib/identity');

/* ---------- ROLE_PRESETS shape ---------- */

test('ROLE_PRESETS contains gcs, companion, and custom', () => {
  assert.ok('gcs' in ROLE_PRESETS);
  assert.ok('companion' in ROLE_PRESETS);
  assert.ok('custom' in ROLE_PRESETS);
});

test('GCS preset: sysid 255, compid 190, does not derive from vehicle', () => {
  const p = ROLE_PRESETS.gcs;
  assert.equal(p.sysid, 255);
  assert.equal(p.compid, 190);
  assert.equal(p.derivesSysidFromVehicle, false);
  assert.equal(p.heartbeatType, 'MAV_TYPE_GCS');
  assert.equal(p.heartbeatAutopilot, 'MAV_AUTOPILOT_INVALID');
});

test('companion preset: sysid null, compid 191, derives from vehicle', () => {
  const p = ROLE_PRESETS.companion;
  assert.equal(p.sysid, null);
  assert.equal(p.compid, 191);
  assert.equal(p.derivesSysidFromVehicle, true);
  assert.equal(p.heartbeatType, 'MAV_TYPE_ONBOARD_CONTROLLER');
  assert.equal(p.heartbeatAutopilot, 'MAV_AUTOPILOT_INVALID');
});

test('custom preset: derivesSysidFromVehicle false', () => {
  assert.equal(ROLE_PRESETS.custom.derivesSysidFromVehicle, false);
});

/* ---------- normalizeRole ---------- */

test('normalizeRole passes through known roles', () => {
  assert.equal(normalizeRole('gcs'), 'gcs');
  assert.equal(normalizeRole('companion'), 'companion');
  assert.equal(normalizeRole('custom'), 'custom');
});

test('normalizeRole returns custom for unknown input', () => {
  assert.equal(normalizeRole('unknown'), 'custom');
  assert.equal(normalizeRole(''), 'custom');
  assert.equal(normalizeRole(undefined), 'custom');
  assert.equal(normalizeRole(null), 'custom');
});

/* ---------- rolePreset ---------- */

test('rolePreset returns the correct preset for each known role', () => {
  assert.equal(rolePreset('gcs'), ROLE_PRESETS.gcs);
  assert.equal(rolePreset('companion'), ROLE_PRESETS.companion);
  assert.equal(rolePreset('custom'), ROLE_PRESETS.custom);
});

test('rolePreset falls back to custom for unknown role', () => {
  assert.equal(rolePreset('bogus'), ROLE_PRESETS.custom);
});

/* ---------- parseIdentityUint8 ---------- */

test('parseIdentityUint8: undefined → fallback with no error', () => {
  const r = parseIdentityUint8(undefined, 'SysID', 255);
  assert.equal(r.value, 255);
  assert.equal(r.error, null);
});

test('parseIdentityUint8: null → fallback with no error', () => {
  const r = parseIdentityUint8(null, 'SysID', 255);
  assert.equal(r.value, 255);
  assert.equal(r.error, null);
});

test('parseIdentityUint8: empty string → fallback with no error', () => {
  const r = parseIdentityUint8('', 'SysID', 255);
  assert.equal(r.value, 255);
  assert.equal(r.error, null);
});

test('parseIdentityUint8: valid value 1 → { value: 1, error: null }', () => {
  const r = parseIdentityUint8(1, 'SysID', 255);
  assert.equal(r.value, 1);
  assert.equal(r.error, null);
});

test('parseIdentityUint8: valid value 255 → { value: 255, error: null }', () => {
  const r = parseIdentityUint8(255, 'SysID', 255);
  assert.equal(r.value, 255);
  assert.equal(r.error, null);
});

test('parseIdentityUint8: string representation of valid int → ok', () => {
  const r = parseIdentityUint8('42', 'SysID', 255);
  assert.equal(r.value, 42);
  assert.equal(r.error, null);
});

test('parseIdentityUint8: 0 with min=1 (source id) → error', () => {
  const r = parseIdentityUint8(0, 'SysID', 255, 1);
  assert.notEqual(r.error, null);
  assert.ok(r.error.includes('SysID'));
});

test('parseIdentityUint8: 256 → error', () => {
  const r = parseIdentityUint8(256, 'SysID', 255);
  assert.notEqual(r.error, null);
});

test('parseIdentityUint8: -1 with min=1 → error', () => {
  const r = parseIdentityUint8(-1, 'SysID', 255, 1);
  assert.notEqual(r.error, null);
});

test('parseIdentityUint8: non-numeric string → error naming the field', () => {
  const r = parseIdentityUint8('abc', 'SysID', 255);
  assert.notEqual(r.error, null);
  assert.ok(r.error.includes('SysID'));
});

test('parseIdentityUint8: float 1.5 → error', () => {
  const r = parseIdentityUint8(1.5, 'SysID', 255);
  assert.notEqual(r.error, null);
});

test('parseIdentityUint8: error returns fallback value', () => {
  const r = parseIdentityUint8(999, 'SysID', 42);
  assert.equal(r.value, 42);
  assert.notEqual(r.error, null);
});
