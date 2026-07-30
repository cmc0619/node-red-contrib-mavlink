'use strict';

/**
 * Payload verb editor: topic-dependent <select> on mavlink-payload and
 * mavlink-swarm (DESIGN.md §6 / §9).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { PAYLOAD_VERBS } = require('../../lib/payload');

const payloadHtml = fs.readFileSync(
  path.join(__dirname, '..', '..', 'nodes', 'mavlink-payload.html'),
  'utf8'
);
const swarmHtml = fs.readFileSync(
  path.join(__dirname, '..', '..', 'nodes', 'mavlink-swarm.html'),
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
  assert.match(payloadHtml, /PAYLOAD_VERBS/, 'editor mirrors the payload verb catalog');
  assert.match(
    payloadHtml,
    /\$\('#node-input-topic'\)\.on\('change'/,
    'topic change refreshes verb options'
  );
  assert.match(payloadHtml, /function refreshVerbOptions/, 'verb options are rebuilt');
});

test('mavlink-swarm verb is a topic-dependent select', () => {
  assertVerbSelect(swarmHtml, 'mavlink-swarm');
  assert.match(swarmHtml, /PAYLOAD_VERBS/, 'editor mirrors the payload verb catalog');
  assert.match(
    swarmHtml,
    /\$\('#node-input-topic'\)\.on\('change'/,
    'topic change refreshes verb options'
  );
  assert.match(swarmHtml, /function refreshVerbOptions/, 'verb options are rebuilt');
});

test('editor catalog includes every lib/payload verb value', () => {
  for (const [topic, verbs] of Object.entries(PAYLOAD_VERBS)) {
    for (const { value } of verbs) {
      assert.match(payloadHtml, new RegExp(`value:\\s*'${value}'`), `payload editor missing ${topic}/${value}`);
      assert.match(swarmHtml, new RegExp(`value:\\s*'${value}'`), `swarm editor missing ${topic}/${value}`);
    }
  }
});

test('mavlink-payload release actionValue is an enum select by verb', () => {
  assert.match(
    payloadHtml,
    /<select id="node-input-actionValue"/,
    'release actionValue must be a select'
  );
  assert.match(payloadHtml, /GRIPPER_ACTIONS/, 'gripper release uses GRIPPER_ACTIONS');
  assert.match(payloadHtml, /WINCH_ACTIONS/, 'winch release uses WINCH_ACTIONS');
  assert.match(payloadHtml, /PARACHUTE_ACTION/, 'parachute release uses PARACHUTE_ACTION');
  assert.match(payloadHtml, /RED\.mavlink\.fillEnumSelect/, 'release options use shared select helper');
  assert.match(payloadHtml, /row-payload-action/, 'action row is toggled for release topics');
});

test('mavlink-payload exposes camera and gimbal mode enum controls', () => {
  assert.match(
    payloadHtml,
    /<select id="node-input-modeValue"/,
    'modeValue must be a select so camera/gimbal set-mode is not hidden numeric state'
  );
  assert.match(payloadHtml, /CAMERA_MODE/, 'camera set-mode uses CAMERA_MODE');
  assert.match(payloadHtml, /MAV_MOUNT_MODE/, 'gimbal set-mode uses MAV_MOUNT_MODE');
  assert.match(payloadHtml, /row-payload-mode/, 'mode row is shown only for set-mode verbs');
});

test('mavlink-payload shows one labeled field row per parameter (§6)', () => {
  assert.match(payloadHtml, /id="row-payload-count"/);
  assert.match(payloadHtml, /id="row-payload-interval"/);
  assert.match(payloadHtml, /id="row-payload-pitch"/);
  assert.match(payloadHtml, /id="row-payload-roll"/);
  assert.match(payloadHtml, /id="row-payload-yaw"/);
  assert.match(payloadHtml, /id="row-payload-servo"/);
  assert.match(payloadHtml, /id="row-payload-pwm"/);
  assert.match(payloadHtml, /function refreshVisibility/, 'topic/verb drive row visibility');
  assert.match(
    payloadHtml,
    /topic === 'gimbal' && verb === 'aim'/,
    'gimbal path is limited to aim'
  );
  assert.ok(
    !payloadHtml.includes('label for="node-input-count">Camera</label>'),
    'topic names must not label unrelated parameter rows'
  );
  assert.ok(
    !payloadHtml.includes('placeholder="count"'),
    'crammed dual-input rows with placeholders are gone'
  );
});

test('mavlink-payload has rows for camera video stream parameters (§B)', () => {
  assert.match(payloadHtml, /id="row-payload-streamId"/, 'streamId row for start/stop video');
  assert.match(payloadHtml, /id="row-payload-statusFrequency"/, 'statusFrequency row for start-video');
  assert.match(
    payloadHtml,
    /topic === 'camera' && \(verb === 'start-video' \|\| verb === 'stop-video'\)/,
    'streamId shown for both start-video and stop-video'
  );
  assert.match(
    payloadHtml,
    /topic === 'camera' && verb === 'start-video'/,
    'statusFrequency shown for start-video only'
  );
});

test('mavlink-payload has rows for camera photo cameraId and sequence (§B)', () => {
  assert.match(payloadHtml, /id="row-payload-cameraId"/, 'cameraId row for photo');
  assert.match(payloadHtml, /id="row-payload-sequence"/, 'sequence row for photo');
  assert.match(
    payloadHtml,
    /\(verb === 'photo' \|\| verb === 'set-mode'\)/,
    'cameraId shown for photo and set-mode'
  );
});

test('mavlink-payload has rows for camera trigger-distance shutter and trigger (§B)', () => {
  assert.match(payloadHtml, /id="row-payload-shutter"/, 'shutter row for trigger-distance');
  assert.match(payloadHtml, /id="row-payload-trigger"/, 'trigger row for trigger-distance');
  assert.match(
    payloadHtml,
    /topic === 'camera' && verb === 'trigger-distance'/,
    'shutter/trigger visibility gated on trigger-distance verb'
  );
});

test('mavlink-payload has rows for gimbal set-mode stabilize flags (§B)', () => {
  assert.match(payloadHtml, /id="row-payload-stabilizeRoll"/, 'stabilizeRoll row');
  assert.match(payloadHtml, /id="row-payload-stabilizePitch"/, 'stabilizePitch row');
  assert.match(payloadHtml, /id="row-payload-stabilizeYaw"/, 'stabilizeYaw row');
  assert.match(
    payloadHtml,
    /topic === 'gimbal' && verb === 'set-mode'/,
    'stabilize fields shown for gimbal set-mode'
  );
});

test('mavlink-payload has rows for gimbal roi-set lat/lon/alt (§B)', () => {
  assert.match(payloadHtml, /id="row-payload-lat"/, 'lat row for roi-set');
  assert.match(payloadHtml, /id="row-payload-lon"/, 'lon row for roi-set');
  assert.match(payloadHtml, /id="row-payload-alt"/, 'alt row for roi-set');
  assert.match(
    payloadHtml,
    /topic === 'gimbal' && verb === 'roi-set'/,
    'lat/lon/alt visibility gated on roi-set verb'
  );
});

test('mavlink-payload has rows for gimbal manager aim flags and gimbalDeviceId (§B)', () => {
  assert.match(payloadHtml, /id="row-payload-flags"/, 'flags row for manager aim');
  assert.match(payloadHtml, /id="row-payload-gimbalDeviceId"/, 'gimbalDeviceId row for manager aim');
  assert.match(payloadHtml, /isManager/, 'flags and gimbalDeviceId tied to manager path');
});

test('mavlink-payload does not leak action ids across release enum families', () => {
  assert.match(payloadHtml, /function savedForEnum/, 'enum family switches reset saved values');
  assert.match(
    payloadHtml,
    /Enum family changed/,
    'gripper → parachute must not keep the old numeric action id'
  );
});

test('mavlink-payload target sysid/compid default to empty (inherit profile) not 1', () => {
  assert.match(payloadHtml, /targetSystem:\s*\{\s*value:\s*''/, 'sysid default is empty string');
  assert.match(payloadHtml, /targetComponent:\s*\{\s*value:\s*''/, 'compid default is empty string');
  assert.match(payloadHtml, /placeholder="[^"]*profile default[^"]*"/, 'sysid has profile default placeholder');
  assert.match(payloadHtml, /emptyLabel:\s*'[^']*profile default[^']*'/, 'compid empty label names profile default');
});

test('mavlink-payload fractional params use step=any', () => {
  for (const id of [
    'node-input-interval',
    'node-input-distance',
    'node-input-pitch',
    'node-input-roll',
    'node-input-yaw',
    'node-input-pitchRate',
    'node-input-yawRate',
    'node-input-period',
    'node-input-length',
    'node-input-rate',
  ]) {
    assert.match(
      payloadHtml,
      new RegExp(`id="${id}"[^>]*step="any"|step="any"[^>]*id="${id}"`),
      `${id} must accept fractional values`
    );
  }
});

test('mavlink-payload has vehicle and identity defaults for role × tier matrix (§6)', () => {
  assert.match(payloadHtml, /vehicle:\s*\{\s*value:\s*''/, 'vehicle default is empty string');
  assert.match(payloadHtml, /type:\s*'mavlink-vehicle'/, 'vehicle is a config node type');
  assert.match(payloadHtml, /identity:\s*\{\s*value:\s*''/, 'identity default is empty string');
  assert.match(payloadHtml, /fillIdentitySelect/, 'fillIdentitySelect fills the identity dropdown');
  assert.match(payloadHtml, /id="row-payload-vehicle"/, 'vehicle row has ID for tier-driven toggling');
  assert.match(payloadHtml, /id="row-payload-identity"/, 'identity row has ID for tier-driven toggling');
  assert.match(payloadHtml, /id="row-payload-connection"/, 'connection row has ID for tier-driven toggling');
  assert.match(payloadHtml, /ensureConfigNodePicker[^)]*'vehicle'/, 'vehicle uses config node picker');
});

test('mavlink-payload companion hides sysid row but NOT compid row (§6 spec exception)', () => {
  assert.match(payloadHtml, /isCompanion/, 'companion flag drives visibility');
  assert.match(payloadHtml, /id="row-payload-targetSystem"/, 'targetSystem row has ID');
  assert.match(payloadHtml, /id="row-payload-targetComponent"/, 'targetComponent row has ID');
  // sysid is gated by companion
  assert.match(
    payloadHtml,
    /targetSystem:\s*isBuild\s*\|\|\s*!isCompanion/,
    'sysid gated by companion for payload'
  );
  // compid is NOT gated by companion (spec exception: payload device address stays visible)
  assert.match(
    payloadHtml,
    /targetComponent:\s*true/,
    'compid always visible for payload (payload device address exception)'
  );
  assert.ok(
    !payloadHtml.includes('targetComponent: isBuild || !isCompanion'),
    'payload compid row must NOT be gated the same as move (no isCompanion suppression)'
  );
});

test('mavlink-payload build tier shows vehicle, hides connection/identity/timeout/retry (§6)', () => {
  assert.match(payloadHtml, /dialect:\s*isBuild/, 'dialect row shown only for build tier');
  assert.match(payloadHtml, /vehicle:\s*isBuild\s*&&\s*dialectVal === '__vehicle'/, 'vehicle row shown only for Build Vehicle Profile escape');
  assert.match(payloadHtml, /connection:\s*isWire/, 'connection row shown only for wire tiers');
  assert.match(payloadHtml, /identity:\s*isWire/, 'identity row shown only for wire tiers');
  assert.match(payloadHtml, /timeout:\s*isWire/, 'timeout row shown only for wire tiers');
  assert.match(payloadHtml, /maxRetries:\s*isWire/, 'maxRetries row shown only for wire tiers');
  assert.match(payloadHtml, /id="row-payload-dialect"/, 'dialect row has ID for toggling');
  assert.match(payloadHtml, /id="row-payload-timeout"/, 'timeout row has ID for toggling');
  assert.match(payloadHtml, /id="row-payload-maxRetries"/, 'maxRetries row has ID for toggling');
});

test('mavlink-payload Build dialect picker keeps empty invalid and offers Vehicle Profile escape', () => {
  assert.match(
    payloadHtml,
    /dialect:\s*\{\s*value:\s*''/,
    'Build dialect default must be empty'
  );
  assert.match(
    payloadHtml,
    /if \(delivery === ['"]build['"]\) return !!v/,
    'Build delivery must require a dialect selection'
  );
  assert.match(payloadHtml, /RED\.mavlink\.populateDialectSelect\(/, 'dialect select must use shared helper');
  assert.match(payloadHtml, /includeVehicleEscape:\s*true/, 'dialect select must include Vehicle Profile escape');
  assert.match(payloadHtml, /__vehicle/, 'Vehicle Profile escape value must be present');
  assert.match(payloadHtml, /from Vehicle Profile/, 'Vehicle Profile escape label must be present');
});

test('mavlink-payload Build catalog calls do not invent a dialect while dialect is empty', () => {
  assert.match(payloadHtml, /function hasCatalogTarget/, 'catalog target helper must exist');
  assert.match(
    payloadHtml,
    /if \(isBuildDelivery\(\) && !hasCatalogTarget\(query\)\)/,
    'Build with empty dialect must skip catalog calls'
  );
  const catalogBlock = payloadHtml.slice(
    payloadHtml.indexOf('function catalogQuery'),
    payloadHtml.indexOf('function loadPayloadEnums')
  );
  assert.doesNotMatch(catalogBlock, /ardupilotmega/, 'payload editor must not hardcode an invented dialect');
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
  assert.match(payloadHtml, /fillIdentitySelect[^)]*\$\('#node-input-identity'\)/, 'identity refilled on connection change');
});
