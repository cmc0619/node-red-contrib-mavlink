'use strict';

/**
 * Param editor: param-def catalog loads from the admin API (DESIGN.md §6).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { assertChangeHandlerContains } = require('./html-assert');

const html = fs.readFileSync(
  path.join(__dirname, '..', '..', 'nodes', 'mavlink-param.html'),
  'utf8'
);

test('param defs load from the mavlink/param/defs admin route', () => {
  assert.match(html, /function loadParamDefs/, 'param defs loader exists');
  assert.match(
    html,
    /RED\.mavlink\.adminApiUrl\(['"]\/mavlink\/param\/defs['"]\)/,
    'param defs catalog is loaded from admin API'
  );
});

test('admin catalog fetches use adminApiUrl (httpAdminRoot-safe)', () => {
  assert.match(html, /RED\.mavlink\.adminApiUrl\(/, 'admin fetches must use adminApiUrl');
  assert.ok(
    !/\$\.getJSON\(\s*['"]\/mavlink\//.test(html),
    'bare absolute /mavlink getJSON paths must be gone'
  );
});

test('mavlink-param target sysid/compid default to empty (inherit profile) not 1', () => {
  assert.match(html, /targetSystem:\s*\{\s*value:\s*''/, 'sysid default is empty string');
  assert.match(html, /targetComponent:\s*\{\s*value:\s*''/, 'compid default is empty string');
  assert.match(html, /placeholder="[^"]*profile default[^"]*"/, 'sysid has profile default placeholder');
  assert.match(html, /RED\.mavlink\.reloadTargetCompId\(node\)/, 'compid uses shared reloadTargetCompId');
});

test('mavlink-param has identity default (vehicle comes from the shared helper)', () => {
  assert.match(
    html,
    /identity:\s*\{\s*value:\s*''\s*\}/,
    'identity default exists with empty value'
  );
});

test('mavlink-param calls refreshIdentitySelect on connection change', () => {
  assert.match(html, /RED\.mavlink\.refreshIdentitySelect\(node\)/, 'shared refreshIdentitySelect is called');
  assert.match(html, /node-input-identity/, 'identity select element exists');
  assert.doesNotMatch(html, /function refreshIdentitySelect/, 'no local identity-refresh copy');
});

test('mavlink-param dialect + vehicle + firmware defaults come from the shared helper', () => {
  // dialect/vehicle/firmware descriptors + the §6 Firmware XOR validator are
  // the shared Build-tier rule, merged via buildTierDialectDefaults with
  // withFirmware. Validator behaviour is proven in
  // mavlink-editor-resource.test.js.
  assert.match(
    html,
    /Object\.assign\([\s\S]*RED\.mavlink\.buildTierDialectDefaults\(\{\s*withFirmware:\s*true\s*\}\)\s*\)/,
    'Param defaults must merge buildTierDialectDefaults({ withFirmware: true })'
  );
});

test('mavlink-param Build shows Dialect and concrete dialects require Firmware', () => {
  assert.match(html, /node-input-dialect/, 'dialect select element exists');
  assert.match(html, /row-firmware/, 'firmware row exists');
  assert.match(html, /node-input-firmware/, 'firmware select element exists');
  assert.match(html, /value="ardupilot"/, 'ArduPilot firmware option exists');
  assert.match(html, /value="px4"/, 'PX4 firmware option exists');
  assert.match(html, /value="custom"/, 'custom firmware option exists');
  // Firmware XOR validator lives in buildTierDialectDefaults({ withFirmware: true })
  // — proven in mavlink-editor-resource.test.js. Param pins the merge, not a paste.
  assert.match(
    html,
    /buildTierDialectDefaults\(\{\s*withFirmware:\s*true\s*\}\)/,
    'firmware XOR validator comes from the shared Build-tier helper'
  );
});

test('mavlink-param has refreshVisibility and companion row hiding', () => {
  assert.match(html, /function refreshVisibility/, 'refreshVisibility function present');
  assert.match(
    html,
    /RED\.mavlink\.applyCompanionTargetVisibility\(/,
    'shared companion target visibility helper is used'
  );
  assert.match(html, /targetSystemRow:\s*['"]#row-targetSystem['"]/, 'row-targetSystem referenced');
  assert.match(html, /targetComponentRow:\s*['"]#row-targetComponent['"]/, 'row-targetComponent referenced');
  assert.match(html, /row-vehicle/, 'row-vehicle present for build tier');
  assert.match(html, /row-connection/, 'row-connection present for wire tiers');
  assert.match(html, /row-identity/, 'row-identity present for wire tiers');
  assert.match(html, /row-dialect/, 'row-dialect present for build tier');
  assert.match(html, /row-firmware/, 'row-firmware present for concrete build dialects');
  assert.match(
    html,
    /RED\.mavlink\.applyBuildTierRowVisibility\(\{/,
    'Param must call the shared visibility helper'
  );
  assert.match(html, /dialectRow:\s*'#row-dialect'/, 'dialect row selector passed');
  assert.match(html, /vehicleRow:\s*'#row-vehicle'/, 'vehicle row selector passed');
  assert.match(html, /firmwareRow:\s*'#row-firmware'/, 'firmware row selector passed');
  assert.match(html, /connectionRow:\s*'#row-connection'/, 'connection row selector passed');
  assert.doesNotMatch(
    html,
    /\$\('#row-dialect'\)\.toggle/,
    'no hand-rolled dialect row toggle'
  );
});

test('mavlink-param loadParamDefs is tier-aware (build uses dialect or vehicle, wire uses connection)', () => {
  assert.match(html, /node-input-dialect.*\.val\(\)|\.val\(\).*node-input-dialect/s,
    'dialect field used in defs load');
  assert.match(html, /dialect\s*===\s*'__vehicle'/,
    'build defs load supports the Vehicle Profile dialect escape');
  assert.match(html, /query\s*=\s*\{\s*dialect:\s*dialect\s*\}/,
    'concrete build dialect loads defs by dialect');
  assert.doesNotMatch(html, /ardupilotmega/, 'defs load must not invent ardupilotmega');
  // Wire tier: reads vehicleId through connection node
  assert.match(html, /connectionNode\.vehicle/, 'defs load reads vehicle through connection node');
  // Delivery-driven branch
  assert.match(html, /delivery.*===.*'build'|'build'.*===.*delivery/,
    'defs load is branched on delivery tier');
});

test('mavlink-param ensureConfigNodePicker called for vehicle', () => {
  assert.match(
    html,
    /ensureConfigNodePicker\(node,\s*'vehicle',\s*'mavlink-vehicle'/,
    'ensureConfigNodePicker invoked for vehicle field'
  );
});

test('mavlink-param populates Dialect select with Vehicle Profile escape', () => {
  assert.match(html, /populateDialectSelect/, 'Dialect helper is called');
  assert.match(html, /includeVehicleEscape:\s*true/, 'Vehicle Profile escape is included');
});

test('mavlink-param CompID reloads when catalog source changes', () => {
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
  assertChangeHandlerContains(
    html,
    "$('#node-input-dialect')",
    'RED.mavlink.reloadTargetCompId(node)',
    'dialect change reloads CompID'
  );
});

/**
 * The value validator. Node-RED evaluates `validate` outside oneditprepare, so
 * it reads a script-scope mirror of the definitions rather than the dialog's
 * own cache — this exercises the real function out of the file.
 */
