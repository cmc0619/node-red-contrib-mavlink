'use strict';

/**
 * Connection editor: Vehicle and Identity must be config-node selectors
 * (DESIGN.md §6 — everything enumerable is a dropdown), not free-form ids.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(
  path.join(__dirname, '..', '..', 'nodes', 'mavlink-connection.html'),
  'utf8'
);

test('Vehicle default declares type mavlink-vehicle (config-node picker)', () => {
  assert.match(
    html,
    /vehicle:\s*\{\s*value:\s*''\s*,\s*type:\s*'mavlink-vehicle'/,
    'defaults.vehicle.type must be mavlink-vehicle'
  );
});

test('Identity default declares type mavlink-local-identity', () => {
  assert.match(
    html,
    /localIdentity:\s*\{\s*value:\s*''\s*,\s*type:\s*'mavlink-local-identity'/,
    'defaults.localIdentity.type must be mavlink-local-identity'
  );
});

test('oneditprepare falls back to an explicit select of existing Vehicle Profiles', () => {
  assert.match(html, /ensureConfigSelect/, 'fallback select builder is present');
  assert.match(html, /mavlink-vehicle/, 'Vehicle Profile type is referenced');
  assert.match(html, /eachConfig/, 'existing config nodes are enumerated');
});
