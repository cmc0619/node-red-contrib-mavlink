'use strict';

/**
 * Per-type item validators and firmware gating (DESIGN.md §9 "Item validation
 * is per type", §11, §13). Each validator's job is to reject the other
 * families; the firmware gate offers only what a stack carries over this
 * protocol.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  validateItems,
  validateMissionItems,
  validateFenceItems,
  validateRallyItems,
  supportedMissionTypes,
  MISSION_TYPE,
} = require('../../lib/mission');

// Command ids: NAV_WAYPOINT=16, DO_JUMP=177, NAV_FENCE_POLYGON_VERTEX_INCLUSION=5001,
// NAV_RALLY_POINT=5100.

test('mission validator accepts NAV and DO/CONDITION items, rejects fence/rally', () => {
  assert.equal(validateMissionItems([{ command: 16 }, { command: 177 }]).ok, true);

  const fenceInMission = validateMissionItems([{ command: 16 }, { command: 5001 }]);
  assert.equal(fenceInMission.ok, false);
  assert.equal(fenceInMission.seq, 1);

  assert.equal(validateMissionItems([{ command: 5100 }]).ok, false);
});

test('mission validator admits out-of-window commands the firmware may support (issue #90)', () => {
  // PX4 accepts these as mission items (its mavlink_mission.cpp parser), even
  // though they fall outside the old NAV/DO numeric window. The validator no
  // longer second-guesses firmware support — only the fence/rally families are
  // reserved. A firmware that cannot run one of these answers MAV_MISSION_UNSUPPORTED.
  const ids = [
    530,  // SET_CAMERA_MODE
    2000, // IMAGE_START_CAPTURE
    2001, // IMAGE_STOP_CAPTURE
    2500, // VIDEO_START_CAPTURE
    2501, // VIDEO_STOP_CAPTURE
    3000, // DO_VTOL_TRANSITION
  ];
  for (const command of ids) {
    assert.equal(validateMissionItems([{ command }]).ok, true, `command ${command} must upload`);
  }
});

test('fence and rally families are still reserved out of a mission (issue #90 keeps the one real rule)', () => {
  for (const command of [5000, 5001, 5002, 5003, 5004, 5100]) {
    assert.equal(
      validateMissionItems([{ command }]).ok,
      false,
      `fence/rally command ${command} must not upload as a mission item`
    );
  }
});

test('fence validator accepts only NAV_FENCE commands', () => {
  assert.equal(validateFenceItems([{ command: 5001 }, { command: 5004 }]).ok, true);
  // A waypoint is not a fence item.
  assert.equal(validateFenceItems([{ command: 16 }]).ok, false);
  // Nor is a rally point.
  assert.equal(validateFenceItems([{ command: 5100 }]).ok, false);
});

test('the development.xml fence id 5005 is reserved to the fence family', () => {
  // NAV_FENCE_HOME_CIRCLE_INCLUSION (5005) is defined only in development.xml.
  // The family reservation must cover it: it belongs to a fence, not a mission.
  assert.equal(validateFenceItems([{ command: 5005 }]).ok, true);
  assert.equal(validateMissionItems([{ command: 5005 }]).ok, false);
});

test('rally validator accepts only NAV_RALLY_POINT', () => {
  assert.equal(validateRallyItems([{ command: 5100 }]).ok, true);
  assert.equal(validateRallyItems([{ command: 16 }]).ok, false);
  assert.equal(validateRallyItems([{ command: 5001 }]).ok, false);
});

test('validateItems dispatches by mission type', () => {
  assert.equal(validateItems([{ command: 16 }], MISSION_TYPE.MISSION).ok, true);
  assert.equal(validateItems([{ command: 5001 }], MISSION_TYPE.FENCE).ok, true);
  assert.equal(validateItems([{ command: 5100 }], MISSION_TYPE.RALLY).ok, true);
  // Wrong family under a given type is rejected.
  assert.equal(validateItems([{ command: 16 }], MISSION_TYPE.FENCE).ok, false);
});

test('an item without a numeric command is rejected naming its sequence', () => {
  const result = validateMissionItems([{ command: 16 }, { command: 'NAV_WAYPOINT' }]);
  assert.equal(result.ok, false);
  assert.equal(result.seq, 1);
});

test('a non-uint16 command is rejected before the family test (would corrupt the wire)', () => {
  // 5001.9 is finite and not === any fence id, so the family predicate alone
  // would pass it — but it truncates on the uint16 wire to reserved fence
  // command 5001, defeating the one reservation the validator holds.
  const frac = validateMissionItems([{ command: 5001.9 }]);
  assert.equal(frac.ok, false);
  assert.equal(frac.seq, 0);

  // Out-of-range ids would throw mid-serialization; reject them cleanly here.
  assert.equal(validateMissionItems([{ command: -1 }]).ok, false);
  assert.equal(validateMissionItems([{ command: 65536 }]).ok, false);

  // A fence upload of 5001.9 must not slip through as 5001 either.
  assert.equal(validateFenceItems([{ command: 5001.9 }]).ok, false);

  // A genuine uint16 command id still passes.
  assert.equal(validateMissionItems([{ command: 16 }]).ok, true);
});

test('firmware gates the mission type list (§11)', () => {
  assert.deepEqual(supportedMissionTypes('ardupilot'), ['mission', 'fence', 'rally']);
  // PX4 does not carry fence and rally the same way — mission only.
  assert.deepEqual(supportedMissionTypes('px4'), ['mission']);
  assert.deepEqual(supportedMissionTypes('custom'), ['mission']);
  assert.deepEqual(supportedMissionTypes(undefined), ['mission']);
});
