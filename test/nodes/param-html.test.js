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
  const start = html.indexOf('var _paramDefsForValidation = {};');
  const end = html.indexOf("RED.nodes.registerType('mavlink-param'", start);
  assert.ok(start >= 0 && end > start, 'the validation mirror and helper are present');

  const valueStart = html.indexOf('validate: function (v) {', 0);
  assert.ok(valueStart > 0, 'the value validator is present');
  const valueEnd = html.indexOf('\n        },', valueStart);
  const body = html.slice(valueStart + 'validate: function (v) {'.length, valueEnd);

  const context = {
    $: () => ({ val: () => liveParamId }),
    Number,
  };
  vm.runInNewContext(
    `${html.slice(start, end)}
     _paramDefsForValidation = ${JSON.stringify(defs)};
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
