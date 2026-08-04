'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { SHAPES, slotOffsets, bodyToNed, assignSlots, formationTargets } = require('../../lib/formation');

function approx(actual, expected, epsilon, label) {
  assert.ok(Math.abs(actual - expected) < epsilon, `${label}: ${actual} !== ${expected} ± ${epsilon}`);
}

test('every shape puts slot 0 exactly at the origin, with no -0', () => {
  for (const shape of SHAPES) {
    const [origin] = slotOffsets(shape, 5, 8);
    assert.deepEqual(origin, { forward: 0, right: 0, down: 0 }, shape);
    assert.ok(Object.is(origin.forward, 0) && Object.is(origin.right, 0) && Object.is(origin.down, 0), shape);
  }
});

test('line fans abreast: slot 1 right, slot 2 left, ranks growing outward', () => {
  const offsets = slotOffsets('line', 5, 10);
  assert.deepEqual(offsets[1], { forward: 0, right: 10, down: 0 });
  assert.deepEqual(offsets[2], { forward: 0, right: -10, down: 0 });
  assert.deepEqual(offsets[3], { forward: 0, right: 20, down: 0 });
  assert.deepEqual(offsets[4], { forward: 0, right: -20, down: 0 });
});

test('column trails single file strictly behind the reference', () => {
  const offsets = slotOffsets('column', 4, 5);
  assert.deepEqual(offsets, [
    { forward: 0, right: 0, down: 0 },
    { forward: -5, right: 0, down: 0 },
    { forward: -10, right: 0, down: 0 },
    { forward: -15, right: 0, down: 0 },
  ]);
});

test('wedge arms trail behind the apex, alternating sides by rank', () => {
  const offsets = slotOffsets('wedge', 5, 10);
  assert.deepEqual(offsets[1], { forward: -10, right: 10, down: 0 });
  assert.deepEqual(offsets[2], { forward: -10, right: -10, down: 0 });
  assert.deepEqual(offsets[3], { forward: -20, right: 20, down: 0 });
  assert.deepEqual(offsets[4], { forward: -20, right: -20, down: 0 });
});

test('circle centers slot 0 and spreads the rest evenly on a ring of radius=spacing', () => {
  const offsets = slotOffsets('circle', 5, 12);
  assert.deepEqual(offsets[0], { forward: 0, right: 0, down: 0 });
  // First follower sits dead ahead; the rest step around by 2π/4.
  assert.deepEqual(offsets[1], { forward: 12, right: 0, down: 0 });
  for (let i = 1; i < 5; i += 1) {
    approx(Math.hypot(offsets[i].forward, offsets[i].right), 12, 1e-9, `radius of slot ${i}`);
    const theta = (2 * Math.PI * (i - 1)) / 4;
    approx(offsets[i].forward, 12 * Math.cos(theta), 1e-9, `forward of slot ${i}`);
    approx(offsets[i].right, 12 * Math.sin(theta), 1e-9, `right of slot ${i}`);
  }
});

test('grid fills a row-major block behind the anchor, centered left-right', () => {
  // 4 followers -> 2 columns: rows of 2, each a full spacing behind the last.
  const offsets = slotOffsets('grid', 5, 10);
  assert.deepEqual(offsets[1], { forward: -10, right: -5, down: 0 });
  assert.deepEqual(offsets[2], { forward: -10, right: 5, down: 0 });
  assert.deepEqual(offsets[3], { forward: -20, right: -5, down: 0 });
  assert.deepEqual(offsets[4], { forward: -20, right: 5, down: 0 });
  for (const o of offsets.slice(1)) assert.ok(o.forward < 0, 'rows are behind the anchor');
});

test('bodyToNed at heading 0 maps forward to north and right to east', () => {
  assert.deepEqual(bodyToNed({ forward: 3, right: 4, down: 5 }, 0), { north: 3, east: 4, down: 5 });
});

test('bodyToNed at heading 90 maps forward to east and right to south', () => {
  const ned = bodyToNed({ forward: 3, right: 4 }, 90);
  approx(ned.north, -4, 1e-9, 'north');
  approx(ned.east, 3, 1e-9, 'east');
  assert.equal(ned.down, 0);
});

test('assignSlots auto-fills in stable sorted-sysid order', () => {
  const map = assignSlots([7, 3, 5]);
  assert.deepEqual([...map], [[3, 0], [5, 1], [7, 2]]);
});

test('assignSlots honors explicit pins and fills the unpinned into the lowest free slots', () => {
  const map = assignSlots([7, 3, 5], { slotMap: { 5: 0 } });
  assert.equal(map.get(5), 0);
  assert.equal(map.get(3), 1);
  assert.equal(map.get(7), 2);
});

test('assignSlots refuses two vehicles pinned to one slot', () => {
  assert.throws(() => assignSlots([3, 5], { slotMap: { 3: 1, 5: 1 } }), /more than one vehicle/);
});

