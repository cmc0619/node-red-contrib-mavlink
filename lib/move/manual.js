'use strict';

const { isBlank } = require('../addressing/resolve');
const { numberOr } = require('./frames');

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
 * 3. **A blank axis is disabled, not centred** — see below. This is the whole
 *    safety story of the module.
 */

/**
 * The dialect's own "this axis is invalid" sentinel: *"A value of INT16_MAX
 * indicates that this axis is invalid."* Every axis carries it.
 *
 * A blank axis therefore encodes INT16_MAX rather than 0, and that choice is
 * load-bearing rather than tidy. The spec normalises all four axes to
 * [-1000, 1000] with 0 centred — but **ArduSub deviates on `z`**, reading it as
 * 0..1000 with neutral *500*, so 0 is full reverse vertical thrust (source-read
 * 2026-08-13, recorded in §14). A node that helpfully centred untouched axes at
 * 0 would command a Sub to dive at full thrust the moment an operator sent
 * sticks for yaw alone.
 *
 * Sending "invalid" instead sidesteps the disagreement entirely: an axis the
 * operator did not touch is not commanded at all, on any firmware, and no
 * per-family axis map has to be guessed at. The deviation itself stays
 * documentation (§9: the driver does not editorialise) until the rig measures
 * it — a family-dependent map is exactly the unmeasured guess that doctrine
 * keeps off the surface.
 */
const AXIS_INVALID = 32767;

/** Wire range of a live axis, per the dialect: normalized to [-1000, 1000]. */
const AXIS_SCALE = 1000;

/**
 * Build the MANUAL_CONTROL message.
 *
 * The operator surface is **−1..1 per axis**, the joystick convention, scaled
 * to the wire's ±1000 exactly once here — the same convert-at-encode rule as
 * degE7 and radians. Nothing is clamped: the editor bounds the sticks, and the
 * driver coerces and sends whatever it is handed (§2).
 *
 * @param {object} input
 * @param {*} [input.x]        pitch / forward, −1..1; blank = axis disabled
 * @param {*} [input.y]        roll / right, −1..1
 * @param {*} [input.z]        thrust, −1..1 (see AXIS_INVALID on ArduSub)
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
      // reports every frame, unlike a blank axis, which is an axis the
      // operator is not driving at all.
      buttons: numberOr(input.buttons, 0),
    },
  };
}

/**
 * One axis: blank disables it, a value scales to the wire's ±1000.
 *
 * @param {*} value  −1..1, or blank
 * @returns {number}
 */
function axis(value) {
  if (isBlank(value)) return AXIS_INVALID;
  // The blank arm above owns the sentinel, so numberOr's fallback never fires
  // here — it is used for its shared non-numeric refusal (./frames.js).
  return Math.round(numberOr(value, 0) * AXIS_SCALE);
}


module.exports = {
  AXIS_INVALID,
  AXIS_SCALE,
  buildManualMessage,
};