function mountValueValidator(defs, liveParamId) {
  const start = html.indexOf('var _paramDefsByKey = {};');
  const end = html.indexOf("RED.nodes.registerType('mavlink-param'", start);
  assert.ok(start >= 0 && end > start, 'the keyed cache and key helper are present');

  const valueStart = html.indexOf('validate: function (v) {', 0);
  assert.ok(valueStart > 0, 'the value validator is present');
  const valueEnd = html.indexOf('\n        },', valueStart);
  const body = html.slice(valueStart + 'validate: function (v) {'.length, valueEnd);

  const context = {
    $: () => ({ val: () => liveParamId }),
    Number,
    RED: { nodes: { node: () => null } },
  };
  vm.runInNewContext(
    `${html.slice(start, end)}
     _paramDefsByKey[paramDefsKey({})] = ${JSON.stringify(defs)};
     this.validateForTest = function (v) { ${body} };`,
    context
  );
  return context.validateForTest;
}

const RANGE_DEFS = { RC1_MIN: { min: 800, max: 2200 } };

test('mavlink-param value validator: blank defers to msg.payload rather than failing', () => {
  const validate = mountValueValidator(RANGE_DEFS, 'RC1_MIN');
  assert.equal(validate(''), true);
  assert.equal(validate(undefined), true);
  assert.equal(validate('   '), true);
});

test('mavlink-param value validator: refuses a value outside the documented range', () => {
  const validate = mountValueValidator(RANGE_DEFS, 'RC1_MIN');
  assert.equal(validate(1500), true, 'inside');
  assert.equal(validate(800), true, 'the bounds themselves are legal');
  assert.equal(validate(2200), true);
  assert.equal(validate(50), false, 'below min');
  assert.equal(validate(9000), false, 'above max');
});

test('mavlink-param value validator: non-numeric always fails', () => {
  const validate = mountValueValidator(RANGE_DEFS, 'RC1_MIN');
  assert.equal(validate('abc'), false);
});

