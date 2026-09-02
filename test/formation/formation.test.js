'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { formationTargets } = require('../../lib/formation');

const EARTH_RADIUS_M = 6378137;

/**
 * The NED offset of every slot as formationTargets places it, recovered from
 * the lat/lon/alt it emits at an equatorial, sea-level anchor: at lat 0 the
 * flat-earth deltas invert exactly (north = lat·R, east = lon·R, down = −alt).
 * Slot i is sysid i+1. At heading 0 and pitch 0, north is body-forward and
 * east is body-right, so the shape geometry reads off directly.
 */
function placed(shape, count, spacing, headingDeg = 0, pitchDeg = 0) {
  const sysids = Array.from({ length: count }, (_, i) => i + 1);
  return formationTargets({ shape, spacing, anchor: { lat: 0, lon: 0, alt: 0 }, headingDeg, pitchDeg, sysids })
    .map((t) => ({
      north: (t.lat * Math.PI / 180) * EARTH_RADIUS_M,
      east: (t.lon * Math.PI / 180) * EARTH_RADIUS_M,
      down: -t.alt,
    }));
}

/** The lat/lon round trip costs nanometres; compare axes to a micrometre. */
function near(actual, expected, label) {
  for (const axis of ['north', 'east', 'down']) {
    approx(actual[axis], expected[axis], 1e-6, `${label || ''} ${axis}`.trim());
  }
}

const SHAPES = ['line', 'column', 'grid', 'wedge', 'circle', 'sphere'];

function approx(actual, expected, epsilon, label) {
  assert.ok(Math.abs(actual - expected) < epsilon, `${label}: ${actual} !== ${expected} ± ${epsilon}`);
}

test('every shape puts slot 0 at the origin', () => {
  for (const shape of SHAPES) {
    const [origin] = placed(shape, 5, 8);
    near(origin, { north: 0, east: 0, down: 0 }, shape);
  }
});

test('line fans abreast: slot 1 right, slot 2 left, ranks growing outward', () => {
  const offsets = placed('line', 5, 10);
  near(offsets[1], { north: 0, east: 10, down: 0 });
  near(offsets[2], { north: 0, east: -10, down: 0 });
  near(offsets[3], { north: 0, east: 20, down: 0 });
  near(offsets[4], { north: 0, east: -20, down: 0 });
});

test('column trails single file strictly behind the reference', () => {
  const offsets = placed('column', 4, 5);
  offsets.forEach((offset, index) => near(offset, { north: -index * 5, east: 0, down: 0 }, `slot ${index}`));
});

test('wedge arms trail behind the apex, alternating sides by rank', () => {
  const offsets = placed('wedge', 5, 10);
  near(offsets[1], { north: -10, east: 10, down: 0 });
  near(offsets[2], { north: -10, east: -10, down: 0 });
  near(offsets[3], { north: -20, east: 20, down: 0 });
  near(offsets[4], { north: -20, east: -20, down: 0 });
});

test('circle centers slot 0 and spreads the rest evenly on a ring of radius=spacing', () => {
  const offsets = placed('circle', 5, 12);
  near(offsets[0], { north: 0, east: 0, down: 0 });
  // First follower sits dead ahead; the rest step around by 2π/4.
  near(offsets[1], { north: 12, east: 0, down: 0 });
  for (let i = 1; i < 5; i += 1) {
    approx(Math.hypot(offsets[i].north, offsets[i].east), 12, 1e-9, `radius of slot ${i}`);
    const theta = (2 * Math.PI * (i - 1)) / 4;
    approx(offsets[i].north, 12 * Math.cos(theta), 1e-9, `forward of slot ${i}`);
    approx(offsets[i].east, 12 * Math.sin(theta), 1e-9, `right of slot ${i}`);
  }
});

test('grid fills a row-major block behind the anchor, centered left-right', () => {
  // 4 followers -> 2 columns: rows of 2, each a full spacing behind the last.
  const offsets = placed('grid', 5, 10);
  near(offsets[1], { north: -10, east: -5, down: 0 });
  near(offsets[2], { north: -10, east: 5, down: 0 });
  near(offsets[3], { north: -20, east: -5, down: 0 });
  near(offsets[4], { north: -20, east: 5, down: 0 });
  for (const o of offsets.slice(1)) assert.ok(o.north < 0, 'rows are behind the anchor');
});

test('heading 0 leaves body-forward on north and body-right on east', () => {
  // wedge slot 1: forward −10, right +10.
  near(placed('wedge', 2, 10)[1], { north: -10, east: 10, down: 0 });
});

