'use strict';

/**
 * Completion-condition tests (DESIGN.md §9 "Ack is not completion").
 *
 * Focus: DO_SET_MODE completion reads the custom mode from param 2 (params[1]),
 * matching the MAV_CMD_DO_SET_MODE layout (param1 = base_mode, param2 =
 * custom_mode, param3 = custom_submode). Reading param 3 would compare against
 * the submode and confirm on the wrong field.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { checkCompletion, COMPLETION } = require('../../lib/command');
const { StubPeerTable } = require('../../lib/command/test/stubs/connection');

function peerWithMode(sysid, compid, flightMode) {
  const pt = new StubPeerTable();
  pt.setComponent(sysid, compid, { flightMode });
  return pt;
}

test('DO_SET_MODE completion matches the requested custom mode from param 2 (params[1])', () => {
  // params = [base_mode, custom_mode, submode, 0, 0, 0, 0]
  const params = [1, 4, 0, 0, 0, 0, 0];
  const pt = peerWithMode(3, 1, 4);
  const res = checkCompletion(COMPLETION.SET_MODE, params, pt, 3, 1);
  assert.equal(res.done, true);
});

test('DO_SET_MODE completion stays pending when the active mode differs from param 2', () => {
  const params = [1, 4, 0, 0, 0, 0, 0];
  // Vehicle is in mode 9, not the requested custom mode 4.
  const pt = peerWithMode(3, 1, 9);
  const res = checkCompletion(COMPLETION.SET_MODE, params, pt, 3, 1);
  assert.equal(res.done, false);
});

test('DO_SET_MODE completion matches custom mode 0 when the vehicle is in mode 0', () => {
  // custom_mode 0 is a real mode (ArduPilot STABILIZE); a truthiness test would
  // wrongly report success the moment a peer exists. It must compare against 0.
  const params = [1, 0, 0, 0, 0, 0, 0];
  const pt = peerWithMode(3, 1, 0);
  const res = checkCompletion(COMPLETION.SET_MODE, params, pt, 3, 1);
  assert.equal(res.done, true);
});

test('DO_SET_MODE completion stays pending when custom mode 0 is requested but the vehicle is in another mode', () => {
  const params = [1, 0, 0, 0, 0, 0, 0];
  const pt = peerWithMode(3, 1, 5);
  const res = checkCompletion(COMPLETION.SET_MODE, params, pt, 3, 1);
  assert.equal(res.done, false);
});
