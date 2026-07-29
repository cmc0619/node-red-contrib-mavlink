'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isFalseTrueEnum } = require('../../lib/metadata/naming');

test('MAV_BOOL entries are false/true', () => {
  assert.equal(isFalseTrueEnum([
    { name: 'MAV_BOOL_FALSE', value: 0 },
    { name: 'MAV_BOOL_TRUE', value: 1 },
  ]), true);
});

test('additive bitmask without FALSE/TRUE is not false/true', () => {
  assert.equal(isFalseTrueEnum([
    { name: 'MAV_DO_REPOSITION_FLAGS_CHANGE_MODE', value: 1 },
    { name: 'MAV_DO_REPOSITION_FLAGS_RELATIVE_YAW', value: 2 },
  ]), false);
});

test('accepts bare FALSE/TRUE names', () => {
  assert.equal(isFalseTrueEnum([{ name: 'FALSE', value: 0 }, { name: 'TRUE', value: 1 }]), true);
});

test('empty or missing is false', () => {
  assert.equal(isFalseTrueEnum([]), false);
  assert.equal(isFalseTrueEnum(null), false);
});

test('three-entry TRUE/FALSE tables are not boolean controls', () => {
  assert.equal(isFalseTrueEnum([
    { name: 'GIMBAL_AXIS_CALIBRATION_REQUIRED_UNKNOWN', value: 0 },
    { name: 'GIMBAL_AXIS_CALIBRATION_REQUIRED_TRUE', value: 1 },
    { name: 'GIMBAL_AXIS_CALIBRATION_REQUIRED_FALSE', value: 2 },
  ]), false);
});

test('FALSE/TRUE with non-0/1 values are not boolean controls', () => {
  assert.equal(isFalseTrueEnum([
    { name: 'FLAG_FALSE', value: 2 },
    { name: 'FLAG_TRUE', value: 1 },
  ]), false);
});