test('assignSlots refuses non-integer and negative slot indices', () => {
  assert.throws(() => assignSlots([3], { slotMap: { 3: 1.5 } }), /non-negative integer/);
  assert.throws(() => assignSlots([3], { slotMap: { 3: -1 } }), /non-negative integer/);
});

test('formationTargets places a line east-west of the anchor by the flat-earth deltas', () => {
  // Hand-computed at lat 47.397742: 10 m east = 10/(R·cos lat)·180/π degrees
  // of longitude = 1.32709215145987e-4 with R = 6378137.
  const targets = formationTargets({
    shape: 'line',
    spacing: 10,
    anchor: { lat: 47.397742, lon: 8.545594, alt: 30 },
    sysids: [1, 2, 3],
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
    sysids: [1, 2],
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
      sysids: [1, 2, 3, 4],
    });
    for (const t of targets) assert.equal(t.alt, 587.5, shape);
  }
});

test('sphere puts slot 0 at the origin and followers on a radius=spacing shell', () => {
  const offsets = slotOffsets('sphere', 5, 12);
  assert.deepEqual(offsets[0], { forward: 0, right: 0, down: 0 });
  for (let i = 1; i < 5; i += 1) {
    const r = Math.hypot(offsets[i].forward, offsets[i].right, offsets[i].down);
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
    sysids: [1, 2, 3, 4, 5],
  });
  assert.equal(targets[0].alt, 40, 'slot 0 stays on the anchor');
  const alts = targets.slice(1).map((t) => t.alt);
  assert.ok(alts.some((a) => a > 40) && alts.some((a) => a < 40), 'followers span above and below');
});

test('bodyToNed pitch 90 maps forward to down (tumble around +Y)', () => {
  const ned = bodyToNed({ forward: 10, right: 0, down: 0 }, 0, 90);
  approx(ned.north, 0, 1e-9, 'north');
  approx(ned.east, 0, 1e-9, 'east');
  approx(ned.down, 10, 1e-9, 'down');
});

test('formationTargets pitchDeg tumbles a column without changing lateral separation', () => {
  // Column slot 1 is 10 m behind (forward −10). Pitch +90 → that offset becomes
  // down −10, so the follower sits 10 m above the anchor at the same lat/lon.
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
  approx(targets[1].alt, 40, 1e-9, 'slot 1 alt = anchor − (−10)');
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
    sysids: [1, 2],
  });
  approx(targets[1].lon, 8.545594 - 1.32709215145987e-4, 1e-12, 'slot 1 lon');
  approx(targets[1].lat, 47.397742, 1e-12, 'slot 1 lat');
});

test('formationTargets dedupes and sorts sysids, coercing numeric strings', () => {
  const targets = formationTargets({
    shape: 'line',
    spacing: 10,
    anchor: { lat: 47.397742, lon: 8.545594, alt: 30 },
    sysids: ['5', 3, 5],
  });
  assert.deepEqual(targets.map((t) => t.sysid), [3, 5]);
});

test('formationTargets refuses a missing anchor altitude rather than defaulting to sea level', () => {
  for (const alt of [undefined, null, '']) {
    assert.throws(
      () => formationTargets({ shape: 'line', spacing: 10, anchor: { lat: 47, lon: 8, alt }, sysids: [1] }),
      /descent to sea level/
    );
  }
});

test('formationTargets refuses a malformed sysid instead of silently omitting the vehicle', () => {
  assert.throws(
    () => formationTargets({ shape: 'line', spacing: 10, anchor: { lat: 47, lon: 8, alt: 30 }, sysids: [1, 'abc'] }),
    /sysids entry/
  );
  assert.throws(() => assignSlots([1, null]), /sysids entry/);
});

test('slotOffsets refuses a non-positive spacing — all followers would collide', () => {
  for (const spacing of [0, -5]) {
    assert.throws(() => slotOffsets('line', 3, spacing), /greater than 0/);
  }
});

test('formationTargets refuses an empty sysid list', () => {
  assert.throws(
    () => formationTargets({ shape: 'line', spacing: 10, anchor: { lat: 47, lon: 8, alt: 30 }, sysids: [] }),
    /at least one vehicle sysid/
  );
});

test('formationTargets refuses an anchor near the poles', () => {
  assert.throws(
    () => formationTargets({ shape: 'line', spacing: 10, anchor: { lat: 89.95, lon: 8, alt: 30 }, sysids: [1] }),
    /poles/
  );
});

test('formationTargets refuses an unknown shape', () => {
  assert.throws(
    () => formationTargets({ shape: 'diamond', spacing: 10, anchor: { lat: 47, lon: 8, alt: 30 }, sysids: [1] }),
    /Unknown formation shape 'diamond'/
  );
});
