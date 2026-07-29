'use strict';

/**
 * Tests for lib/delivery — the shared chain-model helpers (DESIGN.md §9).
 *
 * Coverage:
 *   - makeStatusRecord: plain object shape and field preservation
 *   - shouldSuppress: exact `=== false` semantics
 *   - capBadge: length capping, ellipsis, exactly-24 pass-through
 *   - reportDoneError: one Catch path only (`done(err)` or `node.error`)
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
  reportDoneError,
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
// reportDoneError
// ---------------------------------------------------------------------------

test('reportDoneError: uses done(err) without also calling node.error', () => {
  const err = new Error('boom');
  const msg = { payload: 1 };
  let doneArg;
  let nodeErrorCalled = false;
  const node = {
    error() {
      nodeErrorCalled = true;
    },
  };

  reportDoneError(node, err, msg, (received) => {
    doneArg = received;
  });

  assert.equal(doneArg, err);
  assert.equal(nodeErrorCalled, false);
});

test('reportDoneError: falls back to node.error when done is unavailable', () => {
  const err = new Error('boom');
  const msg = { payload: 1 };
  let nodeErrorArgs;
  const node = {
    error(...args) {
      nodeErrorArgs = args;
    },
  };

  reportDoneError(node, err, msg);

  assert.deepEqual(nodeErrorArgs, [err, msg]);
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

test('TIER.SEND_CONFIRM is the string "sendConfirm"', () => {
  assert.equal(TIER.SEND_CONFIRM, 'sendConfirm');
});

test('TIER.SEND_AWAIT is the string "sendAwait"', () => {
  assert.equal(TIER.SEND_AWAIT, 'sendAwait');
});

// ---------------------------------------------------------------------------
// BADGE_MAX
// ---------------------------------------------------------------------------

test('BADGE_MAX is 24', () => {
  assert.equal(BADGE_MAX, 24);
});
