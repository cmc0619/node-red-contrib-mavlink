'use strict';

/**
 * Vehicle Profile editor: the custom dialect stub is replaced by an XML-path
 * input plus a downloadable-catalog picker (§4, §6), and a param-defs URL is
 * persisted. These are static assertions against the editor HTML.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(
  path.join(__dirname, '..', '..', 'nodes', 'mavlink-vehicle.html'),
  'utf8'
);

test('the old "not yet implemented" custom stub is gone', () => {
  assert.ok(!/future upload mechanism/i.test(html), 'stub copy must be removed');
  assert.ok(!/not yet implemented/i.test(html), 'stub copy must be removed');
});

test('customDialectPath is a validated default and a text input', () => {
  assert.match(html, /customDialectPath:\s*\{/);
  assert.match(html, /validate:\s*function/);
  assert.match(html, /<input type="text" id="node-config-input-customDialectPath"/);
});

test('paramDefsUrl is persisted and shown as an input', () => {
  assert.match(html, /paramDefsUrl:\s*\{\s*value:\s*''\s*\}/);
  assert.match(html, /<input type="text" id="node-config-input-paramDefsUrl"/);
});

test('the XML-catalog admin endpoints are wired under mavlink/xml-catalog', () => {
  assert.match(html, /mavlink\/xml-catalog['"]\)/, 'list endpoint');
  assert.match(html, /mavlink\/xml-catalog\/update/, 'update endpoint');
  assert.match(html, /mavlink\/xml-catalog\/compare/, 'compare endpoint');
});

test('the catalog picker fills the custom XML path field', () => {
  assert.match(html, /id="mav-catalog-pick"/);
  assert.match(html, /id="mav-catalog-update"/);
  assert.match(html, /id="mav-catalog-compare"/);
  // Picking a catalog file writes into the path input.
  assert.match(html, /\$path\.val\(p\)/);
});

test('update posts JSON to the update endpoint', () => {
  assert.match(html, /method:\s*'POST'/);
  assert.match(html, /contentType:\s*'application\/json'/);
});
