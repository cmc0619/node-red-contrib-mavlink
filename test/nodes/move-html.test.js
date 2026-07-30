'use strict';

/**
 * mavlink-move editor: mode/delivery-driven field visibility (DESIGN.md §6).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { assertChangeHandlerContains } = require('./html-assert');

const html = fs.readFileSync(
  path.join(__dirname, '..', '..', 'nodes', 'mavlink-move.html'),
  'utf8'
);

const ROW_IDS = [
  'row-move-north',
  'row-move-east',
  'row-move-up',
  'row-move-lat',
  'row-move-lon',
  'row-move-alt',
  'row-move-vNorth',
  'row-move-vEast',
  'row-move-vUp',
  'row-move-yaw',
  'row-move-yawRate',
  'row-move-interval',
  'row-move-ttl',
];

test('mavlink-move editor reshapes fields by mode and delivery (§6)', () => {
  assert.match(html, /function refreshVisibility/, 'mode/delivery drive row visibility');
  assert.match(
    html,
    /\$\('#node-input-mode'\)\.on\('change', refreshVisibility\)/,
    'mode change refreshes visibility'
  );
  assertChangeHandlerContains(
    html,
    "$('#node-input-delivery')",
    'reloadTargetCompId()',
    'delivery change refreshes CompID catalog'
  );
  assert.match(html, /refreshVisibility\(\)/, 'visibility is applied on dialog open');

  for (const id of ROW_IDS) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} row must exist`);
  }

  assert.match(html, /mode === 'local-position'/, 'local position fields gated on mode');
  assert.match(html, /mode === 'local-velocity'/, 'local velocity fields gated on mode');
  assert.match(html, /mode === 'global-position'/, 'global position fields gated on mode');
  assert.match(html, /delivery === 'stream'/, 'stream interval and TTL gated on delivery');
});

test('mavlink-move has one labeled row per parameter, not dual local/global rows', () => {
  assert.ok(
    !html.includes('North / Lat'),
    'dual North / Lat label must be gone'
  );
  assert.ok(
    !html.includes('East / Lon'),
    'dual East / Lon label must be gone'
  );
  assert.ok(
    !html.includes('Up / Alt'),
    'dual Up / Alt label must be gone'
  );
  assert.match(html, /Metres north/, 'north has its own label');
  assert.match(html, /Degrees lat/, 'lat has its own label');
  assert.match(html, /North m\/s/, 'vNorth has its own label');

  for (const id of ['node-input-north', 'node-input-lat', 'node-input-vNorth']) {
    const rowPattern = new RegExp(
      `<div class="form-row"[^>]*>[\\s\\S]*?id="${id}"`,
      'm'
    );
    const matches = html.match(new RegExp(rowPattern, 'g')) || [];
    assert.equal(matches.length, 1, `${id} must appear on exactly one form-row`);
  }
});

test('mavlink-move keeps target sysid/compid and reloadCompIdSelect catalog', () => {
  assert.match(html, /id="node-input-targetSystem"/, 'target sysid field remains');
  assert.match(html, /id="node-input-targetComponent"/, 'target compid select remains');
  assert.match(html, /reloadCompIdSelect/, 'compid enum catalog uses shared helper');
  assert.match(html, /ensureConfigNodePicker/, 'connection picker remains');
  assertChangeHandlerContains(
    html,
    "$('#node-input-connection')",
    'reloadTargetCompId()',
    'connection change reloads CompID'
  );
  assertChangeHandlerContains(
    html,
    "$('#node-input-vehicle')",
    'reloadTargetCompId()',
    'vehicle change reloads CompID'
  );
});

test('mavlink-move target sysid/compid default to empty (inherit profile) not 1', () => {
  assert.match(html, /targetSystem:\s*\{\s*value:\s*''/, 'sysid default is empty string');
  assert.match(html, /targetComponent:\s*\{\s*value:\s*''/, 'compid default is empty string');
  assert.match(html, /RED\.validators\.number\(true\)/, 'blank-allowed validator is used');
  assert.match(html, /placeholder="[^"]*profile default[^"]*"/, 'sysid has profile default placeholder');
  assert.match(html, /reloadCompIdSelect\(/, 'compid uses shared reloadCompIdSelect');
});

test('mavlink-move has vehicle and identity defaults for role × tier matrix (§6)', () => {
  // The vehicle (mavlink-vehicle) descriptor is contributed by the shared
  // buildTierDialectDefaults(); the delegation is asserted below.
  assert.match(html, /identity:\s*\{\s*value:\s*''/, 'identity default is empty string');
  assert.match(html, /ensureConfigNodePicker[^)]*'vehicle'/, 'vehicle uses config node picker');
  assert.match(html, /id="node-input-identity"/, 'identity select exists in template');
  assert.match(html, /id="row-move-vehicle"/, 'vehicle row has ID for tier-driven toggling');
  assert.match(html, /id="row-move-identity"/, 'identity row has ID for tier-driven toggling');
  assert.match(html, /id="row-move-connection"/, 'connection row has ID for tier-driven toggling');
});

test('mavlink-move fills identity select and re-fills on connection change (§6)', () => {
  assert.match(html, /fillIdentitySelect/, 'fillIdentitySelect fills the identity dropdown');
  assert.match(
    html,
    /\$\('#node-input-identity'\)\.on\('change', refreshVisibility\)/,
    'identity change triggers visibility refresh'
  );
  assert.match(
    html,
    /\$\('#node-input-connection'\)\.on\('change'/,
    'connection change handler exists'
  );
  assert.match(html, /fillIdentitySelect[^)]*\$\('#node-input-identity'\)/, 'identity refilled on connection change');
});

test('mavlink-move companion hides both target sysid and compid rows (§6)', () => {
  assert.match(html, /isCompanion/, 'companion flag drives visibility');
  assert.match(html, /id="row-move-targetSystem"/, 'targetSystem row has ID for toggling');
  assert.match(html, /id="row-move-targetComponent"/, 'targetComponent row has ID for toggling');
  assert.match(
    html,
    /targetSystem:\s*isBuild\s*\|\|\s*!isCompanion/,
    'sysid gated by companion for move'
  );
  assert.match(
    html,
    /targetComponent:\s*isBuild\s*\|\|\s*!isCompanion/,
    'compid also gated by companion for move (no spec exception here)'
  );
});

test('mavlink-move build tier shows vehicle, hides connection/identity (§6)', () => {
  assert.match(html, /dialect:\s*isBuild/, 'dialect row shown only for build tier');
  assert.match(html, /vehicle:\s*isBuild\s*&&\s*dialect\s*===\s*'__vehicle'/, 'vehicle row shown only for Build Vehicle Profile escape');
  assert.match(html, /connection:\s*isWire/, 'connection row shown only for wire tiers');
  assert.match(html, /identity:\s*isWire/, 'identity row shown only for wire tiers');
});

test('mavlink-move dialect + vehicle defaults come from the shared Build-tier helper', () => {
  // dialect/vehicle descriptors + validators are the shared §6 rule, merged via
  // buildTierDialectDefaults (delivery mode, no firmware). Validator behaviour
  // is proven in mavlink-editor-resource.test.js.
  assert.match(
    html,
    /Object\.assign\([\s\S]*RED\.mavlink\.buildTierDialectDefaults\(\)\s*\)/,
    'Move defaults must merge buildTierDialectDefaults()'
  );
});

test('mavlink-move Build dialect select uses shared helper with Vehicle Profile escape', () => {
  assert.match(html, /id="row-move-dialect"/, 'template must have a dialect row');
  assert.match(html, /id="node-input-dialect"/, 'template must have a dialect select');
  assert.match(html, /RED\.mavlink\.populateDialectSelect\(/, 'dialect select must use shared helper');
  assert.match(html, /includeVehicleEscape:\s*true/, 'dialect helper must include Vehicle Profile escape');
  assert.match(html, /__vehicle/, 'visibility/runtime contract must reference __vehicle');
  assert.match(html, /from Vehicle Profile/, 'help text must name the Vehicle Profile escape');
});

test('mavlink-move has no Firmware row and no silent ardupilotmega default', () => {
  assert.doesNotMatch(html, /node-input-firmware|row-move-firmware|Firmware/, 'Move must not add a Firmware row');
  assert.doesNotMatch(html, /ardupilotmega/, 'Move editor must not invent a default dialect');
});
