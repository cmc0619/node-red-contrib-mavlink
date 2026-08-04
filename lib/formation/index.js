'use strict';

/**
 * Formation geometry — pure math for the formation node. Given a shape, a
 * spacing, an anchor position, a heading, and a set of vehicle sysids, produce
 * one absolute {lat, lon, alt} target per vehicle, ready to become per-drone
 * MAV_CMD_DO_REPOSITION commands. The node owns telemetry and sending; this
 * module owns only the geometry.
 *
 * Slots are laid out in a body frame — forward (+ahead) / right (+starboard) /
 * down — then rotated by the heading so "behind the anchor" stays behind as it
 * turns, and finally applied to the anchor with the standard flat-earth
 * (equirectangular) approximation, which is accurate to well under 1% for the
 * meters-to-kilometers offsets formations use. Slot 0 always sits on the
 * anchor itself.
 */

/**
 * WGS84 equatorial semi-major axis in meters. Not the mean radius, but the
 * conventional value for small-offset flat-earth math; the ≤0.5% vs the true
 * local radius is negligible for the offsets here.
 */
const EARTH_RADIUS_M = 6378137;

const SHAPES = ['line', 'column', 'grid', 'wedge', 'circle'];

/**
 * Require a finite number, naming the offending field in the error.
 *
 * Strict on type: only numbers and non-empty numeric strings pass. A plain
 * Number() coercion would quietly turn null / '' / booleans / [] into 0 — and
 * a null anchor silently becoming lat 0 / lon 0 ("null island") is exactly the
 * kind of mistake this module exists to prevent.
 *
 * @param {*} value
 * @param {string} name  field name for the error message
 * @returns {number}
 */
function finite(value, name) {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : NaN;
  if (!Number.isFinite(n)) throw new Error(`Formation '${name}' must be a finite number (got ${value}).`);
  return n;
}

/**
 * Body-frame offsets for `count` slots of a given shape, `spacing` meters
 * apart. Slot 0 is always the reference (origin); slots 1..n fan out from it.
 *
 * @param {string} shape    one of {@link SHAPES}
 * @param {number} count    how many slots to generate (>= 0)
 * @param {number} spacing  meters between adjacent slots (or ring radius for a circle)
 * @returns {Array<{forward: number, right: number, down: number}>}
 */
function slotOffsets(shape, count, spacing) {
  const s = finite(spacing, 'spacing');
  // Zero spacing stacks every follower on one point — the same commanded
  // collision assignSlots refuses via duplicate slots. Negative would
  // silently mirror the pattern.
  if (s <= 0) throw new Error(`Formation 'spacing' must be greater than 0 (got ${spacing}).`);
  const n = Math.max(0, Math.trunc(count));
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
    default:
      throw new Error(`Unknown formation shape '${shape}' (expected one of ${SHAPES.join(', ')}).`);
  }
  // Normalize -0 (from `-i * s` at index 0, etc.) to 0 so offsets are clean.
  const nz = (x) => (x === 0 ? 0 : x);
  return out.map((o) => ({ forward: nz(o.forward), right: nz(o.right), down: nz(o.down) }));
}

/**
 * Rotate a body-frame offset (forward/right) into an NED offset (north/east)
 * by a heading in degrees (0 = north, clockwise-positive toward east).
 *
 * @param {{forward?: number, right?: number, down?: number}} offset
 * @param {number} headingDeg
 * @returns {{north: number, east: number, down: number}}
 */
function bodyToNed(offset, headingDeg) {
  const h = (finite(headingDeg, 'heading') * Math.PI) / 180;
  const cos = Math.cos(h);
  const sin = Math.sin(h);
  const fwd = offset.forward || 0;
  const right = offset.right || 0;
  return {
    north: fwd * cos - right * sin,
    east: fwd * sin + right * cos,
    down: offset.down || 0,
  };
}

/**
 * Coerce, validate, dedupe and sort a sysid list. A malformed entry throws —
 * silently filtering it out would fly the formation with one vehicle missing
 * and no one told. Both public entry points (assignSlots, formationTargets)
 * normalize through here; the coercion is idempotent, so an already-normalized
 * list passes through unchanged.
 *
 * @param {Array<number|string>} sysids
 * @returns {number[]} sorted unique finite sysids
 */