test('mavlink-param value validator: an unknown parameter is never rejected for being unknown', () => {
  // Lua scripts and custom builds declare parameters no metadata file has;
  // definitions are advisory here, not an allowlist.
  const validate = mountValueValidator(RANGE_DEFS, 'SCR_USER1');
  assert.equal(validate(999999), true);
  assert.equal(validate(-1), true);
  assert.equal(validate('abc'), false, 'but it still has to be a number');
});

test('mavlink-param value validator: with no definitions loaded it is the plain numeric check', () => {
  const validate = mountValueValidator({}, 'RC1_MIN');
  assert.equal(validate(50), true);
  assert.equal(validate('abc'), false);
});

/**
 * Definition sets are keyed, not mirrored. A single script-scope table would be
 * whatever the last opened dialog loaded, so validating a *different* node
 * would range-check against the wrong firmware — RC1_MIN is 800–1500 on PX4 and
 * 800–2200 on ArduPilot, so opening a PX4 node then deploying an ArduPilot one
 * with 2000 would fail on a value that firmware accepts.
 */
function mountKeyedValidator(byKey, editedNode, liveParamId) {
  const start = html.indexOf('var _paramDefsByKey = {};');
  const end = html.indexOf("RED.nodes.registerType('mavlink-param'", start);
  assert.ok(start >= 0 && end > start, 'the keyed cache and key helper are present');

  const valueStart = html.indexOf('validate: function (v) {', 0);
  const valueEnd = html.indexOf('\n        },', valueStart);
  const body = html.slice(valueStart + 'validate: function (v) {'.length, valueEnd);

  const context = {
    $: () => ({ val: () => liveParamId }),
    Number,
    RED: { nodes: { node: () => null } },
  };
  vm.runInNewContext(
    `${html.slice(start, end)}
     this.keyForTest = paramDefsKey;
     this.seed = function (map) { for (var k in map) { _paramDefsByKey[k] = map[k]; } };
     this.validateForTest = function (v) { ${body} };`,
    context
  );
  context.seed(byKey);
  return context.validateForTest.bind(editedNode);
}

const PX4_KEY = 'dialect:development|px4';
const AP_KEY = 'dialect:ardupilotmega|ardupilot';
const BY_KEY = {
  [PX4_KEY]: { RC1_MIN: { min: 800, max: 1500 } },
  [AP_KEY]: { RC1_MIN: { min: 800, max: 2200 } },
};

test('mavlink-param value validator: each node is checked against its own firmware', () => {
  const px4Node = { delivery: 'build', dialect: 'development', firmware: 'px4' };
  const apNode = { delivery: 'build', dialect: 'ardupilotmega', firmware: 'ardupilot' };

  const validatePx4 = mountKeyedValidator(BY_KEY, px4Node, 'RC1_MIN');
  const validateAp = mountKeyedValidator(BY_KEY, apNode, 'RC1_MIN');

  assert.equal(validatePx4(2000), false, 'PX4 tops out at 1500');
  assert.equal(validateAp(2000), true, 'ArduPilot allows 2000 — the reported bug');
  assert.equal(validateAp(2500), false, 'and still enforces its own 2200');
});

test('mavlink-param value validator: a node whose definitions were never loaded skips the check', () => {
  // The safe direction: no entry means no bounds to apply, never someone
  // else's bounds.
  const strangerNode = { delivery: 'build', dialect: 'common', firmware: 'custom' };
  const validate = mountKeyedValidator(BY_KEY, strangerNode, 'RC1_MIN');
  assert.equal(validate(99999), true);
  assert.equal(validate('abc'), false, 'but it is still a number check');
});

test('mavlink-param defs key: the Vehicle Profile escape keys on the profile, not the dialect', () => {
  const key = mountKeyedValidator(BY_KEY, {}, '') && null;
  // Re-mount just to reach the exported helper.
  const start = html.indexOf('var _paramDefsByKey = {};');
  const end = html.indexOf("RED.nodes.registerType('mavlink-param'", start);
  const context = { $: () => ({ val: () => '' }), RED: { nodes: { node: () => ({ vehicle: 'v9' }) } } };
  vm.runInNewContext(`${html.slice(start, end)}\nthis.k = paramDefsKey;`, context);

  assert.equal(
    context.k({ delivery: 'build', dialect: '__vehicle', vehicle: 'v1' }),
    'vehicle:v1'
  );
  assert.notEqual(
    context.k({ delivery: 'build', dialect: '__vehicle', vehicle: 'v1' }),
    context.k({ delivery: 'build', dialect: '__vehicle', vehicle: 'v2' }),
    'two profiles are two definition sets'
  );
  // Wire tiers resolve the profile through the connection.
  assert.equal(context.k({ delivery: 'send', connection: 'c1' }), 'vehicle:v9');
  assert.equal(key, null);
});
