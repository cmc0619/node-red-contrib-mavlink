'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildPayloadMessage } = require('../../lib/payload');

test('camera photo builds a command-backed IMAGE_START_CAPTURE payload action', () => {
  const built = buildPayloadMessage({
    carrier: 'long',
    topic: 'camera',
    verb: 'photo',
    target: { sysid: 2, compid: 100 },
    values: { cameraId: 4, count: 3, interval: 1.5, sequence: 7 },
  });

  assert.equal(built.confirmation, 'command_ack');
  assert.equal(built.message.name, 'COMMAND_LONG');
  assert.equal(built.message.fields.command, 2000);
  assert.equal(built.message.fields.target_system, 2);
  assert.equal(built.message.fields.target_component, 100);
  // MAV_CMD_IMAGE_START_CAPTURE: p1=camera id, p2=interval, p3=count, p4=sequence.
  assert.equal(built.message.fields.param1, 4);
  assert.equal(built.message.fields.param2, 1.5);
  assert.equal(built.message.fields.param3, 3);
  assert.equal(built.message.fields.param4, 7);
});

test('camera photo defaults camera id and sequence to 0 and count to 1', () => {
  const built = buildPayloadMessage({
    carrier: 'long',
    topic: 'camera',
    verb: 'photo',
    target: { sysid: 1, compid: 1 },
    values: { interval: 2 },
  });
  assert.equal(built.message.fields.param1, 0);
  assert.equal(built.message.fields.param2, 2);
  assert.equal(built.message.fields.param3, 1);
  assert.equal(built.message.fields.param4, 0);
});

test('gimbal manager aim uses the message path and declares no confirmation', () => {
  const built = buildPayloadMessage({
    carrier: 'long',
    topic: 'gimbal',
    verb: 'aim',
    path: 'manager',
    target: { sysid: 2, compid: 154 },
    values: { pitch: -15, yaw: 90, pitchRate: 2, yawRate: 3 },
  });

  assert.equal(built.confirmation, 'none');
  assert.deepEqual(built.message, {
    name: 'GIMBAL_MANAGER_SET_PITCHYAW',
    fields: {
      target_system: 2,
      target_component: 154,
      flags: 0,
      gimbal_device_id: 0,
      pitch: -15,
      yaw: 90,
      pitch_rate: 2,
      yaw_rate: 3,
    },
  });
});

test('gimbal manager angle aim NaN-s the unused rate pair, not zero-rate (issue #87)', () => {
  // An angle aim with the rate fields left blank must send pitch_rate / yaw_rate
  // as NaN ("axis not rate-controlled"), not 0 — a literal zero rate alongside a
  // pitch/yaw angle is the ambiguous both-modes command some firmwares drop.
  const built = buildPayloadMessage({
    topic: 'gimbal',
    verb: 'aim',
    path: 'manager',
    target: { sysid: 2, compid: 154 },
    values: { pitch: -45, yaw: 90, pitchRate: '', yawRate: '' },
  });
  const f = built.message.fields;
  assert.equal(f.pitch, -45);
  assert.equal(f.yaw, 90);
  assert.ok(Number.isNaN(f.pitch_rate), 'blank pitch rate must be NaN, not 0');
  assert.ok(Number.isNaN(f.yaw_rate), 'blank yaw rate must be NaN, not 0');
});

test('servo repeat and release verbs map to their MAV_CMD command values', () => {
  const servo = buildPayloadMessage({
    carrier: 'long',
    topic: 'servo',
    verb: 'repeat',
    target: { sysid: 1, compid: 1 },
    values: { servo: 9, pwm: 1700, count: 4, period: 750 },
  });
  const gripper = buildPayloadMessage({
    carrier: 'long',
    topic: 'release',
    verb: 'gripper',
    target: { sysid: 1, compid: 1 },
    values: { instance: 2, action: 1 },
  });

  assert.equal(servo.message.fields.command, 184);
  assert.equal(servo.message.fields.param1, 9);
  assert.equal(servo.message.fields.param3, 4);
  assert.equal(gripper.message.fields.command, 211);
  assert.equal(gripper.message.fields.param1, 2);
  assert.equal(gripper.message.fields.param2, 1);
});

test('gimbal roi-set with carrier int builds COMMAND_INT with degE7 lat/lon (§9)', () => {
  const built = buildPayloadMessage({
    carrier: 'int',
    frame: 3,
    topic: 'gimbal',
    verb: 'roi-set',
    target: { sysid: 1, compid: 154 },
    // Whole-degree coordinates — canonical degrees, scaled by the shared INT
    // builder, never passed through.
    values: { lat: -35, lon: 149, alt: 50 },
  });

  assert.equal(built.confirmation, 'command_ack');
  assert.equal(built.message.name, 'COMMAND_INT');
  assert.equal(built.message.fields.command, 195); // DO_SET_ROI_LOCATION
  assert.equal(built.message.fields.frame, 3);
  assert.equal(built.message.fields.x, -350000000);
  assert.equal(built.message.fields.y, 1490000000);
  assert.equal(built.message.fields.z, 50);
  assert.equal('confirmation' in built.message.fields, false, 'COMMAND_INT has no confirmation byte');
});

test('a command-backed verb without a carrier throws — no default wire form (§9)', () => {
  assert.throws(
    () => buildPayloadMessage({
      topic: 'servo',
      verb: 'set',
      target: { sysid: 1, compid: 1 },
      values: { servo: 8, pwm: 1600 },
    }),
    /carrier 'int' or 'long'/
  );
});

test('message-kind verbs ignore the carrier entirely', () => {
  // Gimbal manager aiming is a plain message, not a MAV_CMD — it must build
  // with no carrier at all.
  const built = buildPayloadMessage({
    topic: 'gimbal',
    verb: 'aim',
    path: 'manager',
    target: { sysid: 1, compid: 154 },
    values: { pitch: -10, yaw: 45 },
  });
  assert.equal(built.confirmation, 'none');
  assert.equal(built.message.name, 'GIMBAL_MANAGER_SET_PITCHYAW');
});
