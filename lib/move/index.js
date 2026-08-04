'use strict';

const { BAND } = require('../connection/bands');

/**
 * MAV_FRAME values SET_POSITION_TARGET_* accepts, keyed by the bare member
 * name the editor stores. Global entries are the *_INT frames because the
 * global carrier is SET_POSITION_TARGET_GLOBAL_INT (degE7 lat/lon).
 */
const MAV_FRAME = {
  LOCAL_NED: 1,
  GLOBAL_INT: 5,
  GLOBAL_RELATIVE_ALT_INT: 6,
  LOCAL_OFFSET_NED: 7,
  BODY_NED: 8,
  BODY_OFFSET_NED: 9,
  GLOBAL_TERRAIN_ALT_INT: 11,
};

const GLOBAL_FRAMES = new Set([
  MAV_FRAME.GLOBAL_INT,
  MAV_FRAME.GLOBAL_RELATIVE_ALT_INT,
  MAV_FRAME.GLOBAL_TERRAIN_ALT_INT,
]);

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
  FORCE: 512,
  YAW: 1024,
  YAW_RATE: 2048,
};

const IGNORE_POSITION = MASK.X + MASK.Y + MASK.Z;
const IGNORE_VELOCITY = MASK.VX + MASK.VY + MASK.VZ;
const IGNORE_ACCEL = MASK.AX + MASK.AY + MASK.AZ;

/**
 * Move modes: which setpoint vectors the message *uses* (everything else is
 * mask-ignored). One vocabulary — Move, Fan-out, and payload overrides all
 * speak these names (pre-1.0: no aliases, no migrations).
 */
const MODES = {
  position: { position: true },
  velocity: { velocity: true },
  'position-velocity': { position: true, velocity: true },
  acceleration: { accel: true },
  force: { accel: true, force: true },
  'yaw-only': {},
};

/**
 * Build a SET_POSITION_TARGET_* message for Move. UI/API values are operator
 * friendly: local altitude, climb, and vertical acceleration are up-positive.
 * MAVLink NED is down-positive, so the sign flips here exactly once at encode
 * time. The frame picks the carrier: global frames ride
 * SET_POSITION_TARGET_GLOBAL_INT, everything else SET_POSITION_TARGET_LOCAL_NED.
 *
 * @param {object} input
 * @returns {{name:string, fields: object}}
 */
function buildMoveMessage(input) {
  const { mode, frame } = resolveModeAndFrame(input);
  const uses = MODES[mode];
  const global = GLOBAL_FRAMES.has(frame);
  const target = input.target;
  const p = input.position || {};
  const v = input.velocity || {};
  const a = input.accel || {};

  if (mode === 'yaw-only' && input.yaw === undefined && input.yawRate === undefined) {
    // All-ignore is what PX4 logs as `SET_POSITION_TARGET invalid` (§14 / #115)
    // — a yaw-only setpoint with nothing to command must not reach the wire.
    throw new Error('Move yaw-only requires yaw or yaw rate');
  }
  if (global && uses.position && (isBlank(p.lat) || isBlank(p.lon))) {
    // §10: blank coordinates must not become 0,0.
    throw new Error('Move global position requires lat and lon (blank coordinates must not become 0,0)');
  }

  const fields = {
    time_boot_ms: numberOr(input.timeBootMs, 0),
    target_system: target.sysid,
    target_component: target.compid,
    coordinate_frame: frame,
    type_mask: maskFor(mode, input),
    vx: uses.velocity ? numberOr(v.north, 0) : 0,
    vy: uses.velocity ? numberOr(v.east, 0) : 0,
    vz: uses.velocity ? -numberOr(v.up, 0) : 0,
    afx: uses.accel ? numberOr(a.north, 0) : 0,
    afy: uses.accel ? numberOr(a.east, 0) : 0,
    afz: uses.accel ? -numberOr(a.up, 0) : 0,
    yaw: valueOr(input.yaw, 0),
    yaw_rate: valueOr(input.yawRate, 0),
  };

  if (global) {
    return {
      name: 'SET_POSITION_TARGET_GLOBAL_INT',
      fields: {
        ...fields,
        lat_int: uses.position ? degreesToDegE7(p.lat) : 0,
        lon_int: uses.position ? degreesToDegE7(p.lon) : 0,
        alt: uses.position ? numberOr(p.alt, 0) : 0,
      },
    };
  }
  return {
    name: 'SET_POSITION_TARGET_LOCAL_NED',
    fields: {
      ...fields,
      x: uses.position ? numberOr(p.north, 0) : 0,
      y: uses.position ? numberOr(p.east, 0) : 0,
      z: uses.position ? -numberOr(p.up, 0) : 0,
    },
  };
}

/**
 * Resolve the mode name and numeric frame. Both frame spellings the API
 * accepts: a MAV_FRAME member name in `input.frame`, or a raw number in
 * `input.frame` / `input.coordinateFrame`.
 *
 * @param {object} input
 * @returns {{mode: string, frame: number}}
 */
function resolveModeAndFrame(input) {
  const mode = input.mode || 'position';
  if (!MODES[mode]) {
    throw new Error(
      `unknown Move mode ${JSON.stringify(mode)} — expected one of ${Object.keys(MODES).join(', ')}`
    );
  }

  let frame = input.frame !== undefined && input.frame !== null && input.frame !== ''
    ? input.frame
    : input.coordinateFrame;
  if (frame === undefined || frame === null || frame === '') {
    frame = MAV_FRAME.LOCAL_NED;
  } else if (typeof frame === 'string' && !/^\d+$/.test(frame)) {
    if (MAV_FRAME[frame] === undefined) {
      throw new Error(
        `unknown Move frame ${JSON.stringify(frame)} — expected one of ${Object.keys(MAV_FRAME).join(', ')}`
      );
    }
    frame = MAV_FRAME[frame];
  } else {
    frame = Number(frame);
    if (!Object.values(MAV_FRAME).includes(frame)) {
      throw new Error(`Move frame ${frame} is not a SET_POSITION_TARGET frame`);
    }
  }
  return { mode, frame };
}

