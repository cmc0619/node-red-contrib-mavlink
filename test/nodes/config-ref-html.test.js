'use strict';

/**
 * Every palette node that references a Connection must ensure the standard
 * config-node picker (edit/add), not a free-form id field.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

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
  // Fan-out joined the standard rule when #191 made Build require an explicit
  // sysid list: blank on Build, required on the wire tiers, via the same
  // shared connectionDefault descriptor.
  'mavlink-fanout',
];
const ALWAYS_REQUIRED = [
  'mavlink-in',
  'mavlink-out',
  'mavlink-state',
  'mavlink-formation',
];
const NODES = BUILD_TIER_SENDERS.concat(ALWAYS_REQUIRED);

for (const name of NODES) {
  test(`${name}: connection is a typed config ref`, () => {
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
    } else {
      assert.equal(connection.required, true, `${name} has no Build tier`);
    }
  });
}
