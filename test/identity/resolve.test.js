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

test('override NOT in bound set → still the override, never the default', () => {
  // Silently swapping in the default would stamp a different source
  // sysid/compid on the frame than the caller asked for. The id is passed
  // through; a connection that does not carry it resolves no identity and the
  // send craters there (lib/connection/runtime.js `_resolveOutboundIdentity`).
  assert.deepEqual(
    resolveIdentity({
      defaultIdentityId: 'default-id',
      boundIdentityIds: ['a', 'b'],
      overrideId: 'unknown-id',
    }),
    { identityId: 'unknown-id', source: 'override' }
  );
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

test('no override, no default → the blank default, resolved by the connection', () => {
  // The Connection's `defaultIdentity` is a required editor field; a blank
  // one reaching here is hand-edit drift and resolves to no identity node,
  // which craters at the send site rather than being repaired here.
  assert.deepEqual(
    resolveIdentity({ defaultIdentityId: '', boundIdentityIds: ['a'] }),
    { identityId: '', source: 'default' }
  );
});
