'use strict';

const MAV_CMD = {
  DO_SET_MODE: 176,
  DO_SET_SERVO: 183,
  DO_REPEAT_SERVO: 184,
  DO_SET_CAM_TRIGG_DIST: 206,
  DO_MOUNT_CONFIGURE: 204,
  DO_MOUNT_CONTROL: 205,
  DO_GRIPPER: 211,
  DO_PARACHUTE: 208,
  DO_SET_ROI_LOCATION: 195,
  DO_SET_ROI_NONE: 197,
  IMAGE_START_CAPTURE: 2000,
  VIDEO_START_CAPTURE: 2500,
  VIDEO_STOP_CAPTURE: 2501,
  SET_CAMERA_MODE: 530,
  DO_WINCH: 42600,
};

/**
 * Build one payload-control MAVLink message plus its confirmation mechanism.
 * Command-backed verbs confirm through COMMAND_ACK; gimbal-manager setpoint
 * messages have no acknowledgement and must not be presented as acked.
 *
 * @param {object} input
 * @returns {{message: object, confirmation: 'command_ack'|'none'}}
 */
function buildPayloadMessage(input) {
  const topic = input.topic;
  const verb = input.verb;
  const target = normalizeTarget(input.target);
  const values = input.values || {};

  if (topic === 'camera') return camera(verb, target, values);
  if (topic === 'gimbal') return gimbal(verb, input.path, target, values);
  if (topic === 'servo') return servo(verb, target, values);
  if (topic === 'release') return release(verb, target, values);
  throw new Error(`unknown payload topic ${JSON.stringify(topic)}`);
}

/**
 * @param {string} verb
 * @param {object} target
 * @param {object} values
 * @returns {object}
 */
function camera(verb, target, values) {
  if (verb === 'photo') {
    // MAV_CMD_IMAGE_START_CAPTURE (2000) param layout (verified against
    // mavlink-mappings common.d.ts): param1 = Target Camera ID, param2 =
    // Interval (s), param3 = Total Images (count), param4 = Sequence Number.
    return commandBacked(
      target,
      MAV_CMD.IMAGE_START_CAPTURE,
      [
        valueOr(values.cameraId, 0),
        valueOr(values.interval, 0),
        valueOr(values.count, 1),
        valueOr(values.sequence, 0),
      ]
    );
  }
  if (verb === 'start-video') {
    return commandBacked(target, MAV_CMD.VIDEO_START_CAPTURE, [
      valueOr(values.streamId, 0),
      valueOr(values.statusFrequency, 0),
    ]);
  }
  if (verb === 'stop-video') {
    return commandBacked(target, MAV_CMD.VIDEO_STOP_CAPTURE, [valueOr(values.streamId, 0)]);
  }
  if (verb === 'set-mode') {
    return commandBacked(target, MAV_CMD.SET_CAMERA_MODE, [
      valueOr(values.cameraId, 0),
      valueOr(values.mode, 0),
    ]);
  }
  if (verb === 'trigger-distance') {
    return commandBacked(target, MAV_CMD.DO_SET_CAM_TRIGG_DIST, [
      valueOr(values.distance, 0),
      valueOr(values.shutter, 0),
      valueOr(values.trigger, 1),
    ]);
  }
  throw new Error(`unknown camera payload verb ${JSON.stringify(verb)}`);
}

/**
 * @param {string} verb
 * @param {string} path
 * @param {object} target
 * @param {object} values
 * @returns {object}
 */
