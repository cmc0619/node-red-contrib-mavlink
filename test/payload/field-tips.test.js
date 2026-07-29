'use strict';

/**
 * Payload editor field tips join shared recipes to dialect descriptions
 * (DESIGN.md §6 — no baked protocol copy).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadBundled } = require('../../lib/metadata');
const {
  recipeFor,
  descriptionForCommandParam,
  fieldTipsFromBundle,
  fieldMetaFromBundle,
  buildPayloadMessage,
  MAV_CMD,
} = require('../../lib/payload');

test('recipeFor camera photo maps Sequence to IMAGE_START_CAPTURE param4', () => {
  const recipe = recipeFor('camera', 'photo', '');
  assert.ok(recipe);
  assert.equal(recipe.kind, 'command');
  assert.equal(recipe.command, MAV_CMD.IMAGE_START_CAPTURE);
  assert.equal(recipe.params[3].field, 'sequence');
});

test('descriptionForCommandParam reads dialect text for IMAGE_START_CAPTURE param4', () => {
  const bundle = loadBundled('ardupilotmega');
  const text = descriptionForCommandParam(bundle, MAV_CMD.IMAGE_START_CAPTURE, 4);
  assert.match(text, /sequence/i);
});

test('fieldTipsFromBundle sources Sequence tip from dialect via the shared recipe', () => {
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
  const any = Object.values(tips).some((t) => typeof t === 'string' && t.length > 0);
  assert.ok(any, `expected at least one tip, got ${JSON.stringify(tips)}`);
});

test('fieldTipsFromBundle returns empty object for unknown verb', () => {
  const bundle = loadBundled('ardupilotmega');
  assert.deepEqual(fieldTipsFromBundle(bundle, 'camera', 'nope', ''), {});
});

test('fieldTipsFromBundle omits Empty / Reserved param descriptions', () => {
  const recipe = recipeFor('camera', 'photo', '');
  assert.ok(recipe && recipe.command);
  const params = recipe.params.map((slot, i) => {
    const index = i + 1;
    if (slot.field === 'sequence') {
      return { index, description: 'Capture sequence number', reserved: false };
    }
    if (slot.field === 'cameraId') {
      return { index, description: 'Empty', reserved: false };
    }
    if (slot.field === 'count') {
      return { index, description: 'Empty.', reserved: false };
    }
    if (slot.field === 'interval') {
      return { index, description: 'Reserved', reserved: false };
    }
    return { index, description: 'keep', reserved: false };
  });
  const bundle = {
    commands: {
      IMAGE_START_CAPTURE: { value: recipe.command, params },
    },
  };
  const tips = fieldTipsFromBundle(bundle, 'camera', 'photo', '');
  assert.equal(tips.sequence, 'Capture sequence number');
  assert.equal(tips.cameraId, undefined);
  assert.equal(tips.count, undefined);
  assert.equal(tips.interval, undefined);
});

test('buildPayloadMessage and field tips share the photo recipe param order', () => {
  const built = buildPayloadMessage({
    topic: 'camera',
    verb: 'photo',
    target: { sysid: 1, compid: 1 },
    values: { cameraId: 4, interval: 1.5, count: 3, sequence: 7 },
  });
  assert.equal(built.message.fields.param1, 4);
  assert.equal(built.message.fields.param2, 1.5);
  assert.equal(built.message.fields.param3, 3);
  assert.equal(built.message.fields.param4, 7);
  const recipe = recipeFor('camera', 'photo', '');
  assert.deepEqual(
    recipe.params.map((s) => s.field),
    ['cameraId', 'interval', 'count', 'sequence']
  );
});

test('fieldMetaFromBundle surfaces dialect units for Interval (not baked HTML)', () => {
  const bundle = loadBundled('ardupilotmega');
  const meta = fieldMetaFromBundle(bundle, 'camera', 'photo', '');
  assert.ok(meta.interval);
  assert.equal(meta.interval.units, 's');
  assert.match(meta.interval.description, /elapsed time|seconds/i);
});
