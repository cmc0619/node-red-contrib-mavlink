'use strict';

const { isBlank } = require('../addressing/resolve');
const { MAV_FRAME } = require('./frames');

/**
 * Move's operator surface (§6 redesign, 2026-08-12): the operator picks an
 * intent — Action × Delivery — and the wire follows. The old carrier/mode/
 * frame triple was three encoding details the node could derive, and every
 * control the wire could have prevented from being wrong is code now:
 *
 * - **goto** — one-shot guided goto. Build/Send/Send-and-confirm ride
 *   `MAV_CMD_DO_REPOSITION` (COMMAND_INT); Stream rides
 *   `SET_POSITION_TARGET_GLOBAL_INT` at rate. The altitude reference
 *   (above-home vs MSL) is the only frame choice the operator ever sees.
 * - **steer** — setpoints. The reference picks the axes (world vs body); the
 *   type_mask derives from which field groups are non-blank, so the old mode
 *   pulldown has no successor — filling fields IS the mode.
 *
 * A saved config without `action` parses as steer — the fire-and-forget
 * direction, matching the old carrier field's setpoint default.
 */

const ALT_REF_FRAME = {
  home: MAV_FRAME.GLOBAL_RELATIVE_ALT,
  msl: MAV_FRAME.GLOBAL,
};

/**
 * Blank parses steer — the fire-and-forget direction. No legacy mapping and
 * no legacy refusal (owner ruling, 2026-08-12): pre-1.0 with no flows in the
 * wild, a config saved on the retired surface is not a case that exists, and
 * a guard for it would be the migration shim YAGNI forbids. The editor always
 * saves an explicit action.
 *
 * @param {*} value  config.action
 * @returns {'goto'|'steer'}
 */
function resolveMoveAction(value) {
  if (isBlank(value)) return 'steer';
  if (value === 'goto' || value === 'steer') return value;
  throw new Error(`unknown Move action ${JSON.stringify(value)} — expected goto or steer`);
}

/**
 * Altitude reference → global MAV_FRAME. Terrain is deliberately absent:
 * unmeasured on both stacks (§14), dropped from the surface until it isn't.
 *
 * @param {*} value  'home' | 'msl' (blank = home, the GCS default)
 * @returns {number}
 */
function frameForAltRef(value) {
  // Total by construction rather than checked: the config is a two-option
  // select and a payload override is trusted (AGENTS.md, input trust), so
  // there is nothing here to protect against. Anything that is not `msl`
  // resolves to `home` — the same coercion this already applied to a blank,
  // now covering every value instead of two.
  //
  // Not a lookup that can miss: returning undefined would make
  // resolveModeAndFrame read the frame as blank and default to LOCAL_NED, so
  // a goto would silently become a local setpoint with its lat/lon read as
  // metres from the EKF origin. A defined answer beats an accidental one.
  return value === 'msl' ? ALT_REF_FRAME.msl : ALT_REF_FRAME.home;
}

/**
 * Steer reference → local MAV_FRAME. World is LOCAL_NED everywhere. Body is
 * firmware-derived, because the two stacks read *different* body frames
 * (measured, §14 2026-08-05): ArduPilot treats BODY_OFFSET_NED (9) as the
 * body-axis offset; PX4 ignores 9 and reads BODY_NED (8), velocity-only. An
 * unknown firmware fails closed — a body setpoint aimed with the wrong frame
 * number is silently dropped by the vehicle, which is exactly the class of
 * wrong the derivation exists to prevent.
 *
 * @param {*} value     'world' | 'body' (blank = world)
 * @param {*} firmware  vehicle profile firmware, if any
 * @returns {number}
 */
function frameForReference(value, firmware) {
  // Total by construction, like frameForAltRef: anything that is not `body`
  // resolves to world/LOCAL_NED, which is the coercion a blank already got and
  // the frame that works on every stack. Nothing is checked here.
  //
  // The firmware refusal below is a different animal and stays: it is not
  // about the operator's input at all — we asked the vehicle what it is and
  // got no answer, so there is no frame number to pick. Guessing wrong is
  // silently dropped by the vehicle, which is the failure mode with no
  // symptom.
  if (value !== 'body') return MAV_FRAME.LOCAL_NED;
  if (firmware === 'ardupilot') return MAV_FRAME.BODY_OFFSET_NED;
  if (firmware === 'px4') return MAV_FRAME.BODY_NED;
  throw new Error(
    'Move body reference needs a Vehicle Profile with firmware ardupilot or px4 — ' +
    'the stacks read different body frames (§14), so an unadapted guess would be ' +
    'silently dropped; World (Local NED) works everywhere'
  );
}

/**
 * Derive the setpoint mode from which field groups carry values — the CSV
 * rule: the type_mask is an encoding detail, not a choice. Yaw/yaw-rate ride
 * any mode by presence (maskFor), and alone they are the measured-hazard
 * yaw-only mode, still sent because PX4 honours it (ArduPilot holds heading
 * instead — §10). Acceleration composes with nothing in the wire vocabulary
 * MODES already speaks, so mixing it refuses loud rather than silently
 * dropping a group.
 *
 * @param {{position: object, velocity: object, accel: object, yaw: *, yawRate: *}} groups
 * @returns {string}  a MODES key
 */
function deriveSteerMode(groups) {
  // Steer is local by construction, so only the local triplet counts as a
  // group member (Codex, #277): a node switched from Go to keeps its hidden
  // lat/lon/alt serialized, and positionFrom carries both families — reading
  // Object.values would let a stale global coordinate turn a velocity-only
  // steer into position-velocity and fail the blank-local guard.
  const has = (obj) => obj && ['north', 'east', 'up'].some((k) => !isBlank(obj[k]));
  const pos = has(groups.position);
  const vel = has(groups.velocity);
  const acc = has(groups.accel);
  // Position + acceleration with no velocity is the one combination with no
  // wire encoding we can vouch for: no named ArduPilot guided submode on the
  // Copter-4.7.0 read, no §14 measurement either way, and a setpoint carries
  // no ack — so if the read is right, "sent" and a vehicle holding position is
  // all the operator would ever see. Same class as body-without-firmware, not
  // input-vetting: the refusal exists because there is no right answer to
  // give, and it must say that rather than fall through to resolveModeAndFrame
  // calling a name this function composed "unknown".
  if (pos && acc && !vel) {
    throw new Error(
      'Move steer position + acceleration needs a velocity too — that pair alone has no ' +
      'guided submode on ArduPilot and is unmeasured (§14), and a setpoint carries no ack ' +
      'to say it was ignored; add a velocity or clear the acceleration'
    );
  }
  // Every other combination is a mode: the name is the filled groups joined.
  const name = [pos && 'position', vel && 'velocity', acc && 'acceleration']
    .filter(Boolean)
    .join('-');
  if (name) return name;
  // Yaw, yaw rate, or nothing at all. Nothing-at-all used to refuse; the
  // editor requires at least one Steer field now (mavlink-move.html `action`),
  // so the configured path cannot reach it, and a msg that blanks every group
  // is trusted. It builds the all-ignore packet, which is the honest encoding
  // of "commanded nothing" — PX4 logs it invalid and that is the flow's
  // problem to find, not ours to pre-empt.
  return 'yaw-only';
}

module.exports = {
  resolveMoveAction,
  frameForAltRef,
  frameForReference,
  deriveSteerMode,
};
