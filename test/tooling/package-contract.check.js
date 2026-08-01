'use strict';

/**
 * package.json contract pins (DESIGN.md §4, issue #105).
 *
 * Two invariants that are silently breakable by an ordinary-looking edit and
 * that no other test would catch. JSON has no comments, so the constraint is
 * recorded as an executable check instead of a note nobody reads.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));

test('mavlink-local-identity is registered first — it loads the shared editor script', () => {
  // Only nodes/mavlink-local-identity.html carries the
  // <script src=".../mavlink-editor.js"> tag, and Node-RED concatenates editor
  // HTML in the order of this map. Every other node HTML calls RED.mavlink.* at
  // registerType evaluation time, so if any of them is registered first the
  // helper is not defined yet and *all* node registration fails. Reordering
  // this map is the whole failure mode; hence the pin.
  const names = Object.keys(pkg['node-red'].nodes);
  assert.equal(
    names[0],
    'mavlink-local-identity',
    'mavlink-local-identity must lead node-red.nodes: it is the only HTML that loads '
      + 'resources/mavlink-editor.js, which every other node HTML needs at registerType time'
  );
});

test('the shared editor script is loaded exactly once, by that first node', () => {
  const nodesDir = path.join(__dirname, '../../nodes');
  const loaders = fs
    .readdirSync(nodesDir)
    .filter((f) => f.endsWith('.html'))
    .filter((f) => /<script[^>]+mavlink-editor\.js/.test(fs.readFileSync(path.join(nodesDir, f), 'utf8')));
  assert.deepEqual(
    loaders,
    ['mavlink-local-identity.html'],
    'exactly one node HTML may load mavlink-editor.js — a second loader would '
      + 'execute the helper twice in the editor'
  );
});

test('npm-facing metadata is present so the registry page is complete', () => {
  for (const field of ['homepage', 'bugs', 'author', 'license', 'description']) {
    assert.ok(pkg[field], `package.json is missing "${field}"`);
  }
});
