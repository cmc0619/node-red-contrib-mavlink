'use strict';

/**
 * Identity resolution pain point (DESIGN.md §13):
 *   "An explicit override that is not a bound identity is rejected and does
 *    not fall back to the default."
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { resolveIdentity } = require('../../lib/identity');

/* ---------- override present ---------- */

test('override in bound set → returns override', () => {
  const result = resolveIdentity({
    defaultIdentityId: 'default-id',
    boundIdentityIds: ['a', 'b', 'override-id'],
    overrideId: 'override-id',
  });
  assert.deepEqual(result, { identityId: 'override-id', source: 'override' });
});

test('override NOT in bound set → throws, does not fall back to default', () => {
  assert.throws(
    () =>
      resolveIdentity({
        defaultIdentityId: 'default-id',
        boundIdentityIds: ['a', 'b'],
        overrideId: 'unknown-id',
      }),
    /override.*not among.*bound/i
  );
});

test('override not in bound set → error names the bound ids', () => {
  let message = '';
  try {
    resolveIdentity({
      defaultIdentityId: 'default-id',
      boundIdentityIds: ['id-one', 'id-two'],
      overrideId: 'missing',
    });
  } catch (err) {
    message = err.message;
  }
  assert.ok(message.includes('id-one'), 'error should list bound ids');
  assert.ok(message.includes('id-two'), 'error should list bound ids');
});

test('override not in bound set with empty bound list → error says none bound', () => {
  let message = '';
  try {
    resolveIdentity({
      defaultIdentityId: 'default-id',
      boundIdentityIds: [],
      overrideId: 'missing',
    });
  } catch (err) {
    message = err.message;
  }
  assert.ok(message.includes('none bound'), 'error should say none bound');
});

/* null / undefined / empty string override → treated as absent */

test('null overrideId → uses default', () => {
  const result = resolveIdentity({
    defaultIdentityId: 'default-id',
    boundIdentityIds: ['default-id'],
    overrideId: null,
  });
  assert.deepEqual(result, { identityId: 'default-id', source: 'default' });
});

test('undefined overrideId → uses default', () => {
  const result = resolveIdentity({
    defaultIdentityId: 'default-id',
    boundIdentityIds: ['default-id'],
  });
  assert.deepEqual(result, { identityId: 'default-id', source: 'default' });
});

test('empty string overrideId → uses default', () => {
  const result = resolveIdentity({
    defaultIdentityId: 'default-id',
    boundIdentityIds: ['default-id'],
    overrideId: '',
  });
  assert.deepEqual(result, { identityId: 'default-id', source: 'default' });
});

/* ---------- no override ---------- */

test('no override, default in bound set → returns default', () => {
  const result = resolveIdentity({
    defaultIdentityId: 'default-id',
    boundIdentityIds: ['default-id', 'other'],
  });
  assert.deepEqual(result, { identityId: 'default-id', source: 'default' });
});

test('no override, empty bound set (all ids accepted), default present → returns default', () => {
  const result = resolveIdentity({
    defaultIdentityId: 'default-id',
    boundIdentityIds: [],
  });
  assert.deepEqual(result, { identityId: 'default-id', source: 'default' });
});

test('no override, no default → throws', () => {
  assert.throws(
    () =>
      resolveIdentity({
        defaultIdentityId: '',
        boundIdentityIds: ['a'],
      }),
    /no default local identity/i
  );
});

test('no override, default NOT in bound set → throws', () => {
  assert.throws(
    () =>
      resolveIdentity({
        defaultIdentityId: 'default-id',
        boundIdentityIds: ['other-id'],
      }),
    /default.*not among.*bound/i
  );
});
