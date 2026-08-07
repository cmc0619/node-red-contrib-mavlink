'use strict';

/**
 * Every palette node that references a Connection must ensure the standard
 * config-node picker (edit/add), not a free-form id field.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const NODES = [
  'mavlink-command',
  'mavlink-in',
  'mavlink-out',
  'mavlink-move',
  'mavlink-param',
  'mavlink-payload',
  'mavlink-mission',
  'mavlink-state',
  'mavlink-fanout',
  'mavlink-formation',
];

for (const name of NODES) {
  test(`${name}: connection is a typed config ref and ensureConfigNodePicker is called`, () => {
    const html = fs.readFileSync(
      path.join(__dirname, '..', '..', 'nodes', `${name}.html`),
      'utf8'
    );
    // Two legitimate routes to a typed connection descriptor: declared in the
    // node, or merged in from buildTierDialectDefaults. The Build-tier senders
    // take the shared one, which also carries the wire-tier requirement and
    // the config-node reference check.
    const declared = /connection:\s*\{\s*value:\s*''\s*,\s*type:\s*'mavlink-connection'/.test(html);
    const shared = /buildTierDialectDefaults\(/.test(html);
    assert.ok(
      declared || shared,
      `${name} must get defaults.connection.type from its own defaults or the shared factory`
    );
    assert.match(
      html,
      /ensureConfigNodePicker\([^,]+,\s*'connection'/,
      `${name} must call ensureConfigNodePicker for connection`
    );
  });
}
