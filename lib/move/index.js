'use strict';

const { BAND } = require('../connection/bands');
const { isBlank } = require('../addressing/resolve');
const { streamLocks } = require('../delivery/lock');
// Mode/frame vocabulary and coordinate guards shared with the reposition
// carrier (./frames.js). The setpoint carrier stays
// SET_POSITION_TARGET_GLOBAL_INT (degE7 lat/lon) for every global frame — the
// message name and the frame numbering are independent.
const {
  MAV_FRAME,
  GLOBAL_FRAMES,
  MODES,
  resolveModeAndFrame,
  requireGlobalPosition,
  numberOr,
  degreesToRadians,
} = require('./frames');

/**
 * Wire numbering for the global frames: the deprecated *_INT twin of each
 * canonical frame. PX4 main exact-matches 5/6/11 in
 * handle_message_set_position_target_global_int and discards any other frame
 * (source-read 2026-08-09); every current stack accepts the *_INT numbers, so
 * they are the byte-identical wire form. Only 0→5 and 3→6 are reachable —
 * terrain left the surface with the Action redesign.
 */
const PX4_COMPAT_FRAME = {
  [MAV_FRAME.GLOBAL]: 5,
  [MAV_FRAME.GLOBAL_RELATIVE_ALT]: 6,
};

/**
 * Frames whose position triplet is an *offset from where the vehicle is now*,
 * so a zero on any axis means "no change" and a blank is inert. Only
 * BODY_OFFSET_NED (9) is reachable since the Action surface.
 *
 * Measured, not inferred (§14, SITL 2026-08-05): ArduPilot Copter-4.7.0 treats
 * 9 as a body-axis offset; PX4 1.18.0 ignores it entirely (no motion).
 * Deliberately **excluded**: LOCAL_NED (1) is absolute on both stacks, and
 * BODY_NED (8) is a body offset only on ArduPilot — PX4 moved absolute-like
 * on the same packet. One frame, two meanings, so 8 cannot claim the
 * blanks-are-inert exemption.
 */
