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

test('message filters are a list of dialect <select> rows, not free-form text (§6)', () => {
  assert.match(html, /<ol id="mav-in-messages">/, 'the filter is an editableList');
  assert.match(html, /addButton:\s*'add message'/, 'rows are added by button');
  assert.match(html, /\$\('<select>'/, 'each row carries a select, not a text input');
  assert.ok(
    !html.includes('placeholder="e.g. HEARTBEAT'),
    'the free-form message placeholder must be gone'
  );
  assert.ok(
    !/id="node-input-message"/.test(html),
    'the single-message field is gone, not left orphaned beside the list'
  );
});

test('message filter loads dialect messages from build/messages catalog', () => {
  assert.match(
    html,
    /RED\.mavlink\.loadCatalog\(\s*['"]\/mavlink\/build\/messages['"]/,
    'dialect message catalog uses shared loadCatalog'
  );
  assert.match(html, /function paintRow/, 'rows are painted from catalog entries');
  assert.match(html, /RED\.mavlink\.fillEnumSelect\(/, 'options are built via shared fillEnumSelect');
  assert.match(html, /valueKey:\s*['"]name['"]/, 'option values are message names');
  assert.match(html, /empty to receive every message/i, 'an empty list means all traffic');
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

test('message rows survive an async catalog load', () => {
  // A row can exist before the catalog arrives, and a Connection change
  // reloads it, so every existing row is repainted when one lands rather than
  // only the rows added afterwards.
  assert.match(html, /\(node\.messages \|\| \[\]\)\.forEach/, 'saved rows are restored');
  assert.match(
    html,
    /editableList\('items'\)\.each\(function \(\) \{\s*\n\s*paintRow/,
    'a catalog load repaints every existing row'
  );
  // paintRow captures the row's current value itself, so the fill is told what
  // to select rather than reading the live control a second time.
  assert.match(html, /var want = saved !== undefined \? saved : \$sel\.val\(\)/, 'the live selection is carried across a repaint');
  assert.match(html, /RED\.mavlink\.fillEnumSelect\(/, 'unknown saved values use shared fillEnumSelect sentinel');
});

test('admin catalog fetches go through shared loadCatalog (httpAdminRoot-safe)', () => {
  assert.match(html, /RED\.mavlink\.loadCatalog\(/, 'catalog fetches use shared loadCatalog');
  assert.ok(
    !/\$\.getJSON\(\s*['"]\/mavlink\//.test(html),
    'bare absolute /mavlink getJSON paths must be gone'
  );
});
