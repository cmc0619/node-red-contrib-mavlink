'use strict';

/**
 * Mission editor: role × tier visibility and catalog derivation (DESIGN.md §6).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(
  path.join(__dirname, '..', '..', 'nodes', 'mavlink-mission.html'),
  'utf8'
);

test('mavlink-mission has vehicle and identity defaults', () => {
  assert.match(
    html,
    /vehicle:\s*\{\s*value:\s*''\s*,\s*type:\s*'mavlink-vehicle'/,
    'vehicle default with mavlink-vehicle type'
  );
  assert.match(
    html,
    /identity:\s*\{\s*value:\s*''\s*\}/,
    'identity default exists with empty value'
  );
});

test('mavlink-mission calls fillIdentitySelect on connection change', () => {
  assert.match(html, /fillIdentitySelect/, 'fillIdentitySelect helper is called');
  assert.match(html, /node-input-identity/, 'identity select element exists');
});

test('mavlink-mission Build dialect default is empty and validates a selected dialect', () => {
  assert.match(
    html,
    /dialect:\s*\{\s*value:\s*''/,
    'defaults.dialect.value must be empty'
  );
  assert.match(
    html,
    /if \(delivery === ['"]build['"]\) return !!v/,
    'Build delivery must require a dialect selection'
  );
});

test('mavlink-mission has refreshVisibility and companion row hiding', () => {
  assert.match(html, /function refreshVisibility/, 'refreshVisibility function present');
  assert.match(html, /isCompanion/, 'companion role detected in visibility logic');
  assert.match(html, /row-targetSystem/, 'row-targetSystem referenced in visibility');
  assert.match(html, /row-targetComponent/, 'row-targetComponent referenced in visibility');
  assert.match(html, /row-vehicle/, 'row-vehicle present for build tier');
  assert.match(html, /row-connection/, 'row-connection present for wire tiers');
  assert.match(html, /row-identity/, 'row-identity present for wire tiers');
});

test('mavlink-mission Build dialect select uses shared helper with Vehicle Profile escape', () => {
  assert.match(html, /id="row-mission-dialect"/, 'template must have a dialect row');
  assert.match(html, /id="node-input-dialect"/, 'template must have a dialect select');
  assert.match(html, /RED\.mavlink\.populateDialectSelect\(/, 'dialect select must use shared helper');
  assert.match(html, /includeVehicleEscape:\s*true/, 'dialect helper must include Vehicle Profile escape');
  assert.match(html, /__vehicle/, 'visibility/runtime contract must reference __vehicle');
  assert.match(html, /from Vehicle Profile/, 'help text must name the Vehicle Profile escape');
});

test('mavlink-mission Build visibility is Vehicle Profile XOR dialect plus Firmware', () => {
  assert.match(html, /dialect:\s*isBuild/, 'dialect row shown only for build tier');
  assert.match(
    html,
    /vehicle:\s*isBuild\s*&&\s*dialect\s*===\s*'__vehicle'/,
    'vehicle row shown only for Build Vehicle Profile escape'
  );
  assert.match(
    html,
    /firmware:\s*isBuild\s*&&\s*!!dialect\s*&&\s*dialect\s*!==\s*'__vehicle'/,
    'firmware row shown only for Build concrete dialect'
  );
  assert.match(html, /id="row-mission-firmware"/, 'template must have a firmware row');
  assert.match(html, /id="node-input-firmware"/, 'template must have the firmware select');
});

test('mavlink-mission firmware type list follows dialect, vehicle, or connection', () => {
  // The type list repopulates using effectiveFirmware() which reads from the
  // Build firmware select, Build Vehicle Profile escape, or wire Connection profile.
  assert.match(html, /function getEffectiveFirmware/, 'getEffectiveFirmware function present');
  assert.match(html, /function repopulateTypes/, 'repopulateTypes function present');
  assert.match(html, /getEffectiveFirmware\(\)/, 'repopulateTypes calls getEffectiveFirmware');
});

test('mavlink-mission getEffectiveFirmware is tier-aware', () => {
  // Build tier reads firmware directly unless dialect is __vehicle; wire tier
  // reads from the connection's vehicle node.
  assert.match(html, /delivery.*===.*'build'|'build'.*===.*delivery/,
    'firmware derivation branches on delivery tier');
  assert.match(html, /dialect\s*===\s*'__vehicle'/, 'Vehicle Profile escape gates profile firmware');
  assert.match(html, /node-input-firmware.*\.val\(\)|\.val\(\).*node-input-firmware/s,
    'firmware field consulted on concrete Build dialect');
  assert.match(html, /node-input-vehicle.*\.val\(\)|\.val\(\).*node-input-vehicle/s,
    'vehicle field consulted for __vehicle build tier');
  assert.match(html, /conn\.vehicle/, 'connection vehicle consulted on wire tier');
  assert.doesNotMatch(
    /function getEffectiveFirmware\(\)\s*\{[\s\S]*?\n\s*\}/.exec(html)?.[0] || '',
    /return\s+['"]ardupilot['"]/,
    'effectiveFirmware must not invent ardupilot when no source is selected'
  );
});

test('mavlink-mission target sysid/compid default to empty (inherit profile)', () => {
  assert.match(html, /targetSystem:\s*\{\s*value:\s*''/, 'sysid default is empty string');
  assert.match(html, /targetComponent:\s*\{\s*value:\s*''/, 'compid default is empty string');
  assert.match(html, /placeholder="[^"]*profile default[^"]*"/, 'sysid has profile default placeholder');
  assert.match(html, /emptyLabel:\s*'[^']*profile default[^']*'/, 'compid empty label names profile default');
});

test('mavlink-mission confirmClear stays visible for clear on every tier', () => {
  // The runtime confirm gate guards construction (it runs before the Build
  // branch), so the checkbox must not hide on the build tier — hidden is not
  // honored (§6), and a hidden-but-honored checkbox would be worse.
  assert.match(html, /mavlink-mission-confirm'\)\.toggle\(op === 'clear'\)/,
    'confirmClear visibility depends only on the clear operation');
});

test('mavlink-mission ensureConfigNodePicker called for vehicle', () => {
  assert.match(
    html,
    /ensureConfigNodePicker\(node,\s*'vehicle',\s*'mavlink-vehicle'/,
    'ensureConfigNodePicker invoked for vehicle field'
  );
});

test('mavlink-mission enum catalog loaded via shared loadEnumsCatalog helper', () => {
  // Mission node delegates catalog fetching to the shared loadEnumsCatalog helper
  // (which internally uses adminApiUrl). Verify that the MAV_COMPONENT catalog
  // is loaded and fillCompIdSelect is called.
  assert.match(html, /loadEnumsCatalog/, 'enum catalog loaded via shared helper');
  assert.match(html, /MAV_COMPONENT/, 'MAV_COMPONENT enum catalog requested');
  assert.match(html, /fillCompIdSelect/, 'compid select filled from catalog');
});
