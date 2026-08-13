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

test('camera stop-photo builds IMAGE_STOP_CAPTURE with command-ack confirmation (#259)', () => {
  // Photo exposes `count` and an explicit 0 starts a continuous capture the
  // node could otherwise never stop — this verb is the off switch.
  const built = buildPayloadMessage({
    carrier: 'long',
    topic: 'camera',
    verb: 'stop-photo',
    target: { sysid: 2, compid: 100 },
    values: { cameraId: 4 },
  });

  assert.equal(built.confirmation, 'command_ack');
  assert.equal(built.message.name, 'COMMAND_LONG');
  assert.equal(built.message.fields.command, 2001);
  assert.equal(built.message.fields.param1, 4);
  // Params 2-7 are reserved in the dialect — the recipe exposes camera id only.
  for (const slot of ['param2', 'param3', 'param4', 'param5', 'param6', 'param7']) {
    assert.equal(built.message.fields[slot], 0, `${slot} stays reserved-zero`);
  }

  // Camera id defaults to 0 (all cameras).
  const blank = buildPayloadMessage({
    carrier: 'long',
    topic: 'camera',
    verb: 'stop-photo',
    target: { sysid: 1, compid: 1 },
    values: {},
  });
  assert.equal(blank.message.fields.param1, 0);
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

test('gimbal manager angle aim NaN-s the rate pair when the fields are omitted entirely', () => {
  // Blank strings exercise one default path; a values object with no rate keys
  // at all exercises the recipe's missing-field default. Both must resolve to
  // NaN, never a literal 0 rate (issue #87).
  const built = buildPayloadMessage({
    topic: 'gimbal',
    verb: 'aim',
    path: 'manager',
    target: { sysid: 2, compid: 154 },
    values: { pitch: -45, yaw: 90 },
  });
  const f = built.message.fields;
  assert.ok(Number.isNaN(f.pitch_rate), 'omitted pitch rate must default to NaN');
  assert.ok(Number.isNaN(f.yaw_rate), 'omitted yaw rate must default to NaN');
});

test('gimbal manager-cmd aim builds DO_GIMBAL_MANAGER_PITCHYAW with command-ack confirmation (#257)', () => {
  // The command form acks where the message form cannot — same inputs as the
  // manager message path, confirmation instead of fire-and-forget.
  const long = buildPayloadMessage({
    carrier: 'long',
    topic: 'gimbal',
    verb: 'aim',
    path: 'manager-cmd',
    target: { sysid: 2, compid: 154 },
    values: { pitch: -15, yaw: 90, pitchRate: 2, yawRate: 3, flags: 16, gimbalDeviceId: 1 },
  });

  assert.equal(long.confirmation, 'command_ack');
  assert.equal(long.message.name, 'COMMAND_LONG');
  assert.equal(long.message.fields.command, 1000);
  assert.equal(long.message.fields.param1, -15);
  assert.equal(long.message.fields.param2, 90);
  assert.equal(long.message.fields.param3, 2);
  assert.equal(long.message.fields.param4, 3);
  assert.equal(long.message.fields.param5, 16);
  assert.equal(long.message.fields.param7, 1);

  // Carrier-agnostic: the INT carrier builds the same command, and param5
  // (manager flags) is a raw number there — never scaled as a coordinate.
  const int = buildPayloadMessage({
    carrier: 'int',
    topic: 'gimbal',
    verb: 'aim',
    path: 'manager-cmd',
    target: { sysid: 2, compid: 154 },
    values: { pitch: -15, yaw: 90, pitchRate: 2, yawRate: 3, flags: 16, gimbalDeviceId: 1 },
  });
  assert.equal(int.confirmation, 'command_ack');
  assert.equal(int.message.name, 'COMMAND_INT');
  assert.equal(int.message.fields.command, 1000);
  assert.equal(int.message.fields.x, 16, 'flags carry what the operator entered under INT');
  assert.equal(int.message.fields.z, 1);
});

test('gimbal manager-cmd aim keeps the message path\'s NaN-rate convention (issue #87 parity)', () => {
  // The two manager paths take the same inputs: an angle aim with the rates
  // left blank (or omitted) must command NaN rates ("axis not rate
  // controlled"), never a literal zero rate.
  for (const values of [
    { pitch: -45, yaw: 90, pitchRate: '', yawRate: '' },
    { pitch: -45, yaw: 90 },
  ]) {
    const built = buildPayloadMessage({
      carrier: 'long',
      topic: 'gimbal',
      verb: 'aim',
      path: 'manager-cmd',
      target: { sysid: 2, compid: 154 },
      values,
    });
    const f = built.message.fields;
    assert.equal(f.param1, -45);
    assert.equal(f.param2, 90);
    assert.ok(Number.isNaN(f.param3), 'blank pitch rate must be NaN, not 0');
    assert.ok(Number.isNaN(f.param4), 'blank yaw rate must be NaN, not 0');
    assert.equal(f.param5, 0, 'flags default to 0');
    assert.equal(f.param7, 0, 'gimbal device id defaults to 0 (primary)');
  }
});

test('servo repeat and gripper verbs map to their MAV_CMD command values', () => {
  const servo = buildPayloadMessage({
    carrier: 'long',
    topic: 'servo',
    verb: 'repeat',
    target: { sysid: 1, compid: 1 },
    values: { servo: 9, pwm: 1700, count: 4, period: 750 },
  });
  const gripper = buildPayloadMessage({
    carrier: 'long',
    topic: 'gripper',
    verb: 'operate',
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
