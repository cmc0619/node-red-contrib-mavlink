'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildRepositionMessage } = require('../../lib/move');

const target = { sysid: 5, compid: 1 };
const goodPosition = { lat: 47.1234567, lon: 8.5, alt: 25 };

/** A valid reposition input; override per test. */
function input(overrides = {}) {
  return {
    mode: 'position',
    frame: 3,
    target,
    position: goodPosition,
    ...overrides,
  };
}



test('reposition refusal matrix: setpoint modes refuse with named errors', () => {
  // Reposition implies position semantics — every setpoint-only mode refuses,
  // and an unknown mode (force included: removed, not aliased) still throws
  // through the shared vocabulary.
  for (const mode of ['velocity', 'position-velocity', 'acceleration', 'yaw-only']) {
    assert.throws(
      () => buildRepositionMessage(input({ mode })),
      /Move reposition is position-only/,
      `mode ${mode} must refuse`
    );
  }
  assert.throws(() => buildRepositionMessage(input({ mode: 'force' })), /unknown Move mode/);
});

test('reposition refusal matrix: local frames refuse naming the frame; retired frames refuse upstream', () => {
  // LOCAL_OFFSET_NED (7) joined this list when it came back as Steer's Offset
  // reference (2026-08-13): it is a known setpoint frame now, so reposition
  // refuses it *by name* like the other local frames rather than through the
  // generic vocabulary error. DO_REPOSITION carries a global location; an
  // offset-from-here has no meaning on that carrier.
  for (const [frame, name] of [
    [1, 'LOCAL_NED'],
    [7, 'LOCAL_OFFSET_NED'],
    [8, 'BODY_NED'],
    [9, 'BODY_OFFSET_NED'],
  ]) {
    assert.throws(
      () => buildRepositionMessage(input({ frame })),
      new RegExp(`GLOBAL and GLOBAL_RELATIVE_ALT — ${name}`),
      `frame ${name} must refuse`
    );
  }
  // Terrain (10) is still outside the vocabulary entirely — unmeasured datum
  // — so it refuses upstream with the simplified numeric-only frame error.
  for (const frame of [10]) {
    assert.throws(
      () => buildRepositionMessage(input({ frame })),
      /not a SET_POSITION_TARGET frame/,
      `frame ${frame} must refuse`
    );
  }
  // A blank frame craters before the carrier ever sees it. It used to resolve
  // to LOCAL_NED and refuse *that* — which read as fail-closed but was the
  // swallow in disguise: on the Stream carrier the same blank produced a
  // perfectly legal SET_POSITION_TARGET_LOCAL_NED at the EKF origin instead of
  // an error. One error for one cause, at the point the frame went missing.
  assert.throws(
    () => buildRepositionMessage(input({ frame: undefined })),
    /Move needs a frame/,
    'a blank frame names the omission, not a frame nobody chose'
  );
  assert.throws(() => buildRepositionMessage(input({ frame: 'WARP' })), /not a SET_POSITION_TARGET frame/);
});



