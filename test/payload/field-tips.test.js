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
  carrierMattersFor,
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

test('buildPayloadMessage rejects an unknown verb', () => {
  assert.throws(
    () => buildPayloadMessage({
    carrier: 'long',
      topic: 'camera',
      verb: 'nope',
      target: { sysid: 1, compid: 1 },
      values: {},
    }),
    /unknown payload verb/
  );
});

test('buildPayloadMessage unknown-verb error includes path when present', () => {
  assert.throws(
    () => buildPayloadMessage({
    carrier: 'long',
      topic: 'gimbal',
      verb: 'aim',
      path: 'not-a-real-path',
      target: { sysid: 1, compid: 1 },
      values: {},
    }),
    /gimbal\/aim\/not-a-real-path/
  );
});

test('recipeFor gimbal aim defaults to the legacy path', () => {
  assert.deepEqual(recipeFor('gimbal', 'aim'), recipeFor('gimbal', 'aim', 'legacy'));
});

test('fieldTipsFromBundle omits Empty / Reserved param descriptions', () => {
  const recipe = recipeFor('camera', 'photo', '');
  assert.ok(recipe && recipe.command);
  const params = recipe.params.map((slot, i) => {
    const index = i + 1;
    if (!slot) return { index, description: 'Empty', reserved: true };
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
    carrier: 'long',
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

/**
 * The recipe key set IS the set of rows the Payload dialog renders, so this
 * freezes it against the hand-written `show` map it replaced. A change here is
 * a visible change to the form, never an accident.
 */
test('every recipe derives exactly the fields the dialog shows', () => {
  const bundle = loadBundled('ardupilotmega');
  const expected = {
    'camera|photo|': ['cameraId', 'count', 'interval', 'sequence'],
    'camera|start-video|': ['statusFrequency', 'streamId'],
    'camera|stop-video|': ['streamId'],
    'camera|set-mode|': ['cameraId', 'mode'],
    'camera|trigger-distance|': ['distance', 'shutter', 'trigger'],
    // Legacy aim shows no Mode: param7 is pinned to MAVLINK_TARGETING (2),
    // the only mount mode in which pitch/roll/yaw are obeyed.
    'gimbal|aim|legacy': ['pitch', 'roll', 'yaw'],
    // Manager aim has no roll — GIMBAL_MANAGER_SET_PITCHYAW carries none.
    'gimbal|aim|manager': ['flags', 'gimbalDeviceId', 'pitch', 'pitchRate', 'yaw', 'yawRate'],
    'gimbal|set-mode|': ['mode', 'stabilizePitch', 'stabilizeRoll', 'stabilizeYaw'],
    'gimbal|roi-set|': ['alt', 'lat', 'lon'],
    'gimbal|roi-clear|': [],
    'servo|set|': ['pwm', 'servo'],
    'servo|repeat|': ['count', 'period', 'pwm', 'servo'],
    'release|gripper|': ['action', 'instance'],
    'release|winch|': ['action', 'instance', 'length', 'rate'],
    'release|parachute|': ['action'],
  };
  for (const [key, fields] of Object.entries(expected)) {
    const [topic, verb, path] = key.split('|');
    const got = Object.keys(fieldMetaFromBundle(bundle, topic, verb, path)).sort();
    assert.deepEqual(got, fields, `field set for ${key}`);
  }
});

test('a pinned slot is filled by the recipe and never offered as a control', () => {
  const bundle = loadBundled('ardupilotmega');
  const aim = recipeFor('gimbal', 'aim', 'legacy');
  const mountMode = aim.params[6];
  assert.equal(mountMode.pinned, true);
  assert.equal(mountMode.default, 2, 'MAV_MOUNT_MODE_MAVLINK_TARGETING');
  assert.ok(!('mode' in fieldMetaFromBundle(bundle, 'gimbal', 'aim', 'legacy')));

  // Still sent on the wire — pinned means "not the operator's", not "absent".
  const built = buildPayloadMessage({
    topic: 'gimbal', verb: 'aim', path: 'legacy', carrier: 'long',
    target: { sysid: 1, compid: 1 }, values: { pitch: 10 },
  });
  assert.equal(built.message.fields.param7, 2);
});

test('the carrier is only a real choice where the command carries a location', () => {
  const bundle = loadBundled('ardupilotmega');
  assert.equal(carrierMattersFor(bundle, 'gimbal', 'roi-set', ''), true);
  for (const [topic, verb, path] of [
    ['camera', 'photo', ''], ['camera', 'set-mode', ''], ['gimbal', 'aim', 'legacy'],
    ['gimbal', 'aim', 'manager'], ['servo', 'set', ''], ['release', 'winch', ''],
  ]) {
    assert.equal(carrierMattersFor(bundle, topic, verb, path), false, `${topic}/${verb}/${path}`);
  }
});
