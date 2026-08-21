'use strict';

/**
 * Tests for lib/delivery — the shared chain-model helpers (DESIGN.md §9).
 *
 * Coverage:
 *   - makeStatusRecord: plain object shape, node stamping, field preservation
 *   - shouldSuppress: exact `=== false` semantics
 *   - capBadge: length capping, ellipsis, exactly-24 pass-through
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BADGE_MAX,
  makeStatusRecord,
  shouldSuppress,
  capBadge,
} = require('../../lib/delivery');

// ---------------------------------------------------------------------------
// makeStatusRecord
// ---------------------------------------------------------------------------

test('makeStatusRecord: returns a plain object stamping node plus the provided fields', () => {
  const sr = makeStatusRecord('mavlink-out', { result: 'ok', reason: 'accepted' });
  assert.deepEqual(sr, { node: 'mavlink-out', result: 'ok', reason: 'accepted' });
});

test('makeStatusRecord: preserves all provided fields', () => {
  const sr = makeStatusRecord('mavlink-out', { result: 'failed', reason: 'timeout', retries: 3 });
  assert.equal(sr.node, 'mavlink-out');
  assert.equal(sr.result, 'failed');
  assert.equal(sr.reason, 'timeout');
  assert.equal(sr.retries, 3);
});

test('makeStatusRecord: contains only node plus the provided keys', () => {
  const sr = makeStatusRecord('mavlink-out', { result: 'ok' });
  assert.deepEqual(Object.keys(sr).sort(), ['node', 'result']);
});

test('makeStatusRecord: the node stamp beats a stray fields.node', () => {
  // A record rebuilt from another record's fields must not smuggle the other
  // node's identity — the stamp is the one owner of `node`.
  const sr = makeStatusRecord('mavlink-formation', { result: 'ok', node: 'mavlink-fanout' });
  assert.equal(sr.node, 'mavlink-formation');
});

test('makeStatusRecord: two calls produce independent objects', () => {
  const first = makeStatusRecord('mavlink-out', { result: 'a' });
  const second = makeStatusRecord('mavlink-out', { result: 'b' });
  assert.equal(first.result, 'a');
  assert.equal(second.result, 'b');
  assert.notEqual(first, second);
});

// ---------------------------------------------------------------------------
// shouldSuppress
// ---------------------------------------------------------------------------

test('shouldSuppress: true when payload is exactly false', () => {
  assert.equal(shouldSuppress({ payload: false }), true);
});

test('shouldSuppress: false when payload is null', () => {
  assert.equal(shouldSuppress({ payload: null }), false);
});

test('shouldSuppress: false when payload is undefined', () => {
  assert.equal(shouldSuppress({ payload: undefined }), false);
});

test('shouldSuppress: false when payload is 0', () => {
  assert.equal(shouldSuppress({ payload: 0 }), false);
});

test('shouldSuppress: false when payload is empty string', () => {
  assert.equal(shouldSuppress({ payload: '' }), false);
});

test('shouldSuppress: false for a normal object payload', () => {
  assert.equal(shouldSuppress({ payload: { type: 6 } }), false);
});

// capBadge
// ---------------------------------------------------------------------------

test('capBadge: passes through text shorter than BADGE_MAX', () => {
  const short = 'hello';
  assert.equal(capBadge(short), short);
});

test('capBadge: passes through text of exactly BADGE_MAX characters', () => {
  const exact = 'a'.repeat(BADGE_MAX);
  assert.equal(capBadge(exact), exact);
  assert.equal(capBadge(exact).length, BADGE_MAX);
});

test('capBadge: truncates text longer than BADGE_MAX and appends ellipsis', () => {
  const long = 'a'.repeat(BADGE_MAX + 10);
  const capped = capBadge(long);
  assert.equal(capped.length, BADGE_MAX);
  assert.ok(capped.endsWith('\u2026'), 'must end with single-glyph ellipsis');
});

test('capBadge: the last character of a capped string is the ellipsis glyph', () => {
  const long = 'HEARTBEAT_LONG_NAME_EXCEEDING_CAP';
  const capped = capBadge(long);
  assert.equal(capped[capped.length - 1], '\u2026');
});

test('capBadge: coerces non-string input via String()', () => {
  const result = capBadge(12345);
  assert.equal(result, '12345');
});

// ---------------------------------------------------------------------------
// BADGE_MAX
// ---------------------------------------------------------------------------

test('BADGE_MAX is 24', () => {
  assert.equal(BADGE_MAX, 24);
});
