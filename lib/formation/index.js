'use strict';

/**
 * Formation geometry — pure math for the formation node. Given a shape, a
 * spacing, an anchor position, a heading, and a set of vehicle sysids, produce
 * one absolute {lat, lon, alt} target per vehicle, ready to become per-drone
 * MAV_CMD_DO_REPOSITION commands. The node owns telemetry and sending; this
 * module owns only the geometry.
 *
 * Slots are laid out in a body frame — forward (+ahead) / right (+starboard) /
 * down — then pitched around body +right (Y) and yawed by heading so "behind
 * the anchor" stays behind as it turns, and finally applied to the anchor with
 * the standard flat-earth (equirectangular) approximation, which is accurate
 * to well under 1% for the meters-to-kilometers offsets formations use. Slot 0
 * always sits on the anchor itself. Planar shapes keep `down: 0` (level
 * formation); `sphere` varies `down` so followers sit at different altitudes.
 */

/**
 * WGS84 equatorial semi-major axis in meters. Not the mean radius, but the
 * conventional value for small-offset flat-earth math; the ≤0.5% vs the true
 * local radius is negligible for the offsets here.
 */
const EARTH_RADIUS_M = 6378137;

/**
 * Body-frame offsets for `count` slots of a given shape, `spacing` meters
 * apart. Slot 0 is always the reference (origin); slots 1..n fan out from it.
 *
 * @param {string} shape
 * @param {number} count    how many slots to generate (>= 0)
 * @param {number} spacing  meters between adjacent slots (ring/sphere radius for circle/sphere)
 * @returns {Array<{forward: number, right: number, down: number}>}
 */
function slotOffsets(shape, count, spacing) {
  // Spacing is trusted input: the editor validator is the guard (finite, > 0)
  // and the runtime takes the defined Number() coercion, never a refusal.
  const s = Number(spacing);
  const n = count;
  const out = [];
  switch (shape) {
    case 'line':
      // Abreast, centered on the reference: 0, +s, -s, +2s, -2s, ...
      for (let i = 0; i < n; i += 1) {
        const rank = Math.ceil(i / 2);
        const side = i % 2 === 1 ? 1 : -1;
        out.push({ forward: 0, right: i === 0 ? 0 : side * rank * s, down: 0 });
      }
      break;
    case 'column':
      // Single file trailing directly behind the reference.
      for (let i = 0; i < n; i += 1) {
        out.push({ forward: -i * s, right: 0, down: 0 });
      }
      break;
    case 'wedge':
      // V: apex on the reference, arms trailing back and out to each side.
      for (let i = 0; i < n; i += 1) {
        const rank = Math.ceil(i / 2);
        const side = i % 2 === 1 ? 1 : -1;
        out.push({ forward: i === 0 ? 0 : -rank * s, right: i === 0 ? 0 : side * rank * s, down: 0 });
      }
      break;
    case 'circle':
      // Reference at the center; the rest evenly spaced on a ring of radius=spacing.
      for (let i = 0; i < n; i += 1) {
        if (i === 0) {
          out.push({ forward: 0, right: 0, down: 0 });
          continue;
        }
        const ring = n - 1;
        const theta = (2 * Math.PI * (i - 1)) / ring;
        out.push({ forward: s * Math.cos(theta), right: s * Math.sin(theta), down: 0 });
      }
      break;
    case 'sphere': {
      // Reference at the center; followers on a Fibonacci sphere of radius=spacing.
      // `down` varies so the formation is truly 3-D (altitude = anchor.alt − down).
      const ring = Math.max(0, n - 1);
      const golden = Math.PI * (3 - Math.sqrt(5));
      for (let i = 0; i < n; i += 1) {
        if (i === 0) {
          out.push({ forward: 0, right: 0, down: 0 });
          continue;
        }
        const idx = i - 1;
        // y from +1 (up) to −1 (down) across the follower set.
        const y = ring === 1 ? 0 : 1 - (idx / (ring - 1)) * 2;
        const radiusAtY = Math.sqrt(Math.max(0, 1 - y * y));
        const theta = golden * idx;
        out.push({
          forward: s * Math.cos(theta) * radiusAtY,
          right: s * Math.sin(theta) * radiusAtY,
          down: -s * y,
        });
      }
      break;
    }
    case 'grid': {
      // Slot 0 stays on the reference (the module contract); the remaining
      // vehicles fill a row-major block trailing behind it, centered
      // left-right. Columns are sized from the follower count so slot 0 is
      // never shifted.
      const cols = Math.max(1, Math.ceil(Math.sqrt(Math.max(0, n - 1))));
      for (let i = 0; i < n; i += 1) {
        if (i === 0) {
          out.push({ forward: 0, right: 0, down: 0 });
          continue;
        }
        const follower = i - 1;
        const row = Math.floor(follower / cols) + 1;
        const col = follower % cols;
        out.push({ forward: -row * s, right: (col - (cols - 1) / 2) * s, down: 0 });
      }
      break;
    }
    default: break; // This space intentionally left blank (§5)
  }
  return out;
}