test('heading 90 turns body-forward onto east and body-right onto south', () => {
  // line slot 1 is body-right 4 → south 4; circle slot 1 is body-forward 3 → east 3.
  near(placed('line', 2, 4, 90)[1], { north: -4, east: 0, down: 0 }, 'right → south');
  near(placed('circle', 2, 3, 90)[1], { north: 0, east: 3, down: 0 }, 'forward → east');
});

test('formationTargets places a line east-west of the anchor by the flat-earth deltas', () => {
  // Hand-computed at lat 47.397742: 10 m east = 10/(R·cos lat)·180/π degrees
  // of longitude = 1.32709215145987e-4 with R = 6378137.
  const targets = formationTargets({
    shape: 'line',
    spacing: 10,
    anchor: { lat: 47.397742, lon: 8.545594, alt: 30 },
    headingDeg: 0,
    sysids: [1, 2, 3], pitchDeg: 0,
  });
  const dLon = 1.32709215145987e-4;
  assert.deepEqual(targets[0], { sysid: 1, lat: 47.397742, lon: 8.545594, alt: 30 });
  approx(targets[1].lon, 8.545594 + dLon, 1e-12, 'slot 1 lon');
  approx(targets[2].lon, 8.545594 - dLon, 1e-12, 'slot 2 lon');
  assert.equal(targets[1].lat, 47.397742);
  assert.equal(targets[2].lat, 47.397742);
});

test('formationTargets trails a column south of a north-facing anchor', () => {
  // Hand-computed: 10 m north = 10/R·180/π = 8.98315284119521e-5 degrees of
  // latitude; the trailing slot is 10 m *behind*, so its latitude is lower.
  const targets = formationTargets({
    shape: 'column',
    spacing: 10,
    anchor: { lat: 47.397742, lon: 8.545594, alt: 30 },
    headingDeg: 0,
    sysids: [1, 2], pitchDeg: 0,
  });
  approx(targets[1].lat, 47.397742 - 8.98315284119521e-5, 1e-12, 'slot 1 lat');
  approx(targets[1].lon, 8.545594, 1e-12, 'slot 1 lon');
});

test('planar shapes give every vehicle the anchor altitude', () => {
  for (const shape of ['line', 'column', 'grid', 'wedge', 'circle']) {
    const targets = formationTargets({
      shape,
      spacing: 15,
      anchor: { lat: -35.363262, lon: 149.165237, alt: 587.5 },
      headingDeg: 45,
      sysids: [1, 2, 3, 4], pitchDeg: 0,
    });
    for (const t of targets) assert.equal(t.alt, 587.5, shape);
  }
});

test('sphere puts slot 0 at the origin and followers on a radius=spacing shell', () => {
  const offsets = placed('sphere', 5, 12);
  near(offsets[0], { north: 0, east: 0, down: 0 });
  for (let i = 1; i < 5; i += 1) {
    const r = Math.hypot(offsets[i].north, offsets[i].east, offsets[i].down);
    approx(r, 12, 1e-9, `sphere radius of slot ${i}`);
  }
  // At least one follower is above the equator and one below (varying altitude).
  const downs = offsets.slice(1).map((o) => o.down);
  assert.ok(downs.some((d) => d < 0), 'some followers above the anchor (negative down)');
  assert.ok(downs.some((d) => d > 0), 'some followers below the anchor (positive down)');
});

test('sphere formationTargets vary altitude from the anchor', () => {
  const targets = formationTargets({
    shape: 'sphere',
    spacing: 12,
    anchor: { lat: -35.363262, lon: 149.165237, alt: 40 },
    headingDeg: 0,
    sysids: [1, 2, 3, 4, 5], pitchDeg: 0,
  });
  assert.equal(targets[0].alt, 40, 'slot 0 stays on the anchor');
  const alts = targets.slice(1).map((t) => t.alt);
  assert.ok(alts.some((a) => a > 40) && alts.some((a) => a < 40), 'followers span above and below');
});

test('pitch 90 tumbles body-forward onto −down (nose-up around +Y)', () => {
  // circle slot 1 is body-forward 10 → 10 m above the anchor.
  near(placed('circle', 2, 10, 0, 90)[1], { north: 0, east: 0, down: -10 });
});

test('formationTargets pitchDeg tumbles a column without changing lateral separation', () => {
  // Column slot 1 is 10 m behind (forward −10). Nose-up pitch +90 → that
  // offset becomes down +10, so the follower sits 10 m below the anchor.
  const targets = formationTargets({
    shape: 'column',
    spacing: 10,
    anchor: { lat: 47.397742, lon: 8.545594, alt: 30 },
    headingDeg: 0,
    pitchDeg: 90,
    sysids: [1, 2],
  });
  approx(targets[1].lat, 47.397742, 1e-12, 'slot 1 lat');
  approx(targets[1].lon, 8.545594, 1e-12, 'slot 1 lon');
  approx(targets[1].alt, 20, 1e-9, 'slot 1 alt = anchor − (+10)');
});

