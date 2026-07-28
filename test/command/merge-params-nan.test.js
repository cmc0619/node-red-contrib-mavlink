'use strict';

/**
 * Config params JSON cannot carry bare NaN — examples store "NaN" strings.
 * mergeParams (inside mavlink-command) must Number() them so DO_ORBIT center
 * and DO_REPOSITION yaw sentinels become real NaN, not the string "NaN".
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildParamArray, getPreset } = require('../../lib/command/presets');

/** Mirror of nodes/mavlink-command.js mergeParams coerce for config.params. */
function coerceConfigParams(json) {
  const out = {};
  const raw = JSON.parse(json);
  for (const [k, v] of Object.entries(raw)) {
    const idx = Number(k);
    if (Number.isInteger(idx) && idx >= 1 && idx <= 7) out[idx] = Number(v);
  }
  return out;
}

test('orbit params with JSON "NaN" center coerce to numeric NaN in the param array', () => {
  const user = coerceConfigParams(
    '{"1":100,"2":5,"3":0,"5":"NaN","6":"NaN","7":"NaN"}'
  );
  const arr = buildParamArray(getPreset('orbit'), user);
  assert.equal(arr[0], 100);
  assert.equal(arr[1], 5);
  assert.equal(arr[2], 0);
  assert.ok(Number.isNaN(arr[4]), 'param5 lat must be NaN');
  assert.ok(Number.isNaN(arr[5]), 'param6 lon must be NaN');
  assert.ok(Number.isNaN(arr[6]), 'param7 alt must be NaN');
});

test('absent orbit center defaults to 0 (ocean) — examples must send NaN explicitly', () => {
  const arr = buildParamArray(getPreset('orbit'), { 1: 100, 2: 5, 3: 0 });
  assert.deepEqual(arr, [100, 5, 0, 0, 0, 0, 0]);
});
