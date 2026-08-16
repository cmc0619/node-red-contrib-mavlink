'use strict';

const { isBlank } = require('../addressing/resolve');
const { MAV_FRAME } = require('./frames');

/**
 * Move's operator surface (§6 redesign): the operator picks an intent —
 * Action × Delivery — and the wire follows. The carrier, message name, frame
 * number and mask are code, derived here.
 *
 * - **goto** — one-shot guided goto. Build/Send/Send-and-confirm ride
 *   `MAV_CMD_DO_REPOSITION` (COMMAND_INT); Stream rides
 *   `SET_POSITION_TARGET_GLOBAL_INT` at rate. The altitude reference
 *   (above-home vs MSL) is the only frame choice the operator ever sees.
 * - **steer** — setpoints. The reference picks the axes and the origin (world,
 *   body, or offset-from-here); the type_mask derives from which field groups
 *   are non-blank, so filling fields IS the mode.
 */

/** Actions that ride an acked MAV_CMD rather than a setpoint. */
const COMMAND_ACTIONS = new Set(['turn', 'speed']);

/**
 * Altitude reference → global MAV_FRAME. Terrain is deliberately absent:
 * unmeasured on both stacks (§14).
 *
 * @param {*} value  'home' | 'msl'
 * @returns {number|undefined}
 */
function frameForAltRef(value) {
  switch (value) {
    case 'home': return MAV_FRAME.GLOBAL_RELATIVE_ALT;
    case 'msl': return MAV_FRAME.GLOBAL;
  }
}

/**
 * Steer reference → local MAV_FRAME. World is LOCAL_NED everywhere. Body is
 * firmware-derived, because the two stacks read *different* body frames
 * (measured, §14): ArduPilot treats BODY_OFFSET_NED (9) as the body-axis
 * offset; PX4 ignores 9 and reads BODY_NED (8), velocity-only.
 *
 * Offset is LOCAL_OFFSET_NED (7) on every stack, so unlike body it asks no
 * firmware question: the number does not vary, only whether the vehicle acts
 * on it. ArduCopter, Rover and Sub add the triplet to their current position;
 * ArduPlane accepts *only* this frame and reads only `z`; PX4 is measured
 * inert. The dialog is where PX4 stops being offered the choice, not here.
 *
 * @param {*} value     'world' | 'body' | 'offset'
 * @param {*} firmware  vehicle profile firmware, if any
 * @returns {number|undefined}
 */
function frameForReference(value, firmware) {
  switch (value) {
    case 'world': return MAV_FRAME.LOCAL_NED;
    case 'offset': return MAV_FRAME.LOCAL_OFFSET_NED;
    case 'body':
      switch (firmware) {
        case 'ardupilot': return MAV_FRAME.BODY_OFFSET_NED;
        case 'px4': return MAV_FRAME.BODY_NED;
      }
  }
}

/**
 * Derive the setpoint mode from which field groups carry values — the
 * type_mask is an encoding detail, not a choice. Yaw/yaw-rate ride any mode by
 * presence (maskFor), and alone they are the yaw-only mode.
 *
 * @param {{position: object, velocity: object, accel: object}} groups
 * @returns {string}  a MODES key
 */
function deriveSteerMode(groups) {
  // Steer is local by construction, so only the local triplet counts as a
  // group member: a node switched from Go to keeps its hidden lat/lon/alt
  // serialized, and positionFrom carries both families.
  const has = (obj) => obj && ['north', 'east', 'up'].some((k) => !isBlank(obj[k]));
  const name = [
    has(groups.position) && 'position',
    has(groups.velocity) && 'velocity',
    has(groups.accel) && 'acceleration',
  ].filter(Boolean).join('-');
  // Yaw, yaw rate, or nothing at all: the all-ignore packet is the honest
  // encoding of "commanded nothing".
  return name || 'yaw-only';
}

module.exports = {
  COMMAND_ACTIONS,
  frameForAltRef,
  frameForReference,
  deriveSteerMode,
};
