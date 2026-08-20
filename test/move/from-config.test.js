'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { positionFrom, velocityFrom, valueFrom } = require('../../lib/move');

test('positionFrom maps editor keys', () => {
  assert.deepEqual(
    positionFrom({ north: 1, east: 2, up: 3, lat: 4, lon: 5, alt: 6 }),
    { north: 1, east: 2, up: 3, lat: 4, lon: 5, alt: 6 }
  );
});

test('velocityFrom maps vNorth/vEast/vUp', () => {
  assert.deepEqual(
    velocityFrom({ vNorth: 1, vEast: 2, vUp: 3 }),
    { north: 1, east: 2, up: 3 }
  );
});

test('valueFrom prefers payload, treats empty config as unset', () => {
  assert.equal(valueFrom({ yaw: 9 }, { yaw: 1 }, 'yaw'), 9);
  assert.equal(valueFrom({}, { yaw: 1 }, 'yaw'), 1);
  assert.equal(valueFrom({}, { yaw: '' }, 'yaw'), undefined);
  assert.equal(valueFrom({}, { yaw: '   ' }, 'yaw'), undefined);
});
