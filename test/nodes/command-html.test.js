'use strict';

/**
 * Guard for the mavlink-command editor's advanced-command field binding
 * (DESIGN.md §6; review finding). Node-RED binds a config property `foo` to the
 * DOM element with id `node-input-foo`. The advanced command property is
 * `advancedCommand`, so the input must be `node-input-advancedCommand`; the
 * earlier `node-input-advanced-command` id never persisted the value.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(
  path.join(__dirname, '..', '..', 'nodes', 'mavlink-command.html'),
  'utf8'
);

test('advanced command input binds to the advancedCommand property', () => {
  assert.match(html, /id="node-input-advancedCommand"/, 'input id must match the property');
  assert.ok(
    !html.includes('node-input-advanced-command'),
    'the unbound kebab-case id must be gone'
  );
});

test('advanced command is a MAV_CMD <select>, not a free-form number (§6/§9)', () => {
  assert.match(
    html,
    /<select id="node-input-advancedCommand"/,
    'Advanced mode must use a select dropdown'
  );
  assert.ok(
    !html.includes('type="number" id="node-input-advancedCommand"'),
    'the free-form numeric id field must be gone'
  );
  assert.match(html, /\/mavlink\/command\/commands/, 'dialect MAV_CMD list is loaded from admin API');
  assert.match(html, /function buildAdvancedDropdown/, 'async load re-applies the saved command');
});

test('advanced mode enumerates params from dialect metadata, not Param 1–7 (§6)', () => {
  assert.match(html, /function advancedParamInput/, 'metadata-driven param renderer exists');
  assert.match(html, /spec\.enum/, 'enum-backed params become dropdowns');
  assert.match(html, /!p\.hidden/, 'reserved/Empty params are filtered out');
  // The forbidden raw grid must not be the Advanced path anymore.
  const advancedBlock = html.slice(
    html.indexOf("if (mode === 'advanced')"),
    html.indexOf("const presetId = $('#node-input-preset')")
  );
  assert.ok(
    !/Param \$\{i\}/.test(advancedBlock) && !/for \(let i = 1; i <= 7/.test(advancedBlock),
    'Advanced path must not build a Param 1–7 grid'
  );
  assert.match(advancedBlock, /catalog\.commands/, 'params come from the loaded catalog');
  assert.match(
    html,
    /\$\('#node-input-advancedCommand'\)\.on\('change'/,
    'changing MAV_CMD refreshes the param form'
  );
});

test('advanced catalog load ignores stale responses and keeps the in-progress selection', () => {
  assert.match(html, /_catalogRequestSeq/, 'request sequence token exists');
  assert.match(html, /seq !== _catalogRequestSeq/, 'stale responses are dropped');
  assert.match(html, /const current = sel\.val\(\)/, 'in-progress select value is read');
  assert.match(html, /const prefer = current \|\| saved/, 'current selection wins over saved');
  assert.match(html, /query:\s*\{\s*vehicle:/, 'Vehicle id is preferred for custom dialects');
});

test('preset dropdown re-applies the saved selection and fires change after the async load', () => {
  // The preset list loads asynchronously; the builder must re-select the saved
  // preset and trigger a change so the exposed param fields render on first
  // open rather than staying stale until the user re-picks the preset.
  const builder = html.slice(
    html.indexOf('function buildPresetDropdown'),
    html.indexOf('loadPresets(buildPresetDropdown)')
  );
  assert.match(builder, /sel\.val\(node\.preset/, 'the saved preset is re-applied');
  assert.match(builder, /sel\.trigger\(['"]change['"]\)/, 'a change event is fired after building');
});