const OFFSET_FRAMES = new Set([
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
 * Build a SET_POSITION_TARGET_* message for Move. UI/API values are operator
 * friendly: local altitude, climb, and vertical acceleration are up-positive,
 * and yaw/yaw rate are degrees. MAVLink NED is down-positive and yaw is
 * radians, so the sign flips and the degree conversion happen here exactly
 * once at encode time. The frame picks the carrier: global frames ride
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
  if (global && uses.position) {
    // Blank and out-of-range refusals shared with the reposition carrier
    // (./frames.js): §10 blank coordinates must not become 0,0 at ground
    // level, and the degE7 int32 ceiling makes range a guard, not pedantry.
    requireGlobalPosition(p);
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
    yaw: degreesToRadians(yaw),
    yaw_rate: degreesToRadians(yawRate),
  };

  if (global) {
    return {
      name: 'SET_POSITION_TARGET_GLOBAL_INT',
      fields: {
        ...fields,
        // The wire number is code, not a choice (§6 redesign, 2026-08-12):
        // global setpoint frames always transmit the *_INT twin — PX4 main
        // exact-matches 5/6/11 and discards anything else, and every current
        // stack accepts the twins, so there is no operator who benefits from
        // the spec-current number. The old px4Compat checkbox's off-position
        // existed to send a number PX4 rejects; it is deleted, not defaulted.
        coordinate_frame: PX4_COMPAT_FRAME[frame],
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
 * Firmware advisory for combinations the major firmwares silently drop (§14:
 * a setpoint has no ack, so "sent" is all the vehicle ever says). The message
 * is still sent — support changes with firmware releases and `custom` opts out
 * — but the operator gets a warning instead of silence.
 *
 * Measured advisories are firmware-specific (PX4 OFFSET/BODY_NED; ArduPilot
 * absolute-yaw-only). Frame still resolves through resolveModeAndFrame, which
 * is also what rejects an unknown mode or frame name.
 *
 * @param {{mode: string, frame: number|string, firmware?: string, yawRate?: *}} input
 * @returns {string|null}  warning text, or null when nothing is known-unsupported
 */
function advisoryFor(input) {
  const { mode, frame } = resolveModeAndFrame(input);
  if (input.firmware === 'px4') {
    // Measured: no motion for either OFFSET frame on PX4 1.18 SIH — the
    // LOCAL_OFFSET_NED (7) half of that measurement is history now (the frame
    // is unreachable since the Action surface); the code names only
    // BODY_OFFSET_NED (9). Mechanism (source): BODY_OFFSET_NED is accepted but
    // shares the body-frame branch, which discards position.
    if (OFFSET_FRAMES.has(frame)) {
      return 'PX4 ignored BODY_OFFSET_NED position setpoints in measurement — no motion (§14); use Local NED. Sent as configured';
    }
    // Measured: no usable position motion. Mechanism (source): PX4's body-frame
    // branch sets the position setpoint to NaN and uses only the velocity, so a
    // position-only BODY_NED packet carries nothing actionable. ArduPilot reads
    // the same frame as a body offset — one packet, two meanings. Gated on the
    // mode actually commanding position (Codex, #277): BODY_NED velocity is
    // PX4's *intended* body path — the frame the steer body reference derives —
    // and warning on every valid body-velocity send would be the noise that
    // gets advisories ignored.
    if (frame === MAV_FRAME.BODY_NED && MODES[mode].position) {
      return 'PX4 discards position in body frames — BODY_NED carries velocity only (§14); use Local NED on PX4 for position. Sent as configured';
    }
  }
  // Measured 2026-08-08 (#179): Copter-4.7.0 GUIDED held heading (0.2° in 5 s)
  // under an *absolute-yaw* yaw-only stream — type_mask 2559 exactly. Source:
  // all-ignore pos/vel/accel → hold_position(), which never reads yaw.
  //
  // Scoped to that mask. A yaw-only setpoint carrying a yaw *rate* is mask 1535
  // (or 511 with both), and neither was measured — the same run clocked AP
  // slewing at ~60 °/s when a rate was commanded, so "no yaw change" would be a
  // claim against the evidence. §14 is measurement-only: an advisory that fires
  // past what was measured is the noise three deleted advisories were deleted for.
  if (input.firmware === 'ardupilot' && mode === 'yaw-only' && isBlank(input.yawRate)) {
    return 'ArduPilot GUIDED ignored yaw-only setpoints in measurement — no yaw change (§14); use velocity or position with yaw. Sent as configured';
  }
  return null;
}

/**
 * A running setpoint stream: re-send `options.message` at `rateHz` setpoints
 * per second until `ttlMs` elapses, then send the zero-velocity brake packet.
 * The operator speaks Hz; the timer wants milliseconds — the conversion
 * happens exactly once, where the timer is armed.
 *
 * `stop({brake})` follows GCS practice (§ "Move setpoint matrix", ruled
 * 2026-08-09): the brake marks the *end* of control, so it fires on TTL
 * expiry, an explicit stop, and node close. A handover to a replacement
 * stream passes `brake: false` — MAVSDK and QGC never brake between
 * consecutive targets; the new setpoint IS the next command. A brake send may
 * throw (Connection.send fails loud on a dead link): the TTL path catches it
 * here so expiry bookkeeping survives; every other path leaves the throw to
 * its caller, which knows where that failure must land.
 *
 * A tick send that throws is contained: an uncaught throw inside the interval
 * callback is a process-level crash, and the stream never decides to quit on
 * send failure — it keeps its cadence and retries every tick; the firmware's
 * own setpoint watchdog is the failsafe on a truly dead link (§ "Move
 * setpoint matrix"). `onSendError(err)` fires on the first failure of a
 * consecutive streak, `onSendRecovery()` on the first success after one.
 *
 * `options.onExpire(stopMessage, brakeError)` fires **only** when the TTL
 * ends the stream. That is the one stop nobody asked for — a caller-driven
 * `stop()` is already known to whoever called it, while TTL expiry is
 * invisible unless the stream says so. `brakeError` is set (and `stopMessage`
 * null) when the expiry brake send threw.
 *
 * @param {object} options
 * @param {Function} [options.onExpire]        called with the brake message (or null) on TTL expiry
 * @param {Function} [options.onSendError]     first tick-send failure of a streak
 * @param {Function} [options.onSendRecovery]  first tick-send success after a failed streak
 * @returns {{start: Function, stop: Function, active: boolean, sent: number}}
 */
function createMoveStream(options) {
  const setTimer = options.setInterval || setInterval;
  const clearTimer = options.clearInterval || clearInterval;
  const now = options.now || Date.now;
  let active = false;
  let startedAt = 0;
  let handle = null;
  // Setpoints the connection accepted — a send() that threw accepted
  // nothing, so failed attempts do not count; the brake is not a setpoint and
  // never counts. This is a count of sends, not wire deliveries: the
  // streaming band deliberately coalesces under backpressure (last value
  // wins), which is correct for setpoints and invisible here (Codex, #240).
  // Rides the 'expired' and 'stopped' status records.
  let sent = 0;
  let sendFailing = false;

  const sendSetpoint = () => {
    options.connection.send(options.message, sendOptions(options));
    sent++;
  };
  // One report per consecutive-failure streak, not per tick: at stream rates
  // a dead link would otherwise emit hundreds of identical records a second.
  const tickSetpoint = () => {
    try {
      sendSetpoint();
      if (sendFailing) {
        sendFailing = false;
        if (options.onSendRecovery) options.onSendRecovery();
      }
    } catch (err) {
      if (!sendFailing) {
        sendFailing = true;
        if (options.onSendError) options.onSendError(err);
      }
    }
  };
  const stop = ({ brake = true } = {}) => {
    if (!active) return null;
    active = false;
    if (handle !== null) {
      clearTimer(handle);
      handle = null;
    }
    if (!brake) return null;
    const stopMessage = buildStopMessage(options.message);
    options.connection.send(stopMessage, sendOptions(options));
    return stopMessage;
  };

  return {
    get active() {
      return active;
    },
    get sent() {
      return sent;
    },
    start() {
      if (active) return;
      // Send before committing stream state: sendSetpoint() reads nothing
      // mutable, so a throw leaves the stream cleanly stopped and propagates to
      // the caller rather than stranding it active with no timer. Deliberately
      // unguarded — the input that starts the stream is still on the stack,
      // and it must fail loudly there, not become a stream that starts by
      // silently retrying.
      sendSetpoint();
      active = true;
      startedAt = now();
      handle = setTimer(() => {
        if (!active) return;
        if (options.ttlMs > 0 && now() - startedAt >= options.ttlMs) {
          // Halt the vehicle first, tell the flow second: the brake packet is
          // the safety-relevant half, and a throwing listener must not be able
          // to leave the vehicle holding the last setpoint. A brake send that
          // throws must not break the expiry bookkeeping either — the failure
          // rides the expiry report instead.
          let stopMessage = null;
          let brakeError = null;
          try {
            stopMessage = stop();
          } catch (err) {
            brakeError = err;
          }
          if (options.onExpire) options.onExpire(stopMessage, brakeError);
          return;
        }
        tickSetpoint();
      }, 1000 / options.rateHz);
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
 * Final setpoint when a Move stream ends control (TTL expiry, explicit stop,
 * node close) — never sent on a replacement handover, where the new setpoint
 * is the next command (§ "Move setpoint matrix": GCS practice).
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

const { positionFrom, velocityFrom, accelFrom, valueFrom } = require('./from-config');
const { buildRepositionMessage } = require('./reposition');
const {
  resolveMoveAction,
  frameForAltRef,
  frameForReference,
  deriveSteerMode,
  refuseRetiredOverrides,
} = require('./action');

module.exports = {
  buildMoveMessage,
  buildStopMessage,
  createMoveStream,
  streamLocks,
  advisoryFor,
  buildRepositionMessage,
  positionFrom,
  velocityFrom,
  accelFrom,
  valueFrom,
  resolveMoveAction,
  frameForAltRef,
  frameForReference,
  deriveSteerMode,
  refuseRetiredOverrides,
};
