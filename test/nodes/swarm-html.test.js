'use strict';

/**
 * Swarm editor: vehicleType is a MAV_TYPE enum <select> (DESIGN.md §6).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(
  path.join(__dirname, '..', '..', 'nodes', 'mavlink-swarm.html'),
  'utf8'
);

test('vehicleType is a MAV_TYPE select, not a free-form number (§6)', () => {
  assert.match(
    html,
    /<select id="node-input-vehicleType">/,
    'Type filter must be a select dropdown'
  );
  assert.ok(
    !html.includes('type="number" id="node-input-vehicleType"'),
    'the free-form numeric type filter must be gone'
  );
});

test('vehicleType loads MAV_TYPE entries from the build/messages catalog', () => {
  assert.match(html, /\/mavlink\/build\/messages/, 'dialect enum catalog is loaded from admin API');
  assert.match(html, /enums\.MAV_TYPE/, 'MAV_TYPE table is read from the catalog');
  assert.match(html, /function buildVehicleTypeDropdown/, 'dropdown is rebuilt from catalog entries');
  assert.match(html, /entry\.label/, 'option labels come from the catalog (value in parentheses)');
  assert.match(html, /Any type/, 'empty selection means any vehicle type');
});

test('vehicleType preserves the saved numeric value after async catalog load', () => {
  assert.match(html, /node\.vehicleType/, 'saved vehicleType is re-applied');
  assert.match(html, /const prefer = current \|\| saved|var prefer = current \|\| saved/, 'in-progress selection wins over saved');
  assert.match(html, /not in dialect/, 'unknown saved values remain selectable');
  assert.match(html, /_msgRequestSeq/, 'stale catalog responses are ignored');
  // Cache hits must bump the seq before returning so in-flight requests cannot overwrite.
  assert.match(
    html,
    /var seq = \+\+_msgRequestSeq;\s*if \(_msgCatalogByKey\[target\.key\]\)/,
    'cached catalog path invalidates pending requests'
  );
});

test('firmware filter is already a small select (ArduPilot/PX4/custom)', () => {
  assert.match(html, /<select id="node-input-firmwareFilter">/);
  assert.match(html, /<option value="ardupilot">ArduPilot<\/option>/);
  assert.match(html, /<option value="px4">PX4<\/option>/);
  assert.match(html, /<option value="custom">Custom<\/option>/);
});

test('commandId is a MAV_CMD <select>, not a free-form number (§6)', () => {
  assert.match(
    html,
    /<select id="node-input-commandId"/,
    'Command id must be a select dropdown'
  );
  assert.ok(
    !html.includes('type="number" id="node-input-commandId"'),
    'the free-form numeric command field must be gone'
  );
});

test('commandId loads MAV_CMD entries from command/commands catalog', () => {
  assert.match(html, /\/mavlink\/command\/commands/, 'dialect MAV_CMD catalog is loaded from admin API');
  assert.match(html, /function buildCommandDropdown/, 'dropdown is rebuilt from catalog entries');
  assert.match(html, /entry\.label/, 'option labels come from the catalog (MAV_CMD_… (n))');
  assert.match(html, /entry\.value/, 'option values are numeric command ids');
  assert.match(html, /_cmdRequestSeq/, 'stale command catalog responses are ignored');
});

test('commandId preserves the saved numeric value after async catalog load', () => {
  assert.match(html, /node\.commandId/, 'saved commandId is re-applied');
  assert.match(html, /not in dialect/, 'unknown saved values remain selectable');
});
