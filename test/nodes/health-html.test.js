'use strict';

/**
 * Health editor: the Identity field is a connection-scoped select, the same
 * one command and fanout use, so the editor only ever offers identities bound
 * to the selected Connection — never the whole flow's identities followed by a
 * red ring on the wrong pick (§0: offer viable choices). The bound-identity
 * validator stays only as the hand-edited-flow backstop for the promoted
 * silent-false-success case (a lease on an unbound id no scheduler heartbeats).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadNodeDefaults, assertChangeHandlerContains } = require('./html-assert');

const html = fs.readFileSync(
  path.join(__dirname, '..', '..', 'nodes', 'mavlink-health.html'),
  'utf8'
);

test('Identity is a connection-scoped select, not a raw config-node picker', () => {
  assert.match(
    html,
    /<select id="node-input-identity"><\/select>/,
    'Identity field is a plain <select> refreshIdentitySelect can fill'
  );
  // The generic every-identity-in-the-flow picker is gone for this field —
  // that picker plus a validator is exactly the offer-then-ring shape.
  assert.doesNotMatch(
    html,
    /ensureConfigNodePicker\(this,\s*'identity'/,
    'the unscoped identity picker is gone'
  );
  assert.match(
    html,
    /RED\.mavlink\.refreshIdentitySelect\(node\)/,
    'identity is filled by the shared connection-scoped select'
  );
  // No role filter: health asserts any bound identity, gcs included — unlike
  // fanout, which passes rolesAllowed: ['gcs','custom'].
  assert.doesNotMatch(
    html,
    /refreshIdentitySelect\(node,\s*\{/,
    'health passes no rolesAllowed — every bound role is assertable'
  );
});

test('Identity is re-filled when the Connection selection changes', () => {
  assertChangeHandlerContains(
    html,
    "$('#node-input-connection')",
    'refreshIdentitySelect',
    'changing the Connection re-scopes the Identity options'
  );
});

test('the bound-identity validator stays as the hand-edit backstop and accepts a bound GCS identity', () => {
  const defaults = loadNodeDefaults('mavlink-health', {
    // A Connection carrying a companion local identity and a GCS additional.
    c1: { localIdentity: 'comp', additionalIdentities: ['gcs'] },
    comp: { role: 'companion' },
    gcs: { role: 'gcs' },
    // A GCS identity valid on its own but bound to no Connection here.
    loose: { role: 'gcs' },
  });

  assert.equal(typeof defaults.identity.validate, 'function', 'backstop validator retained');

  // A GCS identity bound to the Connection is fine — role never gates it.
  assert.equal(defaults.identity.validate.call({ connection: 'c1' }, 'gcs', {}), true);
  // The companion local identity is equally fine.
  assert.equal(defaults.identity.validate.call({ connection: 'c1' }, 'comp', {}), true);
  // A hand-edited flow naming an unbound identity still reds — the §0 guard.
  assert.match(
    String(defaults.identity.validate.call({ connection: 'c1' }, 'loose', {})),
    /not bound to the selected Connection/
  );
});