/**
 * Whether this Move input commands a global-frame position — the shape whose
 * blank lat/lon must refuse rather than encode 0,0 (§10). Fan-out uses this
 * for its whole-action precheck; buildMoveMessage enforces the same rule.
 *
 * @param {object} input
 * @returns {boolean}
 */
function usesGlobalPosition(input) {
  const { mode, frame } = resolveModeAndFrame(input);
  return Boolean(MODES[mode].position) && GLOBAL_FRAMES.has(frame);
}

/**
 * Firmware advisory for combinations the major firmwares silently drop (§14:
 * a setpoint has no ack, so "sent" is all the vehicle ever says). The message
 * is still sent — support changes with firmware releases and `custom` opts out
 * — but the operator gets a warning instead of silence.
 *
 * @param {{mode: string, frame: number|string, firmware?: string}} input
 * @returns {string|null}  warning text, or null when nothing is known-unsupported
 */
function advisoryFor(input) {
  const { mode, frame } = resolveModeAndFrame(input);
  if (mode === 'force') {
    return 'Force setpoints: neither ArduPilot nor PX4 honors the force bit today — sent as configured, but expect the vehicle to ignore it';
  }
  const firmware = input.firmware;
  if (firmware === 'ardupilot') {
    if (mode === 'acceleration') {
      return 'ArduPilot GUIDED ignores acceleration-only setpoints on many builds — sent as configured';
    }
    if (frame === MAV_FRAME.BODY_NED) {
      return 'ArduPilot expects Body offset (BODY_OFFSET_NED); BODY_NED is the PX4 body frame — sent as configured';
    }
  }
  if (firmware === 'px4') {
    if (frame === MAV_FRAME.GLOBAL_TERRAIN_ALT_INT) {
      return 'PX4 does not support terrain-altitude position targets — sent as configured';
    }
    if (frame === MAV_FRAME.LOCAL_OFFSET_NED || frame === MAV_FRAME.BODY_OFFSET_NED) {
      return 'PX4 OFFBOARD does not support OFFSET frames (use Local NED or Body NED) — sent as configured';
    }
  }
  return null;
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
      // Send before committing stream state: sendSetpoint() reads nothing
      // mutable, so a throw leaves the stream cleanly stopped and propagates to
      // the caller rather than stranding it active with no timer.
      sendSetpoint();
      active = true;
      startedAt = now();
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
 * type_mask for a mode: ignore every vector the mode does not use, set the
 * force bit only for Force, and include yaw/yaw-rate by presence (blank means
 * ignored, a value — including 0 — means commanded).
 *
 * @param {string} mode  a MODES key
 * @param {object} input
 * @returns {number}
 */
function maskFor(mode, input) {
  const uses = MODES[mode];
  let mask = 0;
  if (!uses.position) mask += IGNORE_POSITION;
  if (!uses.velocity) mask += IGNORE_VELOCITY;
  if (!uses.accel) mask += IGNORE_ACCEL;
  if (uses.force) mask += MASK.FORCE;
  if (input.yaw === undefined) mask += MASK.YAW;
  if (input.yawRate === undefined) mask += MASK.YAW_RATE;
  return mask;
}

/**
 * Final setpoint when a Move stream stops (TTL, replace, or node close).
 *
 * This is a **zero-velocity** LOCAL_NED setpoint (type_mask 3527 — ignore
 * position/accel/yaw, use vx/vy/vz = 0), not an all-ignore packet. A true
 * all-ignore mask (also ignore VX/VY/VZ → 3583) is what PX4 logs as
 * `SET_POSITION_TARGET_LOCAL_NED invalid`; we do not send that (§14 / #115).
 *
 * @param {object} message
 * @returns {{name:string, fields: object}}
 */
function buildStopMessage(message) {
  // Copy target ids from the streamed setpoint — do not invent system/comp 1
  // when they are missing (DESIGN.md §14: unresolved target beats wrong airframe).
  const fields = message.fields || {};
  return {
    name: 'SET_POSITION_TARGET_LOCAL_NED',
    fields: {
      time_boot_ms: numberOr(fields.time_boot_ms, 0),
      target_system: fields.target_system,
      target_component: fields.target_component,
      coordinate_frame: MAV_FRAME.LOCAL_NED,
      // Same mask as maskFor('velocity'): velocities are *used*, set to zero.
      type_mask: IGNORE_POSITION + IGNORE_ACCEL + MASK.YAW + MASK.YAW_RATE,
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
 * @returns {boolean}
 */
function isBlank(value) {
  return value === undefined || value === null || value === '';
}

/**
 * @param {*} value
 * @param {number} fallback
 * @returns {number}
 */
function numberOr(value, fallback) {
  if (isBlank(value)) return fallback;
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
  return isBlank(value) ? fallback : Number(value);
}

const { positionFrom, velocityFrom, accelFrom, valueFrom } = require('./from-config');

module.exports = {
  buildMoveMessage,
  buildStopMessage,
  createMoveStream,
  advisoryFor,
  usesGlobalPosition,
  MAV_FRAME,
  positionFrom,
  velocityFrom,
  accelFrom,
  valueFrom,
};
