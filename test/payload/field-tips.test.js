'use strict';

/**
 * Payload editor field tips join structural bindings to dialect descriptions
 * (DESIGN.md §6 — no baked protocol copy).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadBundled } = require('../../lib/metadata');
const {
  editorFieldBindings,
  fieldTipsFromBundle,
  MAV_CMD,
} = require('../../lib/payload');

test('editorFieldBindings covers camera photo Sequence → IMAGE_START_CAPTURE param4', () => {
  const bindings = editorFieldBindings();
  const photo = bindings['camera|photo|'];
  assert.ok(photo);
  assert.equal(photo.kind, 'command');
  assert.equal(photo.command, MAV_CMD.IMAGE_START_CAPTURE);
  assert.equal(photo.fields.sequence, 4);
});

test('fieldTipsFromBundle sources Sequence tip from dialect, not a baked string', () => {
  const bundle = loadBundled('ardupilotmega');
  const tips = fieldTipsFromBundle(bundle, 'camera', 'photo', '');
  assert.ok(tips.sequence, 'sequence must have a dialect description');
  assert.match(tips.sequence, /sequence/i);
  assert.ok(tips.cameraId);
  assert.ok(tips.interval);
  assert.ok(tips.count);
});

test('fieldTipsFromBundle joins gimbal manager message field descriptions', () => {
  const bundle = loadBundled('ardupilotmega');
  const tips = fieldTipsFromBundle(bundle, 'gimbal', 'aim', 'manager');
  // At least one manager field should carry XML description text.
  const any = Object.values(tips).some((t) => typeof t === 'string' && t.length > 0);
  assert.ok(any, `expected at least one tip, got ${JSON.stringify(tips)}`);
});

test('fieldTipsFromBundle returns empty object for unknown verb', () => {
  const bundle = loadBundled('ardupilotmega');
  assert.deepEqual(fieldTipsFromBundle(bundle, 'camera', 'nope', ''), {});
});
