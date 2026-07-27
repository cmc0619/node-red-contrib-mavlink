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

test('fence validator accepts only NAV_FENCE commands', () => {
  assert.equal(validateFenceItems([{ command: 5001 }, { command: 5004 }]).ok, true);
  // A waypoint is not a fence item.
  assert.equal(validateFenceItems([{ command: 16 }]).ok, false);
  // Nor is a rally point.
  assert.equal(validateFenceItems([{ command: 5100 }]).ok, false);
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

test('firmware gates the mission type list (§11)', () => {
  assert.deepEqual(supportedMissionTypes('ardupilot'), ['mission', 'fence', 'rally']);
  // PX4 does not carry fence and rally the same way — mission only.
  assert.deepEqual(supportedMissionTypes('px4'), ['mission']);
  assert.deepEqual(supportedMissionTypes('custom'), ['mission']);
  assert.deepEqual(supportedMissionTypes(undefined), ['mission']);
});
