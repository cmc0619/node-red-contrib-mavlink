'use strict';

/**
 * heartbeatFields — Local Identity heartbeat content (DESIGN.md §7 Heartbeat).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { heartbeatFields, ROLE_PRESETS } = require('../../lib/identity');

test('GCS preset produces MAV_TYPE_GCS heartbeat with MAV_AUTOPILOT_INVALID', () => {
  const fields = heartbeatFields(ROLE_PRESETS.gcs);
  assert.equal(fields.type, 'MAV_TYPE_GCS');
  assert.equal(fields.autopilot, 'MAV_AUTOPILOT_INVALID');
});

test('companion preset produces MAV_TYPE_ONBOARD_CONTROLLER heartbeat', () => {
  const fields = heartbeatFields(ROLE_PRESETS.companion);
  assert.equal(fields.type, 'MAV_TYPE_ONBOARD_CONTROLLER');
  assert.equal(fields.autopilot, 'MAV_AUTOPILOT_INVALID');
});

test('mavlink_version is always 3', () => {
  assert.equal(heartbeatFields(ROLE_PRESETS.gcs).mavlink_version, 3);
  assert.equal(heartbeatFields(ROLE_PRESETS.companion).mavlink_version, 3);
});

test('system_status defaults to MAV_STATE_ACTIVE', () => {
  const fields = heartbeatFields(ROLE_PRESETS.gcs);
  assert.equal(fields.system_status, 'MAV_STATE_ACTIVE');
});

test('base_mode is 0 for non-flight-controller roles', () => {
  assert.equal(heartbeatFields(ROLE_PRESETS.gcs).base_mode, 0);
  assert.equal(heartbeatFields(ROLE_PRESETS.companion).base_mode, 0);
});

test('custom_mode is 0', () => {
  assert.equal(heartbeatFields(ROLE_PRESETS.gcs).custom_mode, 0);
});

test('heartbeatFields picks up type and autopilot from arbitrary identity', () => {
  const fields = heartbeatFields({
    heartbeatType: 'MAV_TYPE_GIMBAL',
    heartbeatAutopilot: 'MAV_AUTOPILOT_INVALID',
  });
  assert.equal(fields.type, 'MAV_TYPE_GIMBAL');
  assert.equal(fields.autopilot, 'MAV_AUTOPILOT_INVALID');
});
