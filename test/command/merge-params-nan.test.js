'use strict';

/**
 * Config params JSON cannot carry bare NaN — examples store "NaN" strings.
 * mergeParams must Number() them so DO_ORBIT center and DO_REPOSITION yaw
 * sentinels become real NaN, not the string "NaN".
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeParams } = require('../../lib/command/merge-params');
const { buildParamArray, getPreset } = require('../../lib/command/presets');

test('orbit params with JSON "NaN" center coerce to numeric NaN in the param array', () => {
  const user = mergeParams(
    { params: '{"1":100,"2":5,"3":0,"5":"NaN","6":"NaN","7":"NaN"}' },
    null
  );
  const arr = buildParamArray(getPreset('orbit'), user);
  assert.equal(arr[0], 100);
  assert.equal(arr[1], 5);
  assert.equal(arr[2], 0);
  assert.ok(Number.isNaN(arr[4]), 'param5 lat must be NaN');
  assert.ok(Number.isNaN(arr[5]), 'param6 lon must be NaN');
  assert.ok(Number.isNaN(arr[6]), 'param7 alt must be NaN');
});

test('absent orbit center refuses — blank must not become 0,0 (issue #88)', () => {
  const user = mergeParams({ params: '{"1":100,"2":5,"3":0}' }, null);
  assert.throws(
    () => buildParamArray(getPreset('orbit'), user),
    /blank coordinates must not become 0,0/
  );
});

test('undefined payload override does not wipe a configured value into NaN', () => {
  const user = mergeParams(
    { params: '{"5":47.5}' },
    { 5: undefined }
  );
  assert.equal(user[5], 47.5);
});

test('payload override wins over config', () => {
  const user = mergeParams(
    { params: '{"1":100,"5":"NaN"}' },
    { 1: 50, 5: -35.36 }
  );
  assert.equal(user[1], 50);
  assert.equal(user[5], -35.36);
});
