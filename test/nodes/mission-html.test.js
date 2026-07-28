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

test('mavlink-mission firmware select is gone (§6 hidden is not honored)', () => {
  assert.ok(
    !html.includes('node-input-firmware'),
    'firmware input must not exist in mission editor'
  );
  assert.ok(
    !/firmware:\s*\{\s*value:/.test(html),
    'firmware default must be removed from mission defaults'
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

test('mavlink-mission firmware type list derived from profile, not firmware select', () => {
  // The type list repopulates using getEffectiveFirmware() which reads from the
  // connection or vehicle node, never from a firmware <select>.
  assert.match(html, /function getEffectiveFirmware/, 'getEffectiveFirmware function present');
  assert.match(html, /function repopulateTypes/, 'repopulateTypes function present');
  assert.match(html, /getEffectiveFirmware\(\)/, 'repopulateTypes calls getEffectiveFirmware');
});

test('mavlink-mission getEffectiveFirmware is tier-aware', () => {
  // Build tier reads from vehicle field; wire tier from connection's vehicle node.
  assert.match(html, /delivery.*===.*'build'|'build'.*===.*delivery/,
    'firmware derivation branches on delivery tier');
  assert.match(html, /node-input-vehicle.*\.val\(\)|\.val\(\).*node-input-vehicle/s,
    'vehicle field consulted on build tier');
  assert.match(html, /conn\.vehicle/, 'connection vehicle consulted on wire tier');
});

test('mavlink-mission target sysid/compid default to empty (inherit profile)', () => {
  assert.match(html, /targetSystem:\s*\{\s*value:\s*''/, 'sysid default is empty string');
  assert.match(html, /targetComponent:\s*\{\s*value:\s*''/, 'compid default is empty string');
  assert.match(html, /placeholder="[^"]*profile default[^"]*"/, 'sysid has profile default placeholder');
  assert.match(html, /emptyLabel:\s*'[^']*profile default[^']*'/, 'compid empty label names profile default');
});

test('mavlink-mission confirmClear row hidden on build tier', () => {
  // The spec says confirmClear guards the destructive clear on wire tiers;
  // hiding it on build is correct since a built plan is not destructive by itself.
  assert.match(html, /mavlink-mission-confirm/, 'confirmClear row present');
  assert.match(html, /isBuild/, 'build tier detection exists');
  // The visibility for confirm row involves !isBuild condition.
  assert.match(html, /!\s*isBuild/, 'confirmClear hidden on build tier');
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
