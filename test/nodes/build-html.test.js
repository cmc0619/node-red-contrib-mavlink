'use strict';

/**
 * Build editor: Vehicle and Connection are config-node pickers with edit/add
 * (§6), not free-form ids.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(
  path.join(__dirname, '..', '..', 'nodes', 'mavlink-build.html'),
  'utf8'
);

test('Build vehicle default declares type mavlink-vehicle', () => {
  assert.match(
    html,
    /vehicle:\s*\{\s*value:\s*''\s*,\s*type:\s*'mavlink-vehicle'/,
    'defaults.vehicle.type must be mavlink-vehicle'
  );
});

test('Build connection default declares type mavlink-connection', () => {
  assert.match(
    html,
    /connection:\s*\{\s*value:\s*''\s*,\s*type:\s*'mavlink-connection'/,
    'defaults.connection.type must be mavlink-connection'
  );
});

test('Build oneditprepare ensures standard config-node pickers', () => {
  assert.match(html, /ensureConfigNodePicker\(node,\s*'vehicle'/);
  assert.match(html, /ensureConfigNodePicker\(node,\s*'connection'/);
});