test('formationTargets rotates the pattern by the heading', () => {
  // Column facing east (heading 90): "behind the anchor" is now west, so the
  // trailing slot moves 10 m west at the same latitude. Same hand-computed
  // longitude delta as the line test.
  const targets = formationTargets({
    shape: 'column',
    spacing: 10,
    anchor: { lat: 47.397742, lon: 8.545594, alt: 30 },
    headingDeg: 90,
    sysids: [1, 2], pitchDeg: 0,
  });
  approx(targets[1].lon, 8.545594 - 1.32709215145987e-4, 1e-12, 'slot 1 lon');
  approx(targets[1].lat, 47.397742, 1e-12, 'slot 1 lat');
});

test('formationTargets dedupes and sorts sysids, coercing numeric strings', () => {
  const targets = formationTargets({
    shape: 'line',
    spacing: 10,
    anchor: { lat: 47.397742, lon: 8.545594, alt: 30 },
    headingDeg: 0,
    sysids: ['5', 3, 5], pitchDeg: 0,
  });
  assert.deepEqual(targets.map((t) => t.sysid), [3, 5]);
});

test('anchor coordinates are coerced, not refused — the editor owns the boxes', () => {
  // The three anchor fields are `required` in the fixed anchor mode
  // (mavlink-formation.html lat/lon/alt), and are the leader's own reported
  // position otherwise. Here they coerce: a blank is Number('') and rides.
  const at0 = formationTargets({
    shape: 'line', spacing: 10, anchor: { lat: '', lon: 8, alt: 30 }, headingDeg: 0, sysids: [1], pitchDeg: 0,
  });
  assert.equal(at0[0].lat, 0, 'a blank latitude is the coercion, not a substituted place');
  const noAlt = formationTargets({
    shape: 'line', spacing: 10, anchor: { lat: 47, lon: 8, alt: undefined }, headingDeg: 0, sysids: [1], pitchDeg: 0,
  });
  assert.ok(Number.isNaN(noAlt[0].alt), 'an absent altitude stays absent, never sea level');
});

test('sysid entries are trusted input: Number() coercion, never a refusal', () => {
  // A non-numeric entry coerces to NaN and flows through — garbage on a
  // trusted surface is the flow author's to fix, not the driver's to refuse.
  const targets = formationTargets({
    shape: 'line',
    spacing: 10,
    anchor: { lat: 47, lon: 8, alt: 30 },
    sysids: [1, 'abc'], pitchDeg: 0,
  });
  assert.equal(targets.length, 2, 'both entries keep their slots');
  assert.equal(targets[0].sysid, 1);
  assert.ok(Number.isNaN(targets[1].sysid), 'the malformed entry coerces to NaN');
  // null takes the defined coercion too: Number(null) is 0.
  const coerced = formationTargets({
    shape: 'line', spacing: 10, anchor: { lat: 47, lon: 8, alt: 30 }, sysids: [1, null], pitchDeg: 0,
  });
  assert.deepEqual(coerced.map((target) => target.sysid), [0, 1]);
});

test('spacing is trusted config: Number() coercion only — the editor validator is the guard', () => {
  // A numeric string behaves as the number it coerces to.
  near(placed('line', 2, '10')[1], { north: 0, east: 10, down: 0 });
  // 0 stacks every slot on the origin and a negative spacing mirrors the
  // pattern — the editor validator (finite, > 0) is the only guard.
  for (const offset of placed('line', 3, 0)) {
    near(offset, { north: 0, east: 0, down: 0 });
  }
  near(placed('line', 3, -5)[1], { north: 0, east: -5, down: 0 });
});

test('an empty sysid list positions nobody', () => {
  const targets = formationTargets({
    shape: 'line', spacing: 10, anchor: { lat: 47, lon: 8, alt: 30 }, sysids: [], pitchDeg: 0,
  });
  assert.deepEqual(targets, [], 'no vehicles, no slots — nothing to refuse');
});

test('an anchor at the pole computes what the maths gives — no refusal of its own', () => {
  // cos(lat) → 0 makes metres east run away in longitude. The editor bounds a
  // typed anchor; a leader's own reported position is measured data (§4). The
  // driver computes and hands the number on.
  const targets = formationTargets({
    shape: 'line', spacing: 10, anchor: { lat: 89.999999, lon: 8, alt: 30 }, sysids: [1, 2], pitchDeg: 0,
  });
  assert.equal(targets.length, 2);
  assert.ok(targets.every((t) => typeof t.lon === 'number'));
});
