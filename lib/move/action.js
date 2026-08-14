'use strict';

const { isBlank } = require('../addressing/resolve');
const { MAV_FRAME, enumValue } = require('./frames');

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
 * - **steer** — setpoints. The reference picks the axes and the origin (world,
 *   body, or offset-from-here); the type_mask derives from which field groups
 *   are non-blank, so the old mode pulldown has no successor — filling fields
 *   IS the mode.
 *
 * A saved config without `action` parses as steer — the fire-and-forget
 * direction, matching the old carrier field's setpoint default.
 */

/**
 * The Move primitive roster (§9 "Move primitive roster"). Curated, not a
 * cross-product: each earns its place by being emitted in the wild (QGC,
 * MAVSDK, pymavlink) or by being the only way a supported vehicle family can
 * do the thing.
 *
 * - `goto` / `steer` — position, the original two.
 * - `turn` — CONDITION_YAW. The *only* working yaw where it works at all (§14):
 *   both of the yaw fields the position carriers already had are measured inert
 *   on Copter. Copter and Sub carry the handler; Plane and Rover do not.
 * - `speed` — DO_CHANGE_SPEED, QGC's guided speed change.
 * - `attitude` — SET_ATTITUDE_TARGET, MAVSDK's Offboard attitude modes.
 * - `manual` — MANUAL_CONTROL: QGC's joystick and the way ArduSub is flown.
 *
 * Setpoint actions stream; command actions ack. Which tiers each offers is the
 * editor's table (`DELIVERY_OPTIONS`), enforced by the legality matrix.
 */
const MOVE_ACTIONS = new Set(['goto', 'steer', 'turn', 'speed', 'attitude', 'manual']);

/** Actions that ride an acked MAV_CMD rather than a setpoint. */
const COMMAND_ACTIONS = new Set(['turn', 'speed']);

/** Steer references whose frame is the same on every stack. */
const LOCAL_REF_FRAME = {
  world: MAV_FRAME.LOCAL_NED,
  offset: MAV_FRAME.LOCAL_OFFSET_NED,
};

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
  if (MOVE_ACTIONS.has(value)) return value;
  throw new Error(
    `unknown Move action ${JSON.stringify(value)} — expected one of ${[...MOVE_ACTIONS].join(', ')}`
  );
}

/**
 * Altitude reference → global MAV_FRAME. Terrain is deliberately absent:
 * unmeasured on both stacks (§14), dropped from the surface until it isn't.
 *
 * @param {*} value  'home' | 'msl' (blank = home, the GCS default)
 * @returns {number}
 */
function frameForAltRef(value) {
  // Blank is the GCS default, above home. Anything else must name a frame:
  // the coercion this replaces sent every non-'msl' token to above-home, so a
  // payload override of 'MSL' flew the goto at the wrong datum (§14).
  if (isBlank(value)) return ALT_REF_FRAME.home;
  return enumValue(ALT_REF_FRAME, value, 'altitude reference');
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
 * Offset is LOCAL_OFFSET_NED (7) on every stack, so unlike body it asks no
 * firmware question: the number does not vary, only whether the vehicle acts
 * on it. ArduCopter, Rover and Sub add the triplet to their current position;
 * ArduPlane accepts *only* this frame and reads only `z`; PX4 is measured inert
 * (§14 2026-08-05, no motion burst or stream). That last one is a
 * known-unsupported combo, which sends with the runtime silent about it (§9) —
 * the dialog is where PX4 stops being offered the choice, not here.
 *
 * @param {*} value     'world' | 'body' | 'offset' (blank = world)
 * @param {*} firmware  vehicle profile firmware, if any
 * @returns {number}
 */
function frameForReference(value, firmware) {
  // Blank is world/LOCAL_NED, the frame that works on every stack. 'body' is
  // the one member whose answer depends on the vehicle, so it is resolved
  // before the table; its refusal predates the no-defaults ruling and is about
  // the vehicle rather than the caller — we asked what it is and got no
  // answer, so there is no frame number to pick.
  if (isBlank(value)) return MAV_FRAME.LOCAL_NED;
  if (value === 'body') {
    if (firmware === 'ardupilot') return MAV_FRAME.BODY_OFFSET_NED;
    if (firmware === 'px4') return MAV_FRAME.BODY_NED;
    throw new Error(
      'Move body reference needs a Vehicle Profile with firmware ardupilot or px4 — ' +
      'the stacks read different body frames (§14), so an unadapted guess would be ' +
      'silently dropped; World (Local NED) works everywhere'
    );
  }
  return enumValue(LOCAL_REF_FRAME, value, 'reference');
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
  MOVE_ACTIONS,
  COMMAND_ACTIONS,
  resolveMoveAction,
  frameForAltRef,
  frameForReference,
  deriveSteerMode,
};
