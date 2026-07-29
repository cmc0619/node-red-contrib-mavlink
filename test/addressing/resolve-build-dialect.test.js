'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveBuildDialect } = require('../../lib/addressing');

test('explicit dialect wins', () => {
  assert.equal(resolveBuildDialect({ dialect: 'common', vehicle: 'v1' }), 'common');
  assert.equal(resolveBuildDialect({ dialect: '__vehicle', vehicle: 'v1' }), '__vehicle');
});

test('legacy vehicle-only Build maps to __vehicle', () => {
  assert.equal(resolveBuildDialect({ vehicle: 'ex19-vehicle' }), '__vehicle');
});

test('fresh empty stays empty', () => {
  assert.equal(resolveBuildDialect({}), '');
  assert.equal(resolveBuildDialect({ dialect: '' }), '');
  assert.equal(resolveBuildDialect(null), '');
});
