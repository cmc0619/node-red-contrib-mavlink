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
  assert.match(html, /RED\.mavlink\.adminApiUrl\(['"]\/mavlink\/build\/messages['"]\)/, 'dialect message catalog is loaded from admin API');
  assert.match(html, /function buildMessageDropdown/, 'dropdown is rebuilt from catalog entries');
  assert.match(html, /entry\.name/, 'option values are message names');
  assert.match(html, /entry\.label/, 'option labels come from the catalog (NAME (id))');
  assert.match(html, /All messages/, 'empty selection means all traffic');
});

test('message filter resolves dialect from the Connection vehicle graph (wire-only, shared helper)', () => {
  // mavlink-in has no Build tier: it always resolves through the shared wire
  // path, and an empty target yields no catalog — never a silent ardupilotmega.
  assert.match(
    html,
    /RED\.mavlink\.resolveCatalogTarget\(\{\s*isBuild:\s*false\s*\}\)/,
    'catalog target uses the shared wire-tier resolver'
  );
  assert.doesNotMatch(html, /function resolveCatalogTarget/, 'no local catalog resolver copy');
  assert.doesNotMatch(html, /dialect\s*=\s*['"]ardupilotmega['"]/, 'no invented default dialect');
  assert.match(html, /if \(!target\.query\)/, 'empty target resolves to an empty catalog, not a fetch');
  assert.match(html, /_msgRequestSeq/, 'stale catalog responses are ignored');
});

test('message filter preserves the saved message name after async catalog load', () => {
  assert.match(html, /node\.message/, 'saved message is re-applied');
  assert.match(html, /const prefer = current \|\| saved|var prefer = current \|\| saved/, 'in-progress selection wins over saved');
  assert.match(html, /not in dialect/, 'unknown saved values remain selectable');
});

test('admin catalog fetches use adminApiUrl (httpAdminRoot-safe)', () => {
  assert.match(html, /RED\.mavlink\.adminApiUrl\(/, 'admin fetches must use adminApiUrl');
  assert.ok(
    !/\$\.getJSON\(\s*['"]\/mavlink\//.test(html),
    'bare absolute /mavlink getJSON paths must be gone'
  );
});
