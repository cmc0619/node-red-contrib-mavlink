'use strict';

const { BAND } = require('../connection/bands');
const { isBlank } = require('../addressing/resolve');
const { streamLocks } = require('../delivery/lock');
// Mode/frame vocabulary shared with the reposition carrier (./frames.js).
// The setpoint carrier stays
// SET_POSITION_TARGET_GLOBAL_INT (degE7 lat/lon) for every global frame — the
// message name and the frame numbering are independent.
const {
  MAV_FRAME,
  GLOBAL_FRAMES,
  MODES,
  resolveModeAndFrame,
  requireNumber,
  bootNow,
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

  // The one frame where a blank position axis is not a missing value. On an
  // absolute local frame a 0 is the EKF origin, a real place the vehicle flies
  // to; on LOCAL_OFFSET_NED a 0 is a zero *offset*, which is no movement on
  // that axis (§14 2026-08-05, the frame-7 probe). Filling one axis is the
  // whole point of the reference — QGC's guided altitude change fills only z,
  // and ArduPlane reads only z — so requiring the triplet here would refuse the
  // one shape a fixed wing has. The editor draws the same line
  // (positionAxisValidator), and this is the runtime half of it.
  const axisOffset = frame === MAV_FRAME.LOCAL_OFFSET_NED;
  const positionAxis = (value, label) => {
    if (axisOffset && isBlank(value)) return 0;
    return requireNumber(value, label);
  };

  const fields = {
    // Explicit caller timeBootMs wins (trusted input); absent → the clock.
    // Not a substitution: this stamp is ours, never the operator's.
    time_boot_ms: isBlank(input.timeBootMs)
      ? bootNow()
      : requireNumber(input.timeBootMs, 'time_boot_ms'),
    target_system: target.sysid,
    target_component: target.compid,
    coordinate_frame: frame,
    type_mask: maskFor(mode, yaw, yawRate),
    // A group the mask says is commanded must arrive whole. Filling one axis is
    // what names the group (deriveSteerMode), and the remaining two used to
    // encode 0 — which under that mask is a commanded zero, not a blank: a
    // velocity north with east and up left empty became "hold 0 sideways, 0
    // vertical", indistinguishable on the wire from the operator asking for it.
    // The mask has no per-axis bit to say otherwise, so a partial group refuses.
    vx: uses.velocity ? requireNumber(v.north, 'a north velocity') : 0,
    vy: uses.velocity ? requireNumber(v.east, 'an east velocity') : 0,
    vz: uses.velocity ? -requireNumber(v.up, 'an up velocity') : 0,
    afx: uses.accel ? requireNumber(a.north, 'a north acceleration') : 0,
    afy: uses.accel ? requireNumber(a.east, 'an east acceleration') : 0,
    afz: uses.accel ? -requireNumber(a.up, 'an up acceleration') : 0,
    // Filler, not a value: `maskFor` above set MASK.YAW / MASK.YAW_RATE from
    // these same undefineds, so the vehicle is told not to read the bytes. The
    // 0 is legal only because that bit is set, so it is written here beside it
    // rather than inside degreesToRadians, which cannot see the mask.
    yaw: yaw === undefined ? 0 : degreesToRadians(yaw),
    yaw_rate: yawRate === undefined ? 0 : degreesToRadians(yawRate),
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
        lat_int: uses.position ? degreesToDegE7(p.lat, 'a latitude') : 0,
        lon_int: uses.position ? degreesToDegE7(p.lon, 'a longitude') : 0,
        alt: uses.position ? positionAxis(p.alt, 'an altitude') : 0,
      },
    };
  }
  return {
    name: 'SET_POSITION_TARGET_LOCAL_NED',
    fields: {
      ...fields,
      x: uses.position ? positionAxis(p.north, 'a north position') : 0,
      y: uses.position ? positionAxis(p.east, 'an east position') : 0,
      z: uses.position ? -positionAxis(p.up, 'an up position') : 0,
    },
  };
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
    // Re-stamp every send: the stream repeats one built message, and the
    // library — not the caller — is the sender of each repetition, so each
    // tick carries its own honest time. Copies, never mutates, the original.
    //
    // Only for messages that carry the field. MANUAL_CONTROL has no
    // time_boot_ms, and adding one would invent a field the message does not
    // declare — the encoder's business, not a stream's. Presence in the built
    // message is the test, so no per-action list has to be kept in sync.
    const message = options.message;
    const fields = Object.prototype.hasOwnProperty.call(message.fields, 'time_boot_ms')
      ? { ...message.fields, time_boot_ms: bootNow() }
      : message.fields;
    options.connection.send({ ...message, fields }, sendOptions(options));
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
  // Whether this stream has an end-of-control packet at all. Position
  // setpoints do — the measured zero-velocity brake (§14 / #115). Attitude and
  // manual sticks do not, and inventing one would be worse than silence: zero
  // thrust is a descent, not a brake, and a centred stick is a command rather
  // than an absence. §9 ruling 1 makes ceasing to transmit the end of control
  // for those, which every stack's own watchdog is built to see.
  const braking = options.braking !== false;

  const stop = ({ brake = true } = {}) => {
    if (!active) return null;
    active = false;
    if (handle !== null) {
      clearTimer(handle);
      handle = null;
    }
    if (!brake || !braking) return null;
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
      // The brake is synthesized here, so its stamp is this send's time — a
      // copy of the streamed setpoint's stamp would date it at stream start.
      time_boot_ms: bootNow(),
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
function degreesToDegE7(value, label) {
  return Math.round(requireNumber(value, label) * 1e7);
}

const { positionFrom, velocityFrom, accelFrom, valueFrom } = require('./from-config');
const { buildRepositionMessage } = require('./reposition');
const {
  MOVE_ACTIONS,
  COMMAND_ACTIONS,
  frameForAltRef,
  frameForReference,
  deriveSteerMode,
} = require('./action');
const { buildTurnMessage } = require('./turn');
const { buildSpeedMessage } = require('./speed');
const { buildAttitudeMessage, quaternionFromEuler } = require('./attitude');
const { buildManualMessage } = require('./manual');

module.exports = {
  MAV_FRAME,
  buildMoveMessage,
  buildStopMessage,
  createMoveStream,
  streamLocks,
  buildRepositionMessage,
  positionFrom,
  velocityFrom,
  accelFrom,
  valueFrom,
  MOVE_ACTIONS,
  COMMAND_ACTIONS,
  frameForAltRef,
  frameForReference,
  deriveSteerMode,
  buildTurnMessage,
  buildSpeedMessage,
  buildAttitudeMessage,
  quaternionFromEuler,
  buildManualMessage,
};