function gimbal(verb, path, target, values) {
  if (verb === 'aim' && path === 'manager') {
    return {
      confirmation: 'none',
      message: {
        name: 'GIMBAL_MANAGER_SET_PITCHYAW',
        fields: {
          target_system: target.sysid,
          target_component: target.compid,
          flags: valueOr(values.flags, 0),
          gimbal_device_id: valueOr(values.gimbalDeviceId, 0),
          pitch: valueOr(values.pitch, 0),
          yaw: valueOr(values.yaw, 0),
          pitch_rate: valueOr(values.pitchRate, 0),
          yaw_rate: valueOr(values.yawRate, 0),
        },
      },
    };
  }
  if (verb === 'aim') {
    return commandBacked(target, MAV_CMD.DO_MOUNT_CONTROL, [
      valueOr(values.pitch, 0),
      valueOr(values.roll, 0),
      valueOr(values.yaw, 0),
      0,
      0,
      0,
      valueOr(values.mode, 2),
    ]);
  }
  if (verb === 'set-mode') {
    return commandBacked(target, MAV_CMD.DO_MOUNT_CONFIGURE, [
      valueOr(values.mode, 0),
      valueOr(values.stabilizeRoll, 0),
      valueOr(values.stabilizePitch, 0),
      valueOr(values.stabilizeYaw, 0),
    ]);
  }
  if (verb === 'roi-set') {
    return commandBacked(target, MAV_CMD.DO_SET_ROI_LOCATION, [
      0,
      0,
      0,
      0,
      valueOr(values.lat, 0),
      valueOr(values.lon, 0),
      valueOr(values.alt, 0),
    ]);
  }
  if (verb === 'roi-clear') {
    return commandBacked(target, MAV_CMD.DO_SET_ROI_NONE);
  }
  throw new Error(`unknown gimbal payload verb ${JSON.stringify(verb)}`);
}

/**
 * @param {string} verb
 * @param {object} target
 * @param {object} values
 * @returns {object}
 */
function servo(verb, target, values) {
  if (verb === 'set') {
    return commandBacked(target, MAV_CMD.DO_SET_SERVO, [
      valueOr(values.servo, 0),
      valueOr(values.pwm, 0),
    ]);
  }
  if (verb === 'repeat') {
    return commandBacked(target, MAV_CMD.DO_REPEAT_SERVO, [
      valueOr(values.servo, 0),
      valueOr(values.pwm, 0),
      valueOr(values.count, 0),
      valueOr(values.period, 0),
    ]);
  }
  throw new Error(`unknown servo payload verb ${JSON.stringify(verb)}`);
}

/**
 * @param {string} verb
 * @param {object} target
 * @param {object} values
 * @returns {object}
 */
function release(verb, target, values) {
  if (verb === 'gripper') {
    return commandBacked(target, MAV_CMD.DO_GRIPPER, [
      valueOr(values.instance, 0),
      valueOr(values.action, 0),
    ]);
  }
  if (verb === 'winch') {
    return commandBacked(target, MAV_CMD.DO_WINCH, [
      valueOr(values.instance, 0),
      valueOr(values.action, 0),
      valueOr(values.length, 0),
      valueOr(values.rate, 0),
    ]);
  }
  if (verb === 'parachute') {
    return commandBacked(target, MAV_CMD.DO_PARACHUTE, [valueOr(values.action, 0)]);
  }
  throw new Error(`unknown release payload verb ${JSON.stringify(verb)}`);
}

/**
 * @param {object} target
 * @param {number} command
 * @param {number[]} [params]
 * @returns {{message: object, confirmation: 'command_ack'}}
 */
function commandBacked(target, command, params = []) {
  return {
    confirmation: 'command_ack',
    message: {
      name: 'COMMAND_LONG',
      fields: {
        target_system: target.sysid,
        target_component: target.compid,
        command,
        confirmation: 0,
        param1: valueOr(params[0], 0),
        param2: valueOr(params[1], 0),
        param3: valueOr(params[2], 0),
        param4: valueOr(params[3], 0),
        param5: valueOr(params[4], 0),
        param6: valueOr(params[5], 0),
        param7: valueOr(params[6], 0),
      },
    },
  };
}

/**
 * @param {{sysid?:number, compid?:number}} target
 * @returns {{sysid:number, compid:number}}
 */
function normalizeTarget(target) {
  return {
    sysid: target && target.sysid !== undefined ? Number(target.sysid) : 1,
    compid: target && target.compid !== undefined ? Number(target.compid) : 1,
  };
}

/**
 * @param {*} value
 * @param {number} fallback
 * @returns {number}
 */
function valueOr(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`expected a finite payload value, got ${JSON.stringify(value)}`);
  return n;
}

module.exports = { MAV_CMD, buildPayloadMessage };
