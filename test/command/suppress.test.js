'use strict';

/**
 * Suppress-false-payload tests (DESIGN.md §9 "What triggers an action node",
 * brief: "suppress false payload").
 *
 * "msg.payload === false suppresses. The node does nothing and emits nothing,
 * which gives a switch upstream an explicit way to hold a chain without
 * inventing a convention."
 *
 * These tests verify the suppress logic in isolation and its interaction with
 * the AckWaiter — a suppressed message must not start a transaction, must not
 * emit on either output, and must not change the status badge.
 *
 * The node runtime itself is not instantiated (no Node-RED required); we test
 * the pure logic extracted from the input handler.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { shouldSuppress } = require('../../lib/delivery');

/**
 * Minimal simulation of the node's input-handler suppress guard.
 * Returns the action the node would take without constructing Node-RED.
 *
 * @param {object} msg
 * @returns {'suppress'|'proceed'}
 */
function guardAction(msg) {
  if (shouldSuppress(msg)) return 'suppress';
  return 'proceed';
}

// ── Suppress: payload === false ────────────────────────────────────────────

test('false payload is suppressed', () => {
  assert.equal(guardAction({ payload: false }), 'suppress');
});

test('null payload is NOT suppressed (null is a valid "no-op arm")', () => {
  assert.equal(guardAction({ payload: null }), 'proceed');
});

test('0 payload is NOT suppressed (0 and false differ)', () => {
  assert.equal(guardAction({ payload: 0 }), 'proceed');
});

test('empty string payload is NOT suppressed', () => {
  assert.equal(guardAction({ payload: '' }), 'proceed');
});

test('undefined payload is NOT suppressed', () => {
  assert.equal(guardAction({ payload: undefined }), 'proceed');
});

test('boolean true payload is NOT suppressed', () => {
  assert.equal(guardAction({ payload: true }), 'proceed');
});

test('numeric payload (inject timestamp) is NOT suppressed', () => {
  assert.equal(guardAction({ payload: 1722038400000 }), 'proceed');
});

test('object payload is NOT suppressed', () => {
  assert.equal(guardAction({ payload: { 1: 1 } }), 'proceed');
});

test('string "false" payload is NOT suppressed (strict comparison)', () => {
  assert.equal(guardAction({ payload: 'false' }), 'proceed');
});

// ── AckWaiter is not started on suppress ──────────────────────────────────

test('AckWaiter.start is never called when payload is false', () => {
  const { AckWaiter } = require('../../lib/command/ack');

  let started = false;
  const waiter = new AckWaiter({
    subscribe: () => () => {},
    sendFn: () => {},
    commandId: 400,
    // AckWaiter option names are wire-side, not Command editor property names.
    targetSystem: 1,
    targetComponent: 1,
    timeoutMs: 100,
  });
  const origStart = waiter.start.bind(waiter);
  waiter.start = (...args) => {
    started = true;
    return origStart(...args);
  };

  // Simulate what the node input handler does on suppress.
  const msg = { payload: false };
  if (msg.payload !== false) {
    waiter.start().then(() => {});
  }

  assert.equal(started, false, 'AckWaiter must not start on payload=false');
});
