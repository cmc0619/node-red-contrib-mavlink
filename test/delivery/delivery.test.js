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
  makeStatusRecord,
  shouldSuppress,
  capBadge,
} = require('../../lib/delivery');

// §6: the badge cap. Measured here as the number capBadge produces, not
// imported — the runtime exports behavior, not its constants.
const BADGE_MAX = 24;

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

// ---------------------------------------------------------------------------
// completeBuild / onActionInput (review R51/R53)
// ---------------------------------------------------------------------------

const { EventEmitter } = require('node:events');
const { completeBuild, onActionInput } = require('../../lib/delivery');

function actionNode() {
  const node = new EventEmitter();
  node.type = 'mavlink-test';
  node.statuses = [];
  node.status = (s) => node.statuses.push(s);
  return node;
}

test('completeBuild: yellow preview badge, the message on output 0, a built record on output 1', () => {
  const node = actionNode();
  let sent;
  completeBuild(node, (m) => { sent = m; }, { name: 'COMMAND_LONG' }, 'Arm', { command: 'X' });
  assert.deepEqual(sent[0], { payload: { name: 'COMMAND_LONG' } });
  assert.deepEqual(sent[1], { command: 'X', result: 'built', node: 'mavlink-test' });
  assert.equal(node.statuses[0].fill, 'yellow');
  assert.equal(node.statuses[0].text, 'built Arm');
});

test('onActionInput: payload false is suppressed; the handler runs otherwise', () => {
  const node = actionNode();
  const seen = [];
  onActionInput(node, (msg, send, done) => { seen.push(msg); done(); });
  let doneCalls = 0;
  node.emit('input', { payload: false }, () => {}, () => { doneCalls += 1; });
  node.emit('input', { payload: 1 }, () => {}, () => { doneCalls += 1; });
  assert.deepEqual(seen, [{ payload: 1 }]);
  assert.equal(doneCalls, 2);
});

test('onActionInput: a throw and a rejection both settle through failInput', async () => {
  for (const handler of [
    () => { throw new Error('sync'); },
    async () => { throw new Error('async'); },
  ]) {
    const node = actionNode();
    onActionInput(node, handler);
    let sent;
    let doneErr;
    node.emit('input', { payload: {} }, (m) => { sent = m; }, (err) => { doneErr = err; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sent[0], null);
    assert.equal(sent[1].result, 'failed');
    assert.ok(doneErr instanceof Error);
  }
});