function normalizeSysids(sysids) {
  const ids = [...sysids].map((value) => finite(value, 'sysids entry'));
  return [...new Set(ids)].sort((a, b) => a - b);
}

/**
 * Assign each vehicle a deterministic slot index. Sorted-sysid order by
 * default (so slot assignment is stable across snapshots); an explicit
 * `{sysid: index}` map pins known vehicles ("sysid 3 is always left wing"),
 * and any unpinned vehicles fill the lowest free slots in sysid order.
 *
 * @param {Array<number|string>} sysids
 * @param {object} [opts]
 * @param {Object<string, number>} [opts.slotMap]  explicit sysid -> slot index
 * @returns {Map<number, number>} sysid -> slot index
 */
function assignSlots(sysids, opts = {}) {
  const sorted = normalizeSysids(sysids);
  const map = new Map();
  const explicit = opts.slotMap && typeof opts.slotMap === 'object' ? opts.slotMap : null;
  const used = new Set();
  if (explicit) {
    for (const id of sorted) {
      const raw = explicit[id];
      if (raw === undefined) continue;
      const idx = Number(raw);
      if (!Number.isInteger(idx) || idx < 0) {
        throw new Error(`Slot index for sysid ${id} must be a non-negative integer (got ${JSON.stringify(raw)}).`);
      }
      // Two vehicles mapped to the same slot would be commanded to the same
      // position — a collision, not a formation. Fail closed rather than
      // silently stacking them.
      if (used.has(idx)) throw new Error(`Slot index ${idx} is assigned to more than one vehicle.`);
      map.set(id, idx);
      used.add(idx);
    }
  }
  let next = 0;
  for (const id of sorted) {
    if (map.has(id)) continue;
    while (used.has(next)) next += 1;
    map.set(id, next);
    used.add(next);
  }
  return map;
}

/**
 * Build one absolute position target per vehicle from a formation shape.
 *
 * @param {object} opts
 * @param {string} opts.shape           one of {@link SHAPES}
 * @param {number} opts.spacing         meters between slots
 * @param {{lat: number, lon: number, alt: number}} opts.anchor  reference
 *   position (float degrees, alt required — every target inherits it so the
 *   formation is level; a `0` altitude would command a descent to sea level,
 *   so it is not a safe default)
 * @param {number} [opts.headingDeg=0]  rotates the whole pattern
 * @param {Array<number|string>} opts.sysids  vehicles to position
 * @param {Object<string, number>} [opts.slotMap]  explicit slot assignment
 * @returns {Array<{sysid: number, lat: number, lon: number, alt: number}>}
 */
function formationTargets(opts) {
  const { shape, spacing, anchor, headingDeg = 0, sysids, slotMap } = opts;
  if (!anchor || anchor.lat === undefined || anchor.lon === undefined) {
    throw new Error('Formation needs an anchor { lat, lon, alt }.');
  }
  if (anchor.alt === undefined || anchor.alt === null || anchor.alt === '') {
    throw new Error('Formation anchor needs an altitude — a level formation inherits it, and 0 would command a descent to sea level.');
  }
  const lat = finite(anchor.lat, 'anchor.lat');
  const lon = finite(anchor.lon, 'anchor.lon');
  const alt = finite(anchor.alt, 'anchor.alt');
  if (Math.abs(lat) > 89.9) {
    // cos(lat) -> 0: meters east has no meaningful longitude representation.
    throw new Error(`Cannot convert meter offsets near the poles (lat ${lat}).`);
  }
  const ids = normalizeSysids(sysids || []);
  if (!ids.length) throw new Error('Formation needs at least one vehicle sysid.');
  const assign = assignSlots(ids, { slotMap });
  const maxSlot = Math.max(...assign.values());
  const offsets = slotOffsets(shape, maxSlot + 1, spacing);
  const cosLat = Math.cos((lat * Math.PI) / 180);
  return ids.map((id) => {
    const ned = bodyToNed(offsets[assign.get(id)], headingDeg);
    const dLat = (ned.north / EARTH_RADIUS_M) * (180 / Math.PI);
    const dLon = (ned.east / (EARTH_RADIUS_M * cosLat)) * (180 / Math.PI);
    return { sysid: id, lat: lat + dLat, lon: lon + dLon, alt: alt - ned.down };
  });
}

module.exports = {
  SHAPES,
  finite,
  slotOffsets,
  bodyToNed,
  assignSlots,
  formationTargets,
};
