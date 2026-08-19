'use strict';

/**
 * Tests for lib/delivery — the shared chain-model helpers (DESIGN.md §9).
 *
 * Coverage:
 *   - makeStatusRecord: plain object shape and field preservation
 *   - shouldSuppress: exact `=== false` semantics
 *   - capBadge: length capping, ellipsis, exactly-24 pass-through
 *   - TIER constants: values are stable strings
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  TIER,
  BADGE_MAX,
  makeStatusRecord,
  shouldSuppress,
  capBadge,
  failAction,
  failInput,
} = require('../../lib/delivery');

// ---------------------------------------------------------------------------
// makeStatusRecord
// ---------------------------------------------------------------------------

test('makeStatusRecord: returns a plain object with the provided fields', () => {
  const sr = makeStatusRecord({ result: 'ok', reason: 'accepted' });
  assert.deepEqual(sr, { result: 'ok', reason: 'accepted' });
});

test('makeStatusRecord: preserves all provided fields', () => {
  const sr = makeStatusRecord({ result: 'failed', reason: 'timeout', retries: 3 });
  assert.equal(sr.result, 'failed');
  assert.equal(sr.reason, 'timeout');
  assert.equal(sr.retries, 3);
});

test('makeStatusRecord: contains only the provided keys', () => {
  const sr = makeStatusRecord({ result: 'ok' });
  assert.deepEqual(Object.keys(sr), ['result']);
});

test('makeStatusRecord: two calls produce independent objects', () => {
  const a = makeStatusRecord({ result: 'a' });
  const b = makeStatusRecord({ result: 'b' });
  assert.equal(a.result, 'a');
  assert.equal(b.result, 'b');
  assert.notEqual(a, b);
});

// ---------------------------------------------------------------------------
// failAction / failInput — the two terminal-failure paths (§9)
// ---------------------------------------------------------------------------

test('failAction: constant message and a stack collapsed to its header line', () => {
  let caught;
  failAction((err) => { caught = err; });
  assert.ok(caught instanceof Error, 'still an Error, so Catch fires');
  assert.equal(caught.message, 'Action failed');
  // Node-RED's debug renders err.stack verbatim; collapsing it to the header
  // keeps the driver's own call frames out of the sidebar (the rich outcome is
  // on output 1, the node type + hover name say which node).
  assert.equal(caught.stack, 'Error: Action failed');
  assert.ok(!/\n\s+at /.test(caught.stack), 'no driver frames leak to the sidebar');
});

test('failInput: passes the real error through with its stack intact (the loud crash path)', () => {
  const node = { type: 'mavlink-command', status() {} };
  const sent = [];
  let doneErr;
  const original = new Error('boom');
  failInput(node, (m) => sent.push(m), original, (e) => { doneErr = e; });
  assert.equal(doneErr, original, 'the original error reaches done() unchanged');
  assert.ok(/\n\s+at /.test(doneErr.stack), 'a real stack is retained on the crash path');
  assert.equal(sent[0][1].result, 'failed', 'and the record still lands on output 1');
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
// TIER constants
// ---------------------------------------------------------------------------

test('TIER.BUILD is the string "build"', () => {
  assert.equal(TIER.BUILD, 'build');
});

test('TIER.SEND is the string "send"', () => {
  assert.equal(TIER.SEND, 'send');
});

// ---------------------------------------------------------------------------
// BADGE_MAX
// ---------------------------------------------------------------------------

test('BADGE_MAX is 24', () => {
  assert.equal(BADGE_MAX, 24);
});
