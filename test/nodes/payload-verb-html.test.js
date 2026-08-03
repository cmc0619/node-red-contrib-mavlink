'use strict';

/**
 * Payload verb editor: topic-dependent <select> on mavlink-payload and
 * mavlink-fanout (DESIGN.md §6 / §9).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { PAYLOAD_VERBS } = require('../../lib/payload');
const { assertChangeHandlerContains } = require('./html-assert');

const payloadHtml = fs.readFileSync(
  path.join(__dirname, '..', '..', 'nodes', 'mavlink-payload.html'),
  'utf8'
);
const fanoutHtml = fs.readFileSync(
  path.join(__dirname, '..', '..', 'nodes', 'mavlink-fanout.html'),
  'utf8'
);

function assertVerbSelect(html, label) {
  assert.match(
    html,
    /<select id="node-input-verb">/,
    `${label}: verb must be a select`
  );
  assert.ok(
    !html.includes('type="text" id="node-input-verb"'),
    `${label}: free-form verb input must be gone`
  );
}

test('mavlink-payload verb is a topic-dependent select', () => {
  assertVerbSelect(payloadHtml, 'mavlink-payload');
  assert.match(
    payloadHtml,
    /RED\.mavlink\.refreshVerbOptions/,
    'verb options come from the shared helper'
  );
  assert.match(
    payloadHtml,
    /\$topic\.on\('change'/,
    'topic change refreshes verb options'
  );
  assert.match(
    payloadHtml,
    /Object\.keys\(RED\.mavlink\.PAYLOAD_VERBS\)\.forEach/,
    'topic options come from the shared table, not baked <option> markup'
  );
  assert.doesNotMatch(payloadHtml, /function refreshVerbOptions/, 'no local verb-options copy');
  assert.doesNotMatch(payloadHtml, /PAYLOAD_VERBS\s*=/, 'no local PAYLOAD_VERBS table');
});

test('mavlink-fanout verb is a topic-dependent select', () => {
  assertVerbSelect(fanoutHtml, 'mavlink-fanout');
  assert.match(
    fanoutHtml,
    /RED\.mavlink\.refreshVerbOptions/,
    'verb options come from the shared helper'
  );
  assert.match(
    fanoutHtml,
    /\$\('#node-input-topic'\)\.on\('change'/,
    'topic change refreshes verb options'
  );
  assert.doesNotMatch(fanoutHtml, /function refreshVerbOptions/, 'no local verb-options copy');
  assert.doesNotMatch(fanoutHtml, /PAYLOAD_VERBS\s*=/, 'no local PAYLOAD_VERBS table');
});

test('editor catalog includes every lib/payload verb value', () => {
  // Catalog lives once in resources/mavlink-editor.js — pin it there, not in
  // each node's HTML (the HTML only calls refreshVerbOptions).
  const resource = fs.readFileSync(
    path.join(__dirname, '..', '..', 'resources', 'mavlink-editor.js'),
    'utf8'
  );
  for (const [topic, verbs] of Object.entries(PAYLOAD_VERBS)) {
    for (const { value } of verbs) {
      assert.match(resource, new RegExp(`value:\\s*'${value}'`), `editor resource missing ${topic}/${value}`);
    }
  }
});

test('payload controls take their shape from the field metadata (§6)', () => {
  // A two-state enum is a checkbox, a bitmask is a multi-select, any other
  // enum is a pulldown, everything else is a number. None of it is a list of
  // field names in here — the route says which is which.
  assert.match(payloadHtml, /RED\.mavlink\.isFalseTrueEnum\(entries\)/, 'FALSE/TRUE → checkbox');
  assert.match(payloadHtml, /meta\.bitmask/, 'bitmask → multi-select');
  assert.match(payloadHtml, /RED\.mavlink\.fillEnumSelect/, 'other enums → pulldown');
  assert.match(payloadHtml, /input type="number"/, 'no enum → number');
  // The enum families the old dialog named by hand.
  for (const name of ['GRIPPER_ACTIONS', 'WINCH_ACTIONS', 'PARACHUTE_ACTION',
    'CAMERA_MODE', 'MAV_MOUNT_MODE']) {
    assert.ok(!payloadHtml.includes(name), `${name} must come from the dialect, not the HTML`);
  }
});

test('payload rows are generated, with dialect labels, units, ranges and defaults', () => {
  assert.match(payloadHtml, /function renderFields/);
  assert.match(payloadHtml, /meta\.label \|\| humanize\(key\)/);
  assert.match(payloadHtml, /meta\.units/);
  assert.match(payloadHtml, /meta\.minValue/);
  assert.match(payloadHtml, /meta\.maxValue/);
  // A blank box that silently sends 1 is the bug this closes.
  assert.match(payloadHtml, /saved = meta\.default === null/, 'blank falls back to the recipe default');
  assert.match(
    payloadHtml,
    /sel\.topic === 'gimbal' && sel\.verb === 'aim'/,
    'gimbal path is limited to aim'
  );
  // Gripper, winch and parachute each have one verb; the select would be a
  // control with nothing to decide.
  assert.match(payloadHtml, /PAYLOAD_VERBS\[sel\.topic\] \|\| \[\]\)\.length > 1/);
});

test('payload does not leak action ids across colliding enum families', () => {
  // `mode` and `action` are shared row keys whose enums all start at 0 — see
  // test/payload/verbs.test.js. Repainting must not hand the old id to a new
  // family: gripper HOLD (2) arriving as PARACHUTE_RELEASE (2).
  assert.match(payloadHtml, /var stashEnum = \{\};/);
  assert.match(payloadHtml, /stashEnum\[key\] !== family/);
  assert.match(payloadHtml, /var saved = stale \? undefined : stash\[key\]/);
});

test('mavlink-payload target sysid/compid default to empty (inherit profile) not 1', () => {
  assert.match(payloadHtml, /targetSystem:\s*\{\s*value:\s*''/, 'sysid default is empty string');
  assert.match(payloadHtml, /targetComponent:\s*\{\s*value:\s*''/, 'compid default is empty string');
  assert.match(payloadHtml, /placeholder="[^"]*profile default[^"]*"/, 'sysid has profile default placeholder');
  assert.match(payloadHtml, /RED\.mavlink\.reloadTargetCompId\(node\)/, 'compid uses shared reloadTargetCompId');
});

test('payload number inputs take step from the dialect increment', () => {
  assert.match(
    payloadHtml,
    /\.attr\('step', meta\.increment !== null && meta\.increment !== undefined \? meta\.increment : 'any'\)/,
    'increment when the dialect gives one, otherwise fractional-safe'
  );
});


test('mavlink-payload has vehicle and identity defaults for role × tier matrix (§6)', () => {
  // The vehicle (mavlink-vehicle) descriptor is contributed by the shared
  // buildTierDialectDefaults(); the delegation is asserted below.
  assert.match(payloadHtml, /identity:\s*\{\s*value:\s*''/, 'identity default is empty string');
  assert.match(payloadHtml, /RED\.mavlink\.refreshIdentitySelect\(node\)/, 'shared refreshIdentitySelect fills the identity dropdown');
  assert.match(payloadHtml, /id="row-payload-vehicle"/, 'vehicle row has ID for tier-driven toggling');
  assert.match(payloadHtml, /id="row-payload-identity"/, 'identity row has ID for tier-driven toggling');
  assert.match(payloadHtml, /id="row-payload-connection"/, 'connection row has ID for tier-driven toggling');
  assert.match(payloadHtml, /ensureConfigNodePicker[^)]*'vehicle'/, 'vehicle uses config node picker');
});

test('mavlink-payload companion hides sysid row but NOT compid row (§6 spec exception)', () => {
  assert.match(
    payloadHtml,
    /RED\.mavlink\.applyCompanionTargetVisibility\(/,
    'shared companion target visibility helper is used'
  );
  assert.match(payloadHtml, /id="row-payload-targetSystem"/, 'targetSystem row has ID');
  assert.match(payloadHtml, /id="row-payload-targetComponent"/, 'targetComponent row has ID');
  assert.match(
    payloadHtml,
    /hideCompidWhenCompanion:\s*false/,
    'payload keeps compid visible on companion (compidFromConfig exception)'
  );
  assert.match(
    payloadHtml,
    /targetSystemRow:\s*['"]#row-payload-targetSystem['"]/,
    'sysid gated by companion for payload'
  );
  assert.match(
    payloadHtml,
    /targetComponentRow:\s*['"]#row-payload-targetComponent['"]/,
    'compid row still wired through the shared helper'
  );
});

test('mavlink-payload build tier shows vehicle, hides connection/identity/timeout/retry (§6)', () => {
  assert.match(
    payloadHtml,
    /RED\.mavlink\.applyBuildTierRowVisibility\(\{/,
    'Payload must call the shared visibility helper'
  );
  assert.match(payloadHtml, /dialectRow:\s*'#row-payload-dialect'/, 'dialect row selector passed');
  assert.match(payloadHtml, /vehicleRow:\s*'#row-payload-vehicle'/, 'vehicle row selector passed');
  assert.match(payloadHtml, /connectionRow:\s*'#row-payload-connection'/, 'connection row selector passed');
  assert.match(payloadHtml, /#row-payload-identity'\)\.toggle\(isWire\)/, 'identity row shown only for wire tiers');
  assert.match(payloadHtml, /#row-payload-timeout'\)\.toggle\(isWire\)/, 'timeout row shown only for wire tiers');
  assert.match(payloadHtml, /#row-payload-maxRetries'\)\.toggle\(isWire\)/, 'maxRetries row shown only for wire tiers');
  assert.match(payloadHtml, /id="row-payload-dialect"/, 'dialect row has ID for toggling');
  assert.match(payloadHtml, /id="row-payload-timeout"/, 'timeout row has ID for toggling');
  assert.match(payloadHtml, /id="row-payload-maxRetries"/, 'maxRetries row has ID for toggling');
  assert.doesNotMatch(
    payloadHtml,
    /\$\('#row-payload-dialect'\)\.toggle/,
    'no hand-rolled dialect row toggle'
  );
});

test('mavlink-payload Build dialect picker keeps empty invalid and offers Vehicle Profile escape', () => {
  // dialect/vehicle descriptors + validators are the shared §6 rule, merged via
  // buildTierDialectDefaults (delivery mode, no firmware). Validator behaviour
  // is proven in mavlink-editor-resource.test.js.
  assert.match(
    payloadHtml,
    /Object\.assign\([\s\S]*RED\.mavlink\.buildTierDialectDefaults\(\)\s*\)/,
    'Payload defaults must merge buildTierDialectDefaults()'
  );
  assert.match(payloadHtml, /RED\.mavlink\.populateDialectSelect\(/, 'dialect select must use shared helper');
  assert.match(payloadHtml, /includeVehicleEscape:\s*true/, 'dialect select must include Vehicle Profile escape');
});

test('mavlink-payload Build catalog calls do not invent a dialect while dialect is empty', () => {
  assert.match(
    payloadHtml,
    /if \(isBuild\(\) && !\(query\.dialect \|\| query\.vehicle\)\)/,
    'Build with empty dialect must skip the field-tips call'
  );
  assert.doesNotMatch(payloadHtml, /ardupilotmega/, 'payload editor must not hardcode an invented dialect');
});


test('mavlink-payload fills identity select and re-fills on connection change (§6)', () => {
  assert.match(
    payloadHtml,
    /\$\('#node-input-identity'\)\.on\('change', refreshVisibility\)/,
    'identity change triggers visibility refresh'
  );
  assert.match(
    payloadHtml,
    /\$\('#node-input-connection'\)\.on\('change'/,
    'connection change handler exists'
  );
  assertChangeHandlerContains(
    payloadHtml,
    "$('#node-input-connection')",
    'RED.mavlink.refreshIdentitySelect(node)',
    'identity refilled on connection change'
  );
});

test('mavlink-payload CompID reloads when catalog source changes', () => {
  assertChangeHandlerContains(
    payloadHtml,
    "$('#node-input-delivery')",
    'RED.mavlink.reloadTargetCompId(node)',
    'delivery change reloads CompID'
  );
  assertChangeHandlerContains(
    payloadHtml,
    "$('#node-input-connection')",
    'RED.mavlink.reloadTargetCompId(node)',
    'connection change reloads CompID'
  );
  assertChangeHandlerContains(
    payloadHtml,
    "$('#node-input-vehicle')",
    'RED.mavlink.reloadTargetCompId(node)',
    'vehicle change reloads CompID'
  );
  assertChangeHandlerContains(
    payloadHtml,
    '$dialect',
    'RED.mavlink.reloadTargetCompId(node)',
    'dialect change reloads CompID'
  );
});

test('payload carrier defaults to the first valid option with no blank prompt', () => {
  assert.match(payloadHtml, /id="node-input-carrier"/, 'carrier select must bind to the carrier property');
  assert.match(
    payloadHtml,
    /carrier:\s*\{ value: 'int' \}/,
    'new payload nodes default to COMMAND_INT'
  );
  assert.doesNotMatch(payloadHtml, /select carrier/, 'carrier select has no meaningless blank prompt');
  assert.match(payloadHtml, /<option value="int">/, 'COMMAND_INT option offered');
  assert.match(payloadHtml, /<option value="long">/, 'COMMAND_LONG option offered');
});

test('payload frame row binds to the frame property and follows the INT carrier (§9)', () => {
  assert.match(payloadHtml, /id="node-input-frame"/, 'frame select must bind to the frame property');
  assert.match(
    payloadHtml,
    /frame:\s*\{ value: '' \}/,
    'frame is declared in defaults (blank = builder default GLOBAL) so the selection persists'
  );
  assert.match(payloadHtml, /row-payload-frame/, 'frame row id must exist');
  assert.match(payloadHtml, /\$\('#node-input-carrier'\)\.on\('change'/, 'carrier change re-evaluates the frame row');
  // Carrier only shows where it is observable, and is pinned to what is sent
  // when it is not — §6 hidden is not honored, without a runtime branch.
  assert.match(payloadHtml, /data\.carrierMatters/);
  assert.match(payloadHtml, /if \(!matters\) \$\('#node-input-carrier'\)\.val\('int'\);/);
});



