'use strict';

const { isBlank } = require('../addressing/resolve');

/**
 * Move's joystick carrier: `MANUAL_CONTROL` (69).
 *
 * On the roster because it is what QGroundControl's joystick sends, **the** way
 * ArduSub is flown, and one of only two things an Antenna Tracker can be
 * pointed with (§9 roster). It is *not* how a Blimp moves — that claim was on
 * the roster until 2026-08-14 and is refuted at source in §14: Blimp never
 * overrides `handle_manual_control_axes`, whose base body is empty, so the
 * sticks are decoded, counted as a GCS heartbeat, and discarded. Three things
 * make this message unlike every other Move action:
 *
 * 1. **It addresses a system, not a component.** The field is `target` — there
 *    is no `target_component`. Do not invent one; the node hides the compid row
 *    for this action.
 * 2. **Silence is the protocol's stop.** `GCS_MAVLINK_Sub::handle_manual_control_axes`
 *    stamps `last_pilot_input_ms` and the GCS failsafe *disarms* when that stops
 *    updating, so ceasing to transmit is a real stop rather than an
 *    abandonment. No sender-side TTL is invented (§9 ruling 5).
 * 3. **An axis is never centred for you.** The spec normalises all four axes to
 *    [-1000, 1000] with 0 centred, but **ArduSub deviates on `z`**, reading it
 *    as 0..1000 with neutral *500*, so 0 is full reverse vertical thrust
 *    (source-read 2026-08-13, §14). The editor requires all four sticks and
 *    bounds them, including the ArduSub thrust check (`stickValidator`).
 */

/** Wire range of a live axis, per the dialect: normalized to [-1000, 1000]. */
const AXIS_SCALE = 1000;

/**
 * An empty button bitmask. Unlike an axis this is not a substitution: the field
 * is one bit per button, so "no button pressed" has an exact encoding and a
 * blank box leaves nothing unsaid.
 */
const BUTTONS_NONE = 0;

/**
 * Build the MANUAL_CONTROL message.
 *
 * The operator surface is **−1..1 per axis**, the joystick convention, scaled
 * to the wire's ±1000 exactly once here — the same convert-at-encode rule as
 * degE7 and radians. Nothing is clamped: the editor bounds the sticks, and the
 * driver coerces and sends whatever it is handed (§2).
 *
 * @param {object} input
 * @param {*} [input.x]        pitch / forward, −1..1; every axis is required
 * @param {*} [input.y]        roll / right, −1..1
 * @param {*} [input.z]        thrust, −1..1 (see the ArduSub note above)
 * @param {*} [input.r]        yaw / twist, −1..1
 * @param {*} [input.buttons]  button bitmask, 0..65535
 * @param {{sysid: number}} input.target
 * @returns {{name: 'MANUAL_CONTROL', fields: object}}
 */
function buildManualMessage(input) {
  return {
    name: 'MANUAL_CONTROL',
    fields: {
      // The system, not a component — MANUAL_CONTROL has no target_component.
      target: input.target.sysid,
      x: axis(input.x),
      y: axis(input.y),
      z: axis(input.z),
      r: axis(input.r),
      // Blank buttons is 0 — "no button pressed" is a real state a joystick
      // reports every frame, and the bitmask has a bit per button, so an empty
      // mask IS the encoding. Unlike a stick axis, nothing is left unsaid.
      buttons: isBlank(input.buttons) ? BUTTONS_NONE : Number(input.buttons),
    },
  };
}

/**
 * One axis, scaled to the wire's ±1000.
 *
 * @param {*} value  −1..1
 * @returns {number}
 */
function axis(value) {
  return Math.round(Number(value) * AXIS_SCALE);
}


module.exports = {
  buildManualMessage,
};
