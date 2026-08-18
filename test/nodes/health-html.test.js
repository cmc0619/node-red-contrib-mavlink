'use strict';

/**
 * Health editor: the Identity is a choice only when the Connection carries
 * more than one identity. A single-identity Connection hides the field (its
 * sole identity is its Local Identity, which the runtime asserts) and never
 * red-rings — even a stale saved pick is ignored. A multi-identity Connection
 * shows the same connection-scoped select command/fanout use, offering only
 * bound identities, with the validator kept as the hand-edit backstop.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadNodeDefaults } = require('./html-assert');

const html = fs.readFileSync(
  path.join(__dirname, '..', '..', 'nodes', 'mavlink-health.html'),
  'utf8'
);

test('Identity is a connection-scoped select in a toggleable row, not a raw picker', () => {
  assert.match(
    html,
    /<div class="form-row" id="row-health-identity">/,
    'the Identity row has an id so it can be hidden'
  );
  assert.match(
    html,
    /<select id="node-input-identity"><\/select>/,
    'Identity field is a plain <select> refreshIdentitySelect can fill'
  );
  assert.doesNotMatch(
    html,
    /ensureConfigNodePicker\(this,\s*'identity'/,
    'the unscoped every-identity picker is gone'
  );
  assert.match(html, /RED\.mavlink\.refreshIdentitySelect\(node\)/, 'scoped select used');
  assert.doesNotMatch(
    html,
    /refreshIdentitySelect\(node,\s*\{/,
    'health passes no rolesAllowed — every bound role is assertable'
  );
});

test('the Identity row is hidden for a single-identity Connection, shown for many', () => {
  // The hide/show pivots on how many identities the Connection binds.
  assert.match(html, /identityOptionsFor\(connId\)/, 'row toggle reads the bound-identity count');
  assert.match(
    html,
    /options\.length <= 1[\s\S]*?\$\('#row-health-identity'\)\.hide\(\)/,
    'a single-identity Connection hides the row'
  );
  assert.match(
    html,
    /\$\('#row-health-identity'\)\.show\(\)[\s\S]*?refreshIdentitySelect\(node\)/,
    'a multi-identity Connection shows the row and fills the scoped select'
  );
  // The toggle re-runs when the Connection changes.
  assert.match(
    html,
    /\$\('#node-input-connection'\)\.on\('change',\s*refreshIdentityRow\)/,
    'the row is re-evaluated on Connection change'
  );
});

test('oneditsave blanks the Identity for a single-identity Connection', () => {
  assert.match(
    html,
    /oneditsave:\s*function[\s\S]*?identityOptionsFor\(connId\)\.length <= 1[\s\S]*?this\.identity = ''/,
    'a hidden field stores blank so nothing stale is kept'
  );
});

test('a single-identity Connection never rings — even with a stale unbound pick', () => {
  const defaults = loadNodeDefaults('mavlink-health', {
    // One bound identity: the required Local Identity, no additionals.
    c1: { localIdentity: 'comp', additionalIdentities: [] },
    comp: { role: 'companion' },
    // A GCS identity valid on its own but bound to no Connection here — the
    // exact stale value that used to red-ring.
    loose: { role: 'gcs' },
  });
  // Blank passes (the field is hidden), and so does a leftover unbound id.
  assert.equal(defaults.identity.validate.call({ connection: 'c1' }, '', {}), true);
  assert.equal(defaults.identity.validate.call({ connection: 'c1' }, 'loose', {}), true);
});

test('a multi-identity Connection requires a bound pick; GCS is accepted', () => {
  const defaults = loadNodeDefaults('mavlink-health', {
    c1: { localIdentity: 'comp', additionalIdentities: ['gcs'] },
    comp: { role: 'companion' },
    gcs: { role: 'gcs' },
    loose: { role: 'gcs' },
  });
  assert.equal(typeof defaults.identity.validate, 'function', 'backstop validator retained');
  assert.equal(defaults.identity.validate.call({ connection: 'c1' }, 'gcs', {}), true);
  assert.equal(defaults.identity.validate.call({ connection: 'c1' }, 'comp', {}), true);
  assert.match(
    String(defaults.identity.validate.call({ connection: 'c1' }, 'loose', {})),
    /not bound to the selected Connection/
  );
  // A blank pick with a real choice on the table is required.
  assert.match(
    String(defaults.identity.validate.call({ connection: 'c1' }, '', {})),
    /is required/
  );
});
