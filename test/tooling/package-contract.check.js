'use strict';

/**
 * Shipping-contract pins (DESIGN.md §4/§6, issue #105).
 *
 * Invariants that are silently breakable by an ordinary-looking edit and that
 * no other test would catch. JSON has no comments, so the constraint is
 * recorded as an executable check instead of a note nobody reads.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '../..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const nodesDir = path.join(root, 'nodes');

const htmlFiles = fs.readdirSync(nodesDir).filter((f) => f.endsWith('.html'));

/**
 * Node-RED's own rule for "relative", from appendConfig in
 * @node-red/editor-client/public/red/red.js: a `<script src>` is hoisted out of
 * the module fragment and loaded ahead of every inline node script only when
 * the src does NOT match this. The docs say the same thing in prose —
 * "the node must use relative URLs rather than absolute URLs … Note the URLs do
 * not start with a `/`" (nodered.org/docs/creating-nodes/resources).
 */
const ABSOLUTE_SRC = /^\s*(https?:|\/|\.)/;

const SCRIPT_SRC = /<script[^>]*\ssrc=["']([^"']+)["']/g;

/**
 * @param {string} file  HTML filename under nodes/
 * @returns {string[]}  every `src` the file loads
 */
function scriptSrcs(file) {
  const html = fs.readFileSync(path.join(nodesDir, file), 'utf8');
  return [...html.matchAll(SCRIPT_SRC)].map((m) => m[1]);
}

test('exactly one node HTML loads the shared editor script', () => {
  // The pattern Node-RED core uses for its one shared editor resource: a single
  // <script src> in the node HTML that owns the helper (debug-utils.js in
  // core/common/21-debug.html), not one tag per node. appendConfig holds back
  // every inline script in the *module* until that script loads, so one tag
  // covers all thirteen nodes and the order in node-red.nodes does not matter.
  const loaders = htmlFiles.filter((f) => scriptSrcs(f).some((s) => s.includes('mavlink-editor.js')));
  assert.deepEqual(
    loaders,
    ['mavlink-local-identity.html'],
    'mavlink-local-identity.html is the single loader of resources/mavlink-editor.js; '
      + 'the other node HTMLs consume RED.mavlink.* without loading it themselves'
  );
});

test('every editor resource src is relative — an absolute src skips the hoist', () => {
  // This is the sharp edge. Rewriting the src to "./resources/…" or
  // "/resources/…" leaves the script inside the module fragment instead of
  // hoisting it, so RED.mavlink.* is no longer guaranteed to exist when the
  // other twelve nodes' registerType calls evaluate. One character, silent
  // breakage, and nothing else in the suite would notice.
  for (const file of htmlFiles) {
    for (const src of scriptSrcs(file)) {
      assert.equal(
        ABSOLUTE_SRC.test(src),
        false,
        `${file} loads "${src}" — editor resource srcs must be relative (no leading /, ./ or scheme)`
      );
    }
  }
});

test('the shared editor script is actually shipped', () => {
  assert.ok(
    fs.existsSync(path.join(root, 'resources/mavlink-editor.js')),
    'resources/mavlink-editor.js is missing'
  );
  assert.ok(
    pkg.files.includes('resources'),
    'package.json "files" must include "resources" or the editor script is absent from the tarball'
  );
});

test('npm-facing metadata is present so the registry page is complete', () => {
  for (const field of ['homepage', 'bugs', 'author', 'license', 'description']) {
    assert.ok(pkg[field], `package.json is missing "${field}"`);
  }
});
