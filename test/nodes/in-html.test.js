'use strict';

/**
 * mavlink-in editor: message filter is a dialect dropdown (DESIGN.md §6).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(
  path.join(__dirname, '..', '..', 'nodes', 'mavlink-in.html'),
  'utf8'
);

test('message filter is a dialect <select>, not free-form text (§6)', () => {
  assert.match(
    html,
    /<select id="node-input-message"/,
    'Message filter must be a select dropdown'
  );
  assert.ok(
    !html.includes('placeholder="e.g. HEARTBEAT'),
    'the free-form message placeholder must be gone'
  );
});

test('message filter loads dialect messages from build/messages catalog', () => {
  assert.match(
    html,
    /RED\.mavlink\.loadCatalog\(\s*['"]\/mavlink\/build\/messages['"]/,
    'dialect message catalog uses shared loadCatalog'
  );
  assert.match(html, /function buildMessageDropdown/, 'dropdown is rebuilt from catalog entries');
  assert.match(html, /RED\.mavlink\.fillEnumSelect\(/, 'options are built via shared fillEnumSelect');
  assert.match(html, /valueKey:\s*['"]name['"]/, 'option values are message names');
  assert.match(html, /All messages/, 'empty selection means all traffic');
});

test('message filter resolves dialect from the Connection vehicle graph (wire-only, shared helper)', () => {
  // mavlink-in has no Build tier: it always resolves through the shared wire
  // path (isBuild: false), and an empty target yields no catalog — never a
  // silent ardupilotmega. Skeleton proven in mavlink-editor-resource.test.js.
  assert.match(
    html,
    /RED\.mavlink\.loadCatalog\(\s*['"]\/mavlink\/build\/messages['"][\s\S]*isBuild:\s*false/,
    'catalog load uses the shared wire-tier isBuild:false override'
  );
  assert.doesNotMatch(html, /function resolveCatalogTarget/, 'no local catalog resolver copy');
  assert.doesNotMatch(html, /\$\.getJSON\(\s*RED\.mavlink\.adminApiUrl/, 'no hand-rolled catalog getJSON');
  assert.doesNotMatch(html, /dialect\s*=\s*['"]ardupilotmega['"]/, 'no invented default dialect');
});

test('message filter preserves the saved message name after async catalog load', () => {
  assert.match(html, /node\.message/, 'saved message is re-applied');
  assert.match(html, /var prefer = sel\.val\(\)/, 'in-progress selection wins over saved');
  assert.match(html, /saved:\s*prefer/, 'prefer is passed to fillEnumSelect');
  assert.match(html, /RED\.mavlink\.fillEnumSelect\(/, 'unknown saved values use shared fillEnumSelect sentinel');
});

test('admin catalog fetches go through shared loadCatalog (httpAdminRoot-safe)', () => {
  assert.match(html, /RED\.mavlink\.loadCatalog\(/, 'catalog fetches use shared loadCatalog');
  assert.ok(
    !/\$\.getJSON\(\s*['"]\/mavlink\//.test(html),
    'bare absolute /mavlink getJSON paths must be gone'
  );
});
