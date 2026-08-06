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

/**
 * Frames whose position triplet is an *offset from where the vehicle is now*,
 * so a zero on any axis means "no change" and a blank is inert.
 *
 * Measured, not inferred (§14, SITL 2026-08-05): ArduPilot Copter-4.7.0 treats
 * 7 as a world-axis offset and 9 as a body-axis offset; PX4 1.18.0 ignores
 * both entirely (no motion). Deliberately **excluded**: LOCAL_NED (1) is
 * absolute on both stacks, and BODY_NED (8) is a body offset only on
 * ArduPilot — PX4 moved absolute-like on the same packet. One frame, two
 * meanings, so 8 cannot claim the blanks-are-inert exemption.
 */
const OFFSET_FRAMES = new Set([
  MAV_FRAME.LOCAL_OFFSET_NED,
  MAV_FRAME.BODY_OFFSET_NED,
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
  // Yaw and yaw-rate are included *by presence*: blank means mask-ignored, a
  // value (0 included) means commanded. Normalise blank to undefined here, at
  // the library boundary — `msg.payload.yaw = ''` reaches this function
  // unnormalised, and treating it as present both clears the ignore bit and
  // encodes 0, commanding a yaw to north nobody asked for.
  const yaw = isBlank(input.yaw) ? undefined : input.yaw;
  const yawRate = isBlank(input.yawRate) ? undefined : input.yawRate;

  if (mode === 'yaw-only' && yaw === undefined && yawRate === undefined) {
    // All-ignore is what PX4 logs as `SET_POSITION_TARGET invalid` (§14 / #115)
    // — a yaw-only setpoint with nothing to command must not reach the wire.
    throw new Error('Move yaw-only requires yaw or yaw rate');
  }
  if (global && uses.position && (isBlank(p.lat) || isBlank(p.lon) || isBlank(p.alt))) {
    // §10: blank coordinates must not become 0,0 — and a blank alt zero-filled
    // is the same hazard on the vertical axis: 0 m above home (frame 6) or
    // 0 m AGL (frame 11) is the ground, and 0 m MSL (frame 5) may be below it.
    throw new Error('Move global position requires lat, lon and alt (blank coordinates must not become 0,0 at ground level)');
  }
  if (
    !global &&
    uses.position &&
    !OFFSET_FRAMES.has(frame) &&
    (isBlank(p.north) || isBlank(p.east) || isBlank(p.up))
  ) {
    // Same §10 rule on the local plane: in an *absolute* local frame a blank
    // north/east/up zero-filled into a position setpoint commands the EKF
    // origin — a real place, and rarely where the vehicle is. An explicit 0 is
    // a value; blank refuses. In the measured OFFSET frames a zero is "no
    // change" on every axis, so blanks are inert and pass (§14). Velocity and
    // acceleration blanks always stay 0 — a zero rate is inert, not a place.
    throw new Error('Move local position requires north, east and up (blank coordinates must not become the origin)');
  }

  const fields = {
    time_boot_ms: numberOr(input.timeBootMs, 0),
    target_system: target.sysid,
    target_component: target.compid,
    coordinate_frame: frame,
    type_mask: maskFor(mode, yaw, yawRate),
    vx: uses.velocity ? numberOr(v.north, 0) : 0,
    vy: uses.velocity ? numberOr(v.east, 0) : 0,
    vz: uses.velocity ? -numberOr(v.up, 0) : 0,
    afx: uses.accel ? numberOr(a.north, 0) : 0,
    afy: uses.accel ? numberOr(a.east, 0) : 0,
    afz: uses.accel ? -numberOr(a.up, 0) : 0,
    yaw: valueOr(yaw, 0),
    yaw_rate: valueOr(yawRate, 0),
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
  // Own-property checks, not truthiness/undefined: `mode` and `frame` are
  // runtime-boundary data (`msg.payload`), and a plain object literal inherits
  // `constructor`, `toString`, `valueOf`… A mode of 'constructor' otherwise
  // passes the guard, `uses` becomes a function, every `uses.*` read is
  // undefined, and maskFor emits type_mask 3583 — the all-ignore packet the
  // yaw-only guard exists to prevent (§14 / #115).
  if (!Object.prototype.hasOwnProperty.call(MODES, mode)) {
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
    if (!Object.prototype.hasOwnProperty.call(MAV_FRAME, frame)) {
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
 * Firmware advisory for combinations the major firmwares silently drop (§14:
 * a setpoint has no ack, so "sent" is all the vehicle ever says). The message
 * is still sent — support changes with firmware releases and `custom` opts out
 * — but the operator gets a warning instead of silence.
 *
 * Every measured advisory is PX4-specific, so this is null on any other
 * firmware. Frame still resolves through resolveModeAndFrame, which is also
 * what rejects an unknown mode or frame name.
 *
 * @param {{mode: string, frame: number|string, firmware?: string}} input
 * @returns {string|null}  warning text, or null when nothing is known-unsupported
 */
function advisoryFor(input) {
  const { frame } = resolveModeAndFrame(input);
  if (input.firmware === 'px4') {
    // Measured: no motion for either OFFSET frame on PX4 1.18 SIH. Mechanism
    // (source): LOCAL_OFFSET_NED is not in the handler's frame switch at all
    // and hits its "coordinate frame unsupported" rejection; BODY_OFFSET_NED
    // is accepted but shares the body-frame branch, which discards position.
    if (OFFSET_FRAMES.has(frame)) {
      return 'PX4 ignored OFFSET-frame position setpoints in measurement — no motion (§14); use Local NED. Sent as configured';
    }
    // Measured: no usable position motion. Mechanism (source): PX4's body-frame
    // branch sets the position setpoint to NaN and uses only the velocity, so a
    // position-only BODY_NED packet carries nothing actionable. ArduPilot reads
    // the same frame as a body offset — one packet, two meanings.
    if (frame === MAV_FRAME.BODY_NED) {
      return 'PX4 discards position in body frames — BODY_NED carries velocity only (§14); use Local NED on PX4 for position. Sent as configured';
    }
  }
  return null;
}

/**
 * A running setpoint stream: re-send `options.message` every `intervalMs`
 * until `ttlMs` elapses, then send the zero-velocity stop packet.
 *
 * `options.onExpire(stopMessage)` fires **only** when the TTL ends the stream.
 * That is the one stop nobody asked for — a caller-driven `stop()` (stream
 * replaced, node closed) is already known to whoever called it, while TTL
 * expiry is invisible unless the stream says so.
 *
 * @param {object} options
 * @param {Function} [options.onExpire]  called with the stop message on TTL expiry
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
    if (!active) return null;
    active = false;
    if (handle !== null) {
      clearTimer(handle);
      handle = null;
    }
    const stopMessage = buildStopMessage(options.message);
    options.connection.send(stopMessage, sendOptions(options));
    return stopMessage;
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
          // Halt the vehicle first, tell the flow second: the stop packet is
          // the safety-relevant half, and a throwing listener must not be able
          // to leave the vehicle holding the last setpoint.
          const stopMessage = stop();
          if (options.onExpire) options.onExpire(stopMessage);
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
 * type_mask for a mode: ignore every vector the mode does not use, and include
 * yaw/yaw-rate by presence (blank means ignored, a value — including 0 — means
 * commanded).
 *
 * @param {string} mode  a MODES key
 * @param {*} yaw       commanded yaw, or undefined when ignored
 * @param {*} yawRate   commanded yaw rate, or undefined when ignored
 * @returns {number}
 */
function maskFor(mode, yaw, yawRate) {
  const uses = MODES[mode];
  let mask = 0;
  if (!uses.position) mask += IGNORE_POSITION;
  if (!uses.velocity) mask += IGNORE_VELOCITY;
  if (!uses.accel) mask += IGNORE_ACCEL;
  if (yaw === undefined) mask += MASK.YAW;
  if (yawRate === undefined) mask += MASK.YAW_RATE;
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
    target: options.target,
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
 * Blank means "no value supplied": undefined, null, or a string with nothing
 * in it but whitespace.
 *
 * The whitespace arm is load-bearing, not tidiness. `Number(' ')` is **0**, and
 * a finite one, so a whitespace-only string sails through every downstream
 * check: `' '` as a coordinate zero-fills to the origin or to ground level —
 * defeating the §10 guards two lines up — and `' '` as a yaw clears the ignore
 * bit and commands north. A string that looks empty is treated as empty.
 *
 * @param {*} value
 * @returns {boolean}
 */
function isBlank(value) {
  if (value === undefined || value === null) return true;
  return typeof value === 'string' && value.trim() === '';
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
  positionFrom,
  velocityFrom,
  accelFrom,
  valueFrom,
};
