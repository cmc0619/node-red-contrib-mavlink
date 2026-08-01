'use strict';

/**
 * Shipping-contract pins (DESIGN.md §4/§6, issue #105).
 *
 * Invariants that are silently breakable by an ordinary-looking edit and that
 * no other test would catch. JSON has no comments, so the constraint is
 * recorded as an executable check instead of a note nobody reads.
 *
 * The editor load-order rule below was verified against a running Node-RED
 * 5.0.1 in Chromium, not derived — see the §6 ground-truth entry in DESIGN.md
 * for the measurement.
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
 * the node's fragment, prefixed with `RED.settings.apiRootUrl` and loaded ahead
 * of that node's inline scripts only when the src does NOT match this. The docs
 * say the same in prose — "the node must use relative URLs rather than absolute
 * URLs … Note the URLs do not start with a `/`"
 * (nodered.org/docs/creating-nodes/resources).
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

test('mavlink-local-identity is registered first — it loads the shared editor script', () => {
  // Node-RED's editor loads node HTML one *node* at a time, not one module at
  // a time. getAllNodeConfigs (registry.js:488) emits a
  // `<!-- --- [red-module:<setId>] --- -->` marker per node set — the marker is
  // named "red-module" but carries `module/node` — and loadNodes
  // (red.js:224) splits on it, then walks the pieces sequentially, each
  // appendNodeConfig waiting on the previous one's done().
  //
  // appendConfig only defers a node's inline scripts (and its done()) when that
  // node's HTML carries a relative-`src` script. Ours is in
  // mavlink-local-identity.html alone, so every node listed *before* it would
  // execute its registerType with RED.mavlink still undefined.
  //
  // Measured, not assumed: moving this entry last against Node-RED 5.0.1 leaves
  // 2 of 10 palette nodes registered and throws "Cannot read properties of
  // undefined (reading 'validateUint8')" — only mavlink-out and mavlink-swarm
  // survive, being the two that never touch RED.mavlink at registerType time.
  const names = Object.keys(pkg['node-red'].nodes);
  assert.equal(
    names[0],
    'mavlink-local-identity',
    'mavlink-local-identity must lead node-red.nodes: it is the only HTML that loads '
      + 'resources/mavlink-editor.js, and Node-RED appends node HTML one node at a time, '
      + 'so anything listed ahead of it runs registerType before RED.mavlink exists'
  );
});

test('exactly one node HTML loads the shared editor script', () => {
  // One <script src> in the node HTML that owns the helper — the shape
  // Node-RED core uses for debug-utils.js in core/common/21-debug.html.
  const loaders = htmlFiles.filter((f) => scriptSrcs(f).some((s) => s.includes('mavlink-editor.js')));
  assert.deepEqual(
    loaders,
    ['mavlink-local-identity.html'],
    'mavlink-local-identity.html is the single loader of resources/mavlink-editor.js; '
      + 'the other node HTMLs consume RED.mavlink.* without loading it themselves'
  );
});

test('every editor resource src is relative — an absolute src skips the hoist', () => {
  // Rewriting the src to "./resources/…" or "/resources/…" leaves the script
  // inside the fragment instead of hoisting it, which also skips the
  // `RED.settings.apiRootUrl + srcUrl` prefixing — so it 404s outright on any
  // Node-RED served under a non-root httpAdminRoot. One character, silent
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
