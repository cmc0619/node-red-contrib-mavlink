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
