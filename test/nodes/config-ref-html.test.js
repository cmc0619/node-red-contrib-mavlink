'use strict';

/**
 * Every palette node that references a Connection must ensure the standard
 * config-node picker (edit/add), not a free-form id field.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadNodeDefaults } = require('./html-assert');

// Split by which Connection rule the node is under. Build-tier senders take
// the shared descriptor from buildTierDialectDefaults — blank is correct on
// Build, required on the wire tiers, and it restates the config-node reference
// check that declaring a validate would otherwise suppress. The rest have no
// Build tier and are unconditionally required.
const BUILD_TIER_SENDERS = [
  'mavlink-build',
  'mavlink-command',
  'mavlink-move',
  'mavlink-param',
  'mavlink-payload',
  'mavlink-mission',
];
const ALWAYS_REQUIRED = [
  'mavlink-in',
  'mavlink-out',
  'mavlink-state',
  'mavlink-formation',
];
// Fan-out is the odd one: build + an explicit target list needs no Connection
// (§6/§9), so blank is legal, but it does not use the shared factory and
// carries `required: false` instead. Recorded rather than normalised — moving
// it onto the shared descriptor is a separate decision.
const OPTIONAL_CONNECTION = ['mavlink-fanout'];
const NODES = BUILD_TIER_SENDERS.concat(ALWAYS_REQUIRED, OPTIONAL_CONNECTION);

for (const name of NODES) {
  test(`${name}: connection is a typed config ref and ensureConfigNodePicker is called`, () => {
    const html = fs.readFileSync(
      path.join(__dirname, '..', '..', 'nodes', `${name}.html`),
      'utf8'
    );
    // Executed rather than grepped: a node may declare connection itself or
    // receive it from buildTierDialectDefaults, and only running the
    // registration shows which descriptor actually survived the merge.
    const { connection } = loadNodeDefaults(name);
    assert.equal(
      connection && connection.type,
      'mavlink-connection',
      `${name} must register defaults.connection.type`
    );
    // Type alone is too weak — a local re-declaration after the merge sets it
    // too. These distinguish the shared descriptor from a look-alike.
    if (BUILD_TIER_SENDERS.includes(name)) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(connection, 'required'),
        false,
        `${name} must not carry a required key — it short-circuits the validator (§14)`
      );
      assert.equal(
        typeof connection.validate === 'function' && connection.validate.length,
        2,
        `${name} must register the shared (v, opt) validator`
      );
    } else if (OPTIONAL_CONNECTION.includes(name)) {
      assert.equal(connection.required, false, `${name} allows a blank Connection`);
    } else {
      assert.equal(connection.required, true, `${name} has no Build tier`);
    }
    assert.match(
      html,
      /ensureConfigNodePicker\([^,]+,\s*'connection'/,
      `${name} must call ensureConfigNodePicker for connection`
    );
  });
}
