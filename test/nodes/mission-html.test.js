'use strict';

/**
 * Mission editor: role × tier visibility and catalog derivation (DESIGN.md §6).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { assertChangeHandlerContains, loadNodeDefaults } = require('./html-assert');

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

test('mavlink-mission calls refreshIdentitySelect on connection change', () => {
  assert.match(html, /RED\.mavlink\.refreshIdentitySelect\(node\)/, 'shared refreshIdentitySelect is called');
  assert.match(html, /node-input-identity/, 'identity select element exists');
  assert.doesNotMatch(html, /function refreshIdentitySelect/, 'no local identity-refresh copy');
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
});

test('mavlink-mission Build dialect select uses shared helper with Vehicle Profile escape', () => {
  assert.match(html, /id="row-mission-dialect"/, 'template must have a dialect row');
  assert.match(html, /id="node-input-dialect"/, 'template must have a dialect select');
  assert.match(html, /RED\.mavlink\.populateDialectSelect\(/, 'dialect select must use shared helper');
  // The __vehicle escape gating of profile firmware lives in the shared
  // resolver (resolveCatalogTarget — mavlink-editor-resource.test.js).
  assert.match(html, /RED\.mavlink\.resolveCatalogTarget\(\)\.firmware/, 'firmware derives from the shared resolver');
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
  // The type list repopulates from the shared resolver's firmware, which reads
  // the Build Firmware select on a concrete dialect, the Build Vehicle Profile
  // escape's profile, or the wire Connection's bound profile — tier awareness,
  // the __vehicle escape, frozen `vehicle` snapshots, and the
  // no-invented-firmware rule are all proven executed against
  // resolveCatalogTarget in mavlink-editor-resource.test.js.
  assert.match(html, /function repopulateTypes/, 'repopulateTypes function present');
  assert.match(
    html,
    /=\s*RED\.mavlink\.resolveCatalogTarget\(\)\.firmware/,
    'repopulateTypes reads the shared resolver'
  );
});

test('mavlink-mission has no hand-rolled firmware resolver (14.32)', () => {
  // getEffectiveFirmware used to re-implement the delivery→dialect/vehicle→
  // connection walk — and read `conn.vehicle` raw, missing the frozen-snapshot
  // shape vehicleIdFrom tolerates. The walk lives once, in the shared file.
  assert.doesNotMatch(html, /function getEffectiveFirmware/, 'no local resolver copy');
  assert.doesNotMatch(html, /conn\.vehicle/, 'no raw connection-vehicle read');
  assert.doesNotMatch(html, /return\s+['"]ardupilot['"]/,
    'firmware must not be invented when no source is selected');
});

test('mavlink-mission target sysid/compid default to empty (inherit profile)', () => {
  assert.match(html, /targetSystem:\s*\{\s*value:\s*''/, 'sysid default is empty string');
  assert.match(html, /targetComponent:\s*\{\s*value:\s*''/, 'compid default is empty string');
  assert.match(html, /placeholder="[^"]*profile default[^"]*"/, 'sysid has profile default placeholder');
  assert.match(html, /RED\.mavlink\.reloadTargetCompId\(node\)/, 'compid uses shared reloadTargetCompId');
});

test('mavlink-mission items validator rejects a configured empty array (#241)', () => {
  // A configured [] would upload MISSION_COUNT 0 — the wire's "erase the
  // plan" — so the editor rejects it statically; blank stays valid (items may
  // come from the payload, whose empty case the runtime refuses).
  const itemsValidator = /items:\s*\{[\s\S]*?validate:\s*function[\s\S]*?\n {6}\},/.exec(html);
  assert.ok(itemsValidator, 'items validate function must be extractable');
  assert.match(itemsValidator[0], /isBlank\(v\)\)\s*return true/, 'blank stays valid');
  assert.match(itemsValidator[0], /length === 0/, 'empty array is checked');
  assert.match(itemsValidator[0], /must not be empty[^']*Clear/, 'refusal names the Clear operation');
  // The placeholder must not advertise the one value the validator rejects.
  // Items is a multi-line textarea (a mission is a list, not a line).
  const itemsInput = /<textarea[^>]*id="node-input-items"[^>]*>/.exec(html);
  assert.ok(itemsInput, 'items textarea must be extractable');
  assert.doesNotMatch(itemsInput[0], /placeholder="\[\]/, 'placeholder no longer offers []');
  assert.match(itemsInput[0], /placeholder="non-empty JSON array, or set msg\.payload\.items"/,
    'placeholder asks for a non-empty array or the payload');
});

test('mavlink-mission items validator reds per-item: uint16 command and family reservation', () => {
  // The editor is the only protector: configured items red at deploy.
  // Payload-supplied items ride.
  const { items } = loadNodeDefaults('mavlink-mission');
  const verdict = (over, arr) => items.validate.call(
    Object.assign({ id: 'm1', operation: 'upload', missionType: 'mission' }, over),
    JSON.stringify(arr), {}
  );

  assert.equal(items.validate.length, 2, 'a reason-returning validator declares (v, opt) — §14');

  // Structural: the wire command field is uint16 — 5001.9 would truncate onto
  // the reserved fence id 5001, and a non-object item has no command at all.
  assert.match(String(verdict({}, [{ command: 5001.9 }])), /integer command id/);
  assert.match(String(verdict({}, [{ command: -1 }])), /integer command id/);
  assert.match(String(verdict({}, [{ command: 65536 }])), /integer command id/);
  assert.match(String(verdict({}, [null])), /integer command id/);
  assert.match(String(verdict({}, [16])), /integer command id/);
  // Blank/absent commands must not coerce to a legal 0 and upload command 0
  // (Codex); an explicit numeric 0 and a numeric string stay legal.
  assert.match(String(verdict({}, [{ command: '' }])), /integer command id/);
  assert.match(String(verdict({}, [{ command: null }])), /integer command id/);
  assert.match(String(verdict({}, [{ command: false }])), /integer command id/);
  assert.match(String(verdict({}, [{}])), /integer command id/);
  assert.equal(verdict({}, [{ command: 0 }]), true, 'an explicit numeric 0 rides');
  assert.equal(verdict({}, [{ command: '16' }]), true, 'a numeric string names its command');

  // Family reservation (§9, issue #90): a mission may carry any command except
  // the fence and rally families; fence and rally are their families only.
  assert.equal(verdict({}, [{ command: 16 }, { command: 530 }, { command: 2000 }]), true,
    'mission items are not allowlisted — 530/2000 upload as mission items (#90)');
  assert.match(String(verdict({}, [{ command: 5001 }])), /not a valid mission item/);
  assert.match(String(verdict({}, [{ command: 5100 }])), /not a valid mission item/);
  assert.equal(verdict({ missionType: 'fence' }, [{ command: 5001 }]), true);
  assert.match(String(verdict({ missionType: 'fence' }, [{ command: 16 }])), /not a valid fence item/);
  assert.equal(verdict({ missionType: 'rally' }, [{ command: 5100 }]), true);
  assert.match(String(verdict({ missionType: 'rally' }, [{ command: 5001 }])), /not a valid rally item/);

  // The gates around the per-item walk are unchanged.
  assert.equal(verdict({ operation: 'download' }, [{ command: 5001 }]), true,
    'only Upload reads items');
  assert.equal(items.validate.call({ id: 'm1', operation: 'upload' }, '', {}), true,
    'blank means items come from the payload');
});

test('mavlink-mission editor family tables name the dialect fence and rally ids', () => {
  const fence = /var MISSION_FENCE_COMMANDS = \[([^\]]*)\];/.exec(html);
  assert.ok(fence, 'MISSION_FENCE_COMMANDS must be extractable');
  const fromEditor = fence[1].split(',').map((s) => Number(s.trim()));
  assert.deepEqual(fromEditor, [5000, 5001, 5002, 5003, 5004, 5005]);
  const rally = /var MISSION_RALLY_COMMAND = (\d+);/.exec(html);
  assert.ok(rally, 'MISSION_RALLY_COMMAND must be extractable');
  assert.equal(Number(rally[1]), 5100);
});

test('mavlink-mission target sysid: a configured broadcast reds for download/upload, not clear', () => {
  // Download and upload refuse sysid 0 on every tier (§9 — no vehicle answers
  // as the broadcast id), so a statically configured pair is a deploy-time
  // verdict, the #260 shape. Clear stays a broadcast-legal single message.
  const { targetSystem, targetComponent } = loadNodeDefaults('mavlink-mission');
  const verdict = (op, v) => targetSystem.validate.call({ id: 'm1', operation: op }, v, {});

  assert.equal(targetSystem.validate.length, 2, 'a reason-returning validator declares (v, opt) — §14');
  assert.match(String(verdict('download', '0')), /broadcast \(0\) cannot download/);
  assert.match(String(verdict('upload', '0')), /broadcast \(0\) cannot upload/);
  assert.equal(verdict('clear', '0'), true, 'clear fans out legitimately (§10)');
  assert.equal(verdict('download', ''), true, 'blank inherits the profile default');
  assert.equal(verdict('download', '7'), true);
  assert.match(String(verdict('download', '300')), /between 0 and 255/, 'uint8 range still applies');

  // Compid is a wire uint8 with a blank inherit.
  assert.equal(targetComponent.validate.call({ id: 'm1' }, '', {}), true);
  assert.equal(targetComponent.validate.call({ id: 'm1' }, '190', {}), true);
  assert.match(String(targetComponent.validate.call({ id: 'm1' }, '300', {})), /between 0 and 255/);
});

test('mavlink-mission has no clear-confirmation control (owner ruling, 2026-08-13)', () => {
  // Selecting the Clear operation IS the confirmation. The checkbox and the
  // msg.confirmed escape were removed together — a control resurrected here
  // would silently re-gate a documented behavior.
  assert.ok(!html.includes('confirmClear'), 'confirmClear is gone from the editor');
  assert.ok(!/msg\.confirmed/.test(html), 'help no longer documents msg.confirmed');
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
