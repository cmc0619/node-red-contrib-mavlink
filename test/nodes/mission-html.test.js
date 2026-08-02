'use strict';

/**
 * Mission editor: role × tier visibility and catalog derivation (DESIGN.md §6).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { assertChangeHandlerContains } = require('./html-assert');

const html = fs.readFileSync(
  path.join(__dirname, '..', '..', 'nodes', 'mavlink-mission.html'),
  'utf8'
);

test('mavlink-mission has identity default (vehicle comes from the shared helper)', () => {
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

test('mavlink-mission dialect + vehicle + firmware defaults come from the shared helper', () => {
  // dialect/vehicle/firmware descriptors + the §6 Firmware XOR validator are
  // the shared Build-tier rule, merged via buildTierDialectDefaults with
  // withFirmware. Validator behaviour is proven in
  // mavlink-editor-resource.test.js.
  assert.match(
    html,
    /Object\.assign\([\s\S]*RED\.mavlink\.buildTierDialectDefaults\(\{\s*withFirmware:\s*true\s*\}\)\s*\)/,
    'Mission defaults must merge buildTierDialectDefaults({ withFirmware: true })'
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
  // Runtime firmware path still gates on the escape value (getEffectiveFirmware).
  assert.match(html, /dialect\s*!==\s*'__vehicle'/, 'Vehicle Profile escape gates profile firmware');
});

test('mavlink-mission Build visibility delegates shared rows to applyBuildTierRowVisibility', () => {
  assert.match(
    html,
    /RED\.mavlink\.applyBuildTierRowVisibility\(\{/,
    'Mission must call the shared visibility helper'
  );
  assert.match(html, /dialectRow:\s*'#row-mission-dialect'/, 'dialect row selector passed');
  assert.match(html, /vehicleRow:\s*'#row-vehicle'/, 'vehicle row selector passed');
  assert.match(html, /firmwareRow:\s*'#row-mission-firmware'/, 'firmware row selector passed');
  assert.match(html, /connectionRow:\s*'#row-connection'/, 'connection row selector passed');
  assert.match(html, /id="row-mission-firmware"/, 'template must have a firmware row');
  assert.match(html, /id="node-input-firmware"/, 'template must have the firmware select');
  assert.doesNotMatch(
    html,
    /\$\('#row-mission-dialect'\)\.toggle/,
    'no hand-rolled dialect row toggle'
  );
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
  assert.match(html, /dialect\s*!==\s*'__vehicle'/, 'Vehicle Profile escape gates profile firmware');
  assert.match(html, /node-input-firmware.*\.val\(\)|\.val\(\).*node-input-firmware/s,
    'firmware field consulted on concrete Build dialect');
  assert.match(html, /node-input-vehicle.*\.val\(\)|\.val\(\).*node-input-vehicle/s,
    'vehicle field consulted for __vehicle build tier');
  assert.match(html, /conn\.vehicle/, 'connection vehicle consulted on wire tier');
  // Closing brace is indented two spaces (function scope), not nested blocks.
  const firmwareFn = /function getEffectiveFirmware\(\)\s*\{[\s\S]*?\n {2}\}/.exec(html);
  assert.ok(firmwareFn, 'getEffectiveFirmware function body must be extractable');
  assert.doesNotMatch(
    firmwareFn[0],
    /return\s+['"]ardupilot['"]/,
    'effectiveFirmware must not invent ardupilot when no source is selected'
  );
});

test('mavlink-mission target sysid/compid default to empty (inherit profile)', () => {
  assert.match(html, /targetSystem:\s*\{\s*value:\s*''/, 'sysid default is empty string');
  assert.match(html, /targetComponent:\s*\{\s*value:\s*''/, 'compid default is empty string');
  assert.match(html, /placeholder="[^"]*profile default[^"]*"/, 'sysid has profile default placeholder');
  assert.match(html, /RED\.mavlink\.reloadTargetCompId\(node\)/, 'compid uses shared reloadTargetCompId');
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

test('mavlink-mission enum catalog loaded via shared reloadTargetCompId helper', () => {
  assert.match(html, /RED\.mavlink\.reloadTargetCompId\(node\)/, 'compid catalog loaded via shared helper');
  assert.match(html, /node-input-targetComponent/, 'targetComponent select is filled');
  assertChangeHandlerContains(
    html,
    "$('#node-input-delivery')",
    'RED.mavlink.reloadTargetCompId(node)',
    'delivery change reloads CompID'
  );
  assertChangeHandlerContains(
    html,
    "$('#node-input-connection')",
    'RED.mavlink.reloadTargetCompId(node)',
    'connection change reloads CompID'
  );
  assertChangeHandlerContains(
    html,
    "$('#node-input-vehicle')",
    'RED.mavlink.reloadTargetCompId(node)',
    'vehicle change reloads CompID'
  );
});
