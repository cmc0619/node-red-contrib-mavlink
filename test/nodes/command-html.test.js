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
