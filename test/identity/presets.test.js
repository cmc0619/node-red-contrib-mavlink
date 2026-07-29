'use strict';

/**
 * Role presets tests (DESIGN.md §7, §13).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { ROLE_PRESETS, normalizeRole, rolePreset } = require('../../lib/identity');

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
