'use strict';

/**
 * Suppress-false-payload tests (DESIGN.md §9 "What triggers an action node",
 * brief: "suppress false payload").
 *
 * "msg.payload === false suppresses. The node does nothing and emits nothing,
 * which gives a switch upstream an explicit way to hold a chain without
 * inventing a convention."
 *
 * These tests verify the suppress predicate in isolation.
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
