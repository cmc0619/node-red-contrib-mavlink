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
  assert.match(html, /\/mavlink\/build\/messages/, 'dialect message catalog is loaded from admin API');
  assert.match(html, /function buildMessageDropdown/, 'dropdown is rebuilt from catalog entries');
  assert.match(html, /entry\.name/, 'option values are message names');
  assert.match(html, /entry\.label/, 'option labels come from the catalog (NAME (id))');
  assert.match(html, /All messages/, 'empty selection means all traffic');
});

test('message filter resolves dialect from the Connection vehicle graph', () => {
  assert.match(html, /function resolveCatalogTarget/, 'catalog target follows Connection → Vehicle → dialect');
  assert.match(html, /conn\.vehicle/, 'Connection vehicle id is read from the editor graph');
  assert.match(html, /_msgRequestSeq/, 'stale catalog responses are ignored');
});

test('message filter preserves the saved message name after async catalog load', () => {
  assert.match(html, /node\.message/, 'saved message is re-applied');
  assert.match(html, /const prefer = current \|\| saved|var prefer = current \|\| saved/, 'in-progress selection wins over saved');
  assert.match(html, /not in dialect/, 'unknown saved values remain selectable');
});
