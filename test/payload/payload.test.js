'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildPayloadMessage } = require('../../lib/payload');

test('camera photo builds a command-backed IMAGE_START_CAPTURE payload action', () => {
  const built = buildPayloadMessage({
    topic: 'camera',
    verb: 'photo',
    target: { sysid: 2, compid: 100 },
    values: { count: 3, interval: 1.5 },
  });

  assert.equal(built.confirmation, 'command_ack');
  assert.equal(built.message.name, 'COMMAND_LONG');
  assert.equal(built.message.fields.command, 2000);
  assert.equal(built.message.fields.target_system, 2);
  assert.equal(built.message.fields.target_component, 100);
  assert.equal(built.message.fields.param2, 1.5);
  assert.equal(built.message.fields.param3, 3);
});

test('gimbal manager aim uses the message path and declares no confirmation', () => {
  const built = buildPayloadMessage({
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

test('servo repeat and release verbs map to their MAV_CMD command values', () => {
  const servo = buildPayloadMessage({
    topic: 'servo',
    verb: 'repeat',
    target: { sysid: 1, compid: 1 },
    values: { servo: 9, pwm: 1700, count: 4, period: 750 },
  });
  const gripper = buildPayloadMessage({
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
