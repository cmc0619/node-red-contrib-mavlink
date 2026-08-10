'use strict';

const { isBlank } = require('../addressing/resolve');

/**
 * Move's shared mode/frame vocabulary and coordinate guards, used by both
 * carriers: the setpoint builder (./index.js) and the reposition command
 * builder (./reposition.js). One vocabulary — config and `msg.payload`
 * overrides speak these names on either carrier (§ "Move setpoint matrix").
 */

/**
 * MAV_FRAME values Move accepts, keyed by the bare member name the editor
 * stores. Global entries are the current spec's vocabulary (§ "Move setpoint
 * matrix", owner-ruled 2026-08-09): common.xml deprecated the *_INT frames in
 * 2024 as synonyms of these.
 */
const MAV_FRAME = {
  GLOBAL: 0,
  LOCAL_NED: 1,
  GLOBAL_RELATIVE_ALT: 3,
  LOCAL_OFFSET_NED: 7,
  BODY_NED: 8,
  BODY_OFFSET_NED: 9,
  GLOBAL_TERRAIN_ALT: 10,
};

/**
 * Deprecated global-frame spellings accepted on input as aliases of the
 * canon. MAVLink's protocol surface, not our vocabulary, so the pre-1.0
 * no-aliases rule (which governs our own renames) does not apply
 * (§ "Move setpoint matrix"). Accepted, never advertised: the unknown-frame
 * error names only the canonical set.
 */
const FRAME_NAME_ALIASES = {
  GLOBAL_INT: MAV_FRAME.GLOBAL,
  GLOBAL_RELATIVE_ALT_INT: MAV_FRAME.GLOBAL_RELATIVE_ALT,
  GLOBAL_TERRAIN_ALT_INT: MAV_FRAME.GLOBAL_TERRAIN_ALT,
};
const FRAME_NUMBER_ALIASES = {
  5: MAV_FRAME.GLOBAL,
  6: MAV_FRAME.GLOBAL_RELATIVE_ALT,
  11: MAV_FRAME.GLOBAL_TERRAIN_ALT,
};

const GLOBAL_FRAMES = new Set([
  MAV_FRAME.GLOBAL,
  MAV_FRAME.GLOBAL_RELATIVE_ALT,
  MAV_FRAME.GLOBAL_TERRAIN_ALT,
]);

/**
 * Move modes: which setpoint vectors the message *uses* (everything else is
 * mask-ignored). One vocabulary — Move, Fan-out, and payload overrides all
 * speak these names (pre-1.0: no aliases, no migrations). The reposition
 * carrier resolves the same names and refuses everything but `position`.
 */
const MODES = {
  position: { position: true },
  velocity: { velocity: true },
  'position-velocity': { position: true, velocity: true },
  acceleration: { accel: true },
  'yaw-only': {},
};

/**
 * Resolve the mode name and numeric frame. `input.frame` is the only spelling:
 * a MAV_FRAME member name, or a raw number.
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

  let frame = input.frame;
  if (isBlank(frame)) {
    frame = MAV_FRAME.LOCAL_NED;
  } else if (typeof frame === 'string' && !/^\d+$/.test(frame)) {
    // Deprecated *_INT names resolve as aliases of the canon; the error for a
    // genuinely unknown frame names only the canonical set.
    if (Object.prototype.hasOwnProperty.call(FRAME_NAME_ALIASES, frame)) {
      frame = FRAME_NAME_ALIASES[frame];
    } else if (Object.prototype.hasOwnProperty.call(MAV_FRAME, frame)) {
      frame = MAV_FRAME[frame];
    } else {
      throw new Error(
        `unknown Move frame ${JSON.stringify(frame)} — expected one of ${Object.keys(MAV_FRAME).join(', ')}`
      );
    }
  } else {
    frame = Number(frame);
    // Deprecated numbers 5/6/11 resolve to the canon like the *_INT names do.
    if (Object.prototype.hasOwnProperty.call(FRAME_NUMBER_ALIASES, frame)) {
      frame = FRAME_NUMBER_ALIASES[frame];
    } else if (!Object.values(MAV_FRAME).includes(frame)) {
      throw new Error(`Move frame ${frame} is not a SET_POSITION_TARGET frame`);
    }
  }
  return { mode, frame };
}

/**
 * Refuse a global position whose lat, lon or alt is blank or out of range —
 * shared by both carriers (§10 "blank coordinates must not become 0,0").
 *
 * @param {{lat:*, lon:*, alt:*}} p
 */
function requireGlobalPosition(p) {
  if (isBlank(p.lat) || isBlank(p.lon) || isBlank(p.alt)) {
    // §10: blank coordinates must not become 0,0 — and a blank alt zero-filled
    // is the same hazard on the vertical axis: 0 m above home (frame 3/6) or
    // 0 m AGL (frame 10/11) is the ground, and 0 m MSL (frame 0/5) may be
    // below it.
    throw new Error('Move global position requires lat, lon and alt (blank coordinates must not become 0,0 at ground level)');
  }
  // The degE7 int32 ceiling is ±214.7°: an out-of-range longitude still
  // scales into a garbage coordinate the vehicle would accept — same hazard
  // class as the blank guards (C4). A non-numeric value passes here as NaN
  // and fails numberOr's finite check downstream.
  const lat = Number(p.lat);
  const lon = Number(p.lon);
  if (lat < -90 || lat > 90) {
    throw new Error(`Move global position lat must be within [-90, 90] degrees, got ${JSON.stringify(p.lat)}`);
  }
  if (lon < -180 || lon > 180) {
    throw new Error(`Move global position lon must be within [-180, 180] degrees, got ${JSON.stringify(p.lon)}`);
  }
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
 * Convert operator-facing degrees to the wire's radians — the yaw twin of the
 * altitude sign flip: exactly once, at encode. `undefined` (blank, already
 * mask-ignored) encodes 0; NaN passes through — NaN floats are legal MAVLink.
 *
 * @param {*} value  degrees, or undefined when mask-ignored
 * @returns {number} radians
 */
function degreesToRadians(value) {
  if (value === undefined) return 0;
  return Number(value) * (Math.PI / 180);
}

module.exports = {
  MAV_FRAME,
  FRAME_NAME_ALIASES,
  FRAME_NUMBER_ALIASES,
  GLOBAL_FRAMES,
  MODES,
  resolveModeAndFrame,
  requireGlobalPosition,
  numberOr,
  degreesToRadians,
};
