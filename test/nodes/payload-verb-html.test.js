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

test('mavlink-payload does not leak action ids across release enum families', () => {
  assert.match(payloadHtml, /function savedForEnum/, 'enum family switches reset saved values');
  assert.match(
    payloadHtml,
    /Enum family changed/,
    'gripper → parachute must not keep the old numeric action id'
  );
});
