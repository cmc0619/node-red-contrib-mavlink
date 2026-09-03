'use strict';

/**
 * Identity resolution (DESIGN.md §13): an override rides as given and is never
 * replaced by the default; a blank override means the default.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { resolveIdentity } = require('../../lib/identity');

test('an override is returned as given', () => {
  assert.deepEqual(
    resolveIdentity({ defaultIdentityId: 'default-id', overrideId: 'override-id' }),
    { identityId: 'override-id', source: 'override' }
  );
});

test('an override the connection does not carry is still the override, never the default', () => {
  // Silently swapping in the default would stamp a different source
  // sysid/compid on the frame than the caller asked for. The id is passed
  // through; a connection that does not carry it resolves no identity and the
  // send craters there (lib/connection/runtime.js `_resolveOutboundIdentity`).
  assert.deepEqual(
    resolveIdentity({ defaultIdentityId: 'default-id', overrideId: 'unknown-id' }),
    { identityId: 'unknown-id', source: 'override' }
  );
});

for (const [name, overrideId] of [['null', null], ['undefined', undefined], ['empty string', '']]) {
  test(`${name} overrideId → the default`, () => {
    assert.deepEqual(
      resolveIdentity({ defaultIdentityId: 'default-id', overrideId }),
      { identityId: 'default-id', source: 'default' }
    );
  });
}

test('no override, no default → the blank default, resolved by the connection', () => {
  // The Connection's `defaultIdentity` is a required editor field; a blank
  // one reaching here is hand-edit drift and resolves to no identity node,
  // which craters at the send site rather than being repaired here.
  assert.deepEqual(
    resolveIdentity({ defaultIdentityId: '' }),
    { identityId: '', source: 'default' }
  );
});
