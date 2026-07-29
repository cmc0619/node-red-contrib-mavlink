'use strict';

const { BAND } = require('../connection/bands');
const { normalizeTarget } = require('../addressing');

const MAV_FRAME = {
  LOCAL_NED: 1,
  GLOBAL_RELATIVE_ALT_INT: 6,
};

const MASK = {
  X: 1,
  Y: 2,
  Z: 4,
  VX: 8,
  VY: 16,
  VZ: 32,
  AX: 64,
  AY: 128,
  AZ: 256,
  YAW: 1024,
  YAW_RATE: 2048,
};

const IGNORE_ACCEL = MASK.AX + MASK.AY + MASK.AZ;

/**
 * Build a SET_POSITION_TARGET_* message for Move. UI/API values are operator
 * friendly: local altitude and vertical velocity are up-positive. MAVLink NED
 * is down-positive, so the sign flips here exactly once at encode time.
 *
 * @param {object} input
 * @returns {{name:string, fields: object}}
 */
function buildMoveMessage(input) {
  const target = normalizeTarget(input.target);
  const timeBootMs = numberOr(input.timeBootMs, 0);
  if (input.mode === 'global-position') {
    const p = input.position || {};
    return {
      name: 'SET_POSITION_TARGET_GLOBAL_INT',
      fields: {
        time_boot_ms: timeBootMs,
        target_system: target.sysid,
        target_component: target.compid,
        coordinate_frame: numberOr(input.coordinateFrame, MAV_FRAME.GLOBAL_RELATIVE_ALT_INT),
        type_mask: maskFor('position', input),
        lat_int: degreesToDegE7(p.lat),
        lon_int: degreesToDegE7(p.lon),
        alt: numberOr(p.alt, 0),
        vx: 0,
        vy: 0,
        vz: 0,
        afx: 0,
        afy: 0,
        afz: 0,
        yaw: valueOr(input.yaw, 0),
        yaw_rate: valueOr(input.yawRate, 0),
      },
    };
  }

  if (input.mode === 'local-velocity') {
    const v = input.velocity || {};
    return {
      name: 'SET_POSITION_TARGET_LOCAL_NED',
      fields: {
        time_boot_ms: timeBootMs,
        target_system: target.sysid,
        target_component: target.compid,
        coordinate_frame: numberOr(input.coordinateFrame, MAV_FRAME.LOCAL_NED),
        type_mask: maskFor('velocity', input),
        x: 0,
        y: 0,
        z: 0,
        vx: numberOr(v.north, 0),
        vy: numberOr(v.east, 0),
        vz: -numberOr(v.up, 0),
        afx: 0,
        afy: 0,
        afz: 0,
        yaw: valueOr(input.yaw, 0),
        yaw_rate: valueOr(input.yawRate, 0),
      },
    };
  }

  const p = input.position || {};
  return {
    name: 'SET_POSITION_TARGET_LOCAL_NED',
    fields: {
      time_boot_ms: timeBootMs,
      target_system: target.sysid,
      target_component: target.compid,
      coordinate_frame: numberOr(input.coordinateFrame, MAV_FRAME.LOCAL_NED),
      type_mask: maskFor('position', input),
      x: numberOr(p.north, 0),
      y: numberOr(p.east, 0),
      z: -numberOr(p.up, 0),
      vx: 0,
      vy: 0,
      vz: 0,
      afx: 0,
      afy: 0,
      afz: 0,
      yaw: valueOr(input.yaw, 0),
      yaw_rate: valueOr(input.yawRate, 0),
    },
  };
}

/**
 * @param {object} options
 * @returns {{start: Function, stop: Function, active: boolean}}
 */
function createMoveStream(options) {
  const setTimer = options.setInterval || setInterval;
  const clearTimer = options.clearInterval || clearInterval;
  const now = options.now || Date.now;
  let active = false;
  let startedAt = 0;
  let handle = null;

  const sendSetpoint = () => {
    options.connection.send(options.message, sendOptions(options));
  };
  const stop = () => {
    if (!active) return;
    active = false;
    if (handle !== null) {
      clearTimer(handle);
      handle = null;
    }
    options.connection.send(buildStopMessage(options.message), sendOptions(options));
  };

  return {
    get active() {
      return active;
    },
    start() {
      if (active) return;
      active = true;
      startedAt = now();
      sendSetpoint();
      handle = setTimer(() => {
        if (!active) return;
        if (options.ttlMs > 0 && now() - startedAt >= options.ttlMs) {
          stop();
          return;
        }
        sendSetpoint();
      }, options.intervalMs || 100);
      if (handle && typeof handle.unref === 'function') handle.unref();
    },
    stop,
  };
}

/**
 * @param {string} kind
 * @param {object} input
 * @returns {number}
 */
function maskFor(kind, input) {
  let mask = IGNORE_ACCEL;
  if (kind === 'position') mask += MASK.VX + MASK.VY + MASK.VZ;
  else mask += MASK.X + MASK.Y + MASK.Z;
  if (input.yaw === undefined) mask += MASK.YAW;
  if (input.yawRate === undefined) mask += MASK.YAW_RATE;
  return mask;
}

/**
 * @param {object} message
 * @returns {{name:string, fields: object}}
 */
function buildStopMessage(message) {
  const fields = message.fields || {};
  return {
    name: 'SET_POSITION_TARGET_LOCAL_NED',
    fields: {
      time_boot_ms: numberOr(fields.time_boot_ms, 0),
      target_system: numberOr(fields.target_system, 1),
      target_component: numberOr(fields.target_component, 1),
      coordinate_frame: MAV_FRAME.LOCAL_NED,
      type_mask: MASK.X + MASK.Y + MASK.Z + IGNORE_ACCEL + MASK.YAW + MASK.YAW_RATE,
      x: 0,
      y: 0,
      z: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      afx: 0,
      afy: 0,
      afz: 0,
      yaw: 0,
      yaw_rate: 0,
    },
  };
}

/**
 * @param {object} options
 * @returns {object}
 */
function sendOptions(options) {
  return {
    band: BAND.STREAMING,
    target: options.target || {
      sysid: options.message.fields.target_system,
      compid: options.message.fields.target_component,
    },
    identityId: options.identityId,
  };
}

/**
 * Convert operator-facing decimal degrees to the wire `degE7` int32 (degrees ×
 * 1e7). Operator inputs are always degrees — including whole-number degrees
 * like 47 — so every value scales by 1e7. Treating integers as already-encoded
 * wire values would place a point at 47e-7 degrees, off by seven orders of
 * magnitude (§ "Coordinate frames").
 *
 * @param {*} value
 * @returns {number}
 */
function degreesToDegE7(value) {
  const n = numberOr(value, 0);
  return Math.round(n * 1e7);
}

/**
 * @param {*} value
 * @param {number} fallback
 * @returns {number}
 */
function numberOr(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`expected a finite number, got ${JSON.stringify(value)}`);
  return n;
}

/**
 * @param {*} value
 * @param {*} fallback
 * @returns {*}
 */
function valueOr(value, fallback) {
  return value === undefined || value === null || value === '' ? fallback : Number(value);
}

module.exports = {
  buildMoveMessage,
  buildStopMessage,
  createMoveStream,
  MAV_FRAME,
};
