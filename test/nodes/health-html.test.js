'use strict';

/**
 * Health editor: the Identity is a choice only when the Connection carries
 * more than one identity. A single-identity Connection hides the field and
 * oneditsave stores blank (the runtime then asserts the Local Identity) and
 * never red-rings — even a leftover saved pick. A multi-identity Connection
 * shows the same connection-scoped select command/fanout use, offering only
 * bound identities, with the validator kept as the hand-edit backstop.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadNodeDefaults, loadNodeType } = require('./html-assert');

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

test('one helper decides single-vs-multi, so the three sites cannot drift', () => {
  // The bound-identity count lives in one place (Sourcery); every site turns
  // on isSingleIdentity, not its own inline `<= 1`.
  assert.match(
    html,
    /function isSingleIdentity\(connId\)\s*\{\s*return !RED\.mavlink\.hasIdentityChoice\(connId\);/,
    'a single helper owns the count, and it is the shared one every dialog uses'
  );
  assert.doesNotMatch(html, /options\.length <= 1/, 'no inline count survives the helper');
  assert.doesNotMatch(
    html,
    /identityOptionsFor\([^)]*\)\.length/,
    'the count is not re-derived locally (the bound-membership test still reads the list)'
  );
});

test('the Identity row is hidden for a single-identity Connection, shown for many', () => {
  assert.match(
    html,
    /if \(isSingleIdentity\(connId\)\)\s*\{\s*\$\('#row-health-identity'\)\.hide\(\)/,
    'a single-identity Connection hides the row'
  );
  assert.match(
    html,
    /\$\('#row-health-identity'\)\.show\(\)[\s\S]*?refreshIdentitySelect\(node\)/,
    'a multi-identity Connection shows the row and fills the scoped select'
  );
  assert.match(
    html,
    /\$\('#node-input-connection'\)\.on\('change',\s*refreshIdentityRow\)/,
    'the row is re-evaluated on Connection change'
  );
});

test('oneditsave clears the Identity (DOM and property) for a single-identity Connection', () => {
  // Both, on purpose: Node-RED harvests #node-input-* into the node after
  // oneditsave, so the property alone would be overwritten by the select
  // (Codacy). Clearing the DOM element makes the harvested value blank too.
  assert.match(
    html,
    /oneditsave:\s*function[\s\S]*?if \(isSingleIdentity\(connId\)\)\s*\{\s*\$\('#node-input-identity'\)\.val\(''\);\s*this\.identity = ''/,
    'a hidden field clears both the select and the property'
  );
});

test('oneditsave executes: clears a hidden field for a single-identity Connection', () => {
  // Run the hook for real, not just grep the source — the persistence behaviour
  // is what matters (CodeRabbit). A single-identity Connection clears the
  // stored id so nothing stale survives; a real multi-identity pick is kept.
  const single = loadNodeType(
    'mavlink-health',
    { c1: { localIdentity: 'comp', additionalIdentities: [] }, comp: { role: 'companion' } },
    { dom: { '#node-input-connection': { val: 'c1' } } }
  );
  const singleNode = { connection: 'c1', identity: 'loose' };
  single.oneditsave.call(singleNode);
  assert.equal(singleNode.identity, '', 'hidden single-identity field is cleared');

  const multi = loadNodeType(
    'mavlink-health',
    {
      c1: { localIdentity: 'comp', additionalIdentities: ['gcs'] },
      comp: { role: 'companion' },
      gcs: { role: 'gcs' },
    },
    { dom: { '#node-input-connection': { val: 'c1' } } }
  );
  const multiNode = { connection: 'c1', identity: 'gcs' };
  multi.oneditsave.call(multiNode);
  assert.equal(multiNode.identity, 'gcs', 'a real multi-identity pick is preserved');
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
