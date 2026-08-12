'use strict';

const { isBlank } = require('../addressing/resolve');
const { MAV_FRAME, MODES } = require('./frames');

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
 * direction, matching the old carrier field's setpoint default. The old
 * vocabulary is refused loud when it arrives via `msg.payload` (see
 * refuseRetiredOverrides): silently reinterpreting a `carrier: 'reposition'`
 * override as a setpoint would send the wrong wire message for the intent.
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
  const ref = isBlank(value) ? 'home' : value;
  if (!Object.prototype.hasOwnProperty.call(ALT_REF_FRAME, ref)) {
    throw new Error(
      `unknown Move altitude reference ${JSON.stringify(value)} — expected home (above home) or msl (absolute)`
    );
  }
  return ALT_REF_FRAME[ref];
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
  const ref = isBlank(value) ? 'world' : value;
  if (ref === 'world') return MAV_FRAME.LOCAL_NED;
  if (ref !== 'body') {
    throw new Error(`unknown Move reference ${JSON.stringify(value)} — expected world or body`);
  }
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
 * yaw-only mode, still sent (with the §14 ArduPilot advisory) because PX4
 * honours it. Acceleration composes with nothing in the wire vocabulary
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
  if (acc && (pos || vel)) {
    throw new Error(
      'Move steer cannot mix acceleration with position or velocity — the setpoint ' +
      'vocabulary has no such mode; clear one group'
    );
  }
  if (acc) return 'acceleration';
  if (pos && vel) return 'position-velocity';
  if (pos) return 'position';
  if (vel) return 'velocity';
  if (!isBlank(groups.yaw) || !isBlank(groups.yawRate)) return 'yaw-only';
  throw new Error(
    'Move steer has nothing to command — fill a position, velocity, or acceleration ' +
    'field, or a yaw/yaw-rate'
  );
}

/**
 * The retired override vocabulary fails loud (§ redesign): a payload written
 * for the old surface must not be silently reinterpreted — `carrier:
 * "reposition"` read as a setpoint sends the wrong wire message for the
 * intent, the exact wrong the one-vocabulary work exists to prevent.
 *
 * @param {object} payload
 */
function refuseRetiredOverrides(payload) {
  for (const key of ['carrier', 'mode', 'frame', 'px4Compat']) {
    if (payload[key] !== undefined) {
      throw new Error(
        `msg.payload.${key} is retired — Move speaks action-shaped overrides now ` +
        '(altRef for goto, reference for steer; the mask derives from filled fields)'
      );
    }
  }
}

module.exports = {
  ALT_REF_FRAME,
  MODES,
  resolveMoveAction,
  frameForAltRef,
  frameForReference,
  deriveSteerMode,
  refuseRetiredOverrides,
};
