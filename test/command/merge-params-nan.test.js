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
    {}
  );
  const arr = buildParamArray(getPreset('orbit'), user);
  assert.equal(arr[0], 100);
  assert.equal(arr[1], 5);
  assert.equal(arr[2], 0);
  assert.ok(Number.isNaN(arr[4]), 'param5 lat must be NaN');
  assert.ok(Number.isNaN(arr[5]), 'param6 lon must be NaN');
  assert.ok(Number.isNaN(arr[6]), 'param7 alt must be NaN');
});

test('absent orbit centre, velocity and altitude encode the spec NaN sentinels; explicit values win', () => {
  // DO_ORBIT blesses NaN on four params, in the dialect's own words: velocity
  // NaN = vehicle default, altitude NaN = current vehicle altitude, and
  // param5/6 NaN = "use current vehicle position, or current center if already
  // orbiting". A zero-fill commanded zero tangential velocity and an orbit
  // centred on null island at ground level — GCS parity sends the sentinels.
  const user = mergeParams({ params: '{"1":100,"2":5,"3":0}' }, {});
  const arr = buildParamArray(getPreset('orbit'), user);
  assert.deepEqual(arr.slice(0, 4), [100, 5, 0, 0]);
  assert.ok(Number.isNaN(arr[4]) && Number.isNaN(arr[5]),
    'an absent centre encodes NaN — orbit here, not orbit 0,0');
  assert.ok(Number.isNaN(arr[6]), 'absent altitude encodes NaN (current altitude)');

  // A typed centre still wins, and rides as given.
  const placed = buildParamArray(getPreset('orbit'), mergeParams({ params: '{"5":47.4,"6":8.5}' }, {}));
  assert.equal(placed[4], 47.4);
  assert.equal(placed[5], 8.5);

  const blankVelocity = buildParamArray(getPreset('orbit'), mergeParams({ params: '{"1":100}' }, {}));
  assert.ok(Number.isNaN(blankVelocity[1]), 'absent velocity encodes NaN (vehicle default)');
  assert.equal(buildParamArray(getPreset('orbit'), mergeParams({ params: '{"2":0}' }, {}))[1], 0,
    'an explicit 0 velocity is a typed value and wins');
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

test('blank is absent, and everything else still merges as before (#141)', () => {
  // Advanced mode reads these params straight through, so the contract is that
  // a raw MAV_CMD can still be expressed exactly. Blank became absent to stop
  // an empty override reading as coordinate 0; nothing else may have shifted.

  // The NaN sentinel is the whole reason this function exists — JSON cannot
  // carry a bare NaN, so the string form must survive.
  assert.ok(Number.isNaN(mergeParams({ params: '{"5":"NaN"}' }, {})[5]));
  assert.ok(Number.isNaN(mergeParams({ params: '{}' }, { 5: NaN })[5]));

  // Ordinary values, including the ones a blank check could plausibly eat.
  assert.equal(mergeParams({ params: '{}' }, { 1: 0 })[1], 0, 'explicit zero is a value');
  assert.equal(mergeParams({ params: '{}' }, { 7: -35.2 })[7], -35.2);
  assert.equal(mergeParams({ params: '{}' }, { 2: '47.4' })[2], 47.4, 'numeric strings still coerce');

  // Blank in any form is absent. Advanced mode then supplies its own 0, which
  // is its documented behaviour; a preset instead refuses (see presets.test.js).
  for (const blank of ['', '   ', '\t', null]) {
    assert.equal(mergeParams({ params: '{}' }, { 5: blank })[5], undefined, JSON.stringify(blank));
  }

  // And a blank override no longer wipes a configured value to 0 — it falls
  // through to what the node was configured with.
  assert.equal(mergeParams({ params: '{"5":47.4}' }, { 5: '' })[5], 47.4);
});
