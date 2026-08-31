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

test('valueFrom selects config only when the payload property is absent', () => {
  assert.equal(valueFrom({ yaw: 9 }, { yaw: 1 }, 'yaw'), 9);
  assert.equal(valueFrom({}, { yaw: 1 }, 'yaw'), 1);
  assert.equal(valueFrom({}, { yaw: '' }, 'yaw'), '');
  assert.equal(valueFrom({}, { yaw: '   ' }, 'yaw'), '   ');
  assert.equal(valueFrom({ yaw: '' }, { yaw: 45 }, 'yaw'), '');
  assert.equal(valueFrom({ yaw: '   ' }, { yaw: 45 }, 'yaw'), '   ');
  assert.equal(valueFrom({ yaw: null }, { yaw: 45 }, 'yaw'), null);
  assert.equal(valueFrom({ yaw: 0 }, { yaw: 45 }, 'yaw'), 0);
});