/**
 * Rotate a body-frame offset into an NED offset.
 *
 * Order: pitch around body +right (Y) first — positive pitch lifts the nose
 * (forward toward −down) — then heading around down (0 = north, clockwise
 * toward east). Pitch is what tumbles a 3-D formation around the Y axis;
 * heading spins the pattern in the horizontal plane.
 *
 * @param {{forward: number, right: number, down: number}} offset  a complete
 *   body-frame triplet, the shape every {@link slotOffsets} slot carries
 * @param {number} headingDeg
 * @param {number} [pitchDeg=0]
 * @returns {{north: number, east: number, down: number}}
 */
function bodyToNed(offset, headingDeg, pitchDeg = 0) {
  const p = (Number(pitchDeg) * Math.PI) / 180;
  const cosP = Math.cos(p);
  const sinP = Math.sin(p);
  const { forward: fwd0, right, down: down0 } = offset;
  // Right-handed rotation about +right: positive pitch = nose up
  // (forward toward −down).
  const fwd = fwd0 * cosP + down0 * sinP;
  const down = -fwd0 * sinP + down0 * cosP;

  const h = (Number(headingDeg) * Math.PI) / 180;
  const cos = Math.cos(h);
  const sin = Math.sin(h);
  return {
    north: fwd * cos - right * sin,
    east: fwd * sin + right * cos,
    down,
  };
}

/**
 * Apply flat-earth (equirectangular) metre offsets to a geodetic position.
 * The one home of the metre→degree conversion: formationTargets uses it for
 * slot positions, and Fan-out's per-member metre offsets (#163) reuse it
 * rather than copying the math.
 *
 * @param {number} lat    degrees
 * @param {number} lon    degrees
 * @param {number} north  metres
 * @param {number} east   metres
 * @returns {{lat: number, lon: number}}
 */
function offsetLatLon(lat, lon, north, east) {
  // cos(lat) → 0 at the poles, where metres east have no meaningful longitude
  // representation and the result runs away. Nothing is refused here: the
  // editor bounds the fixed anchor, and a live leader position is measured
  // data (§4). The number that comes out is the number that goes on the wire.
  const cosLat = Math.cos((lat * Math.PI) / 180);
  return {
    lat: lat + (north / EARTH_RADIUS_M) * (180 / Math.PI),
    lon: lon + (east / (EARTH_RADIUS_M * cosLat)) * (180 / Math.PI),
  };
}

/**
 * Build one absolute position target per vehicle from a formation shape.
 *
 * @param {object} opts
 * @param {string} opts.shape
 * @param {number} opts.spacing         meters between slots
 * @param {{lat: number, lon: number, alt: number}} opts.anchor  reference
 *   position (float degrees, alt required — slot 0 inherits it; followers use
 *   `alt − ned.down`. A `0` altitude would command a descent to sea level, so
 *   it is not a safe default)
 * @param {number} [opts.headingDeg]  yaws the whole pattern (around down)
 * @param {number} [opts.pitchDeg]    pitches the whole pattern (around body Y / right)
 * @param {Array<number|string>} opts.sysids  vehicles to position
 * @returns {Array<{sysid: number, lat: number, lon: number, alt: number}>}
 */
function formationTargets(opts) {
  const { shape, spacing, anchor, headingDeg, pitchDeg, sysids } = opts;
  // The anchor's three fields are required by the editor whenever they are
  // operator-typed (`lat`/`lon`/`alt` under the fixed anchor mode), and are
  // the leader's own reported position otherwise. This coerces and computes.
  const lat = Number(anchor.lat);
  const lon = Number(anchor.lon);
  const alt = Number(anchor.alt);
  const ids = [...new Set([...sysids].map(Number))].sort((a, b) => a - b);
  const offsets = slotOffsets(shape, ids.length, spacing);
  return ids.map((id, index) => {
    const ned = bodyToNed(offsets[index], headingDeg, pitchDeg);
    const at = offsetLatLon(lat, lon, ned.north, ned.east);
    return { sysid: id, lat: at.lat, lon: at.lon, alt: alt - ned.down };
  });
}

module.exports = {
  offsetLatLon,
  slotOffsets,
  bodyToNed,
  formationTargets,
};
