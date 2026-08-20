'use strict';

/**
 * Mode-name resolution ladder (lib/vehicle/modes.js): vehicle-published beats
 * shipped, ArduPilot dispatches by family into the dialect's enums, PX4 packs
 * and unpacks its custom_mode word, and the unresolved tails are NaN (names)
 * and undefined (numbers) — never a guess.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  modeNumberFor,
  modeNameFor,
  setModeParams,
  px4CustomMode,
  px4MainMode,
  px4SubMode,
} = require('../../lib/vehicle/modes');
const { loadBundled } = require('../../lib/metadata');

const AP_BUNDLE = loadBundled('ardupilotmega');

/** A peer component holding vehicle-published AVAILABLE_MODES entries. */
function componentWith(entries) {
  return { modes: new Map(entries.map((e, i) => [i + 1, e])) };
}

test('vehicle-published entries beat the shipped tables in both directions', () => {
  const ctx = {
    component: componentWith([
      { name: 'Guided', standardMode: 0, customMode: 99 },
    ]),
    firmware: 'ardupilot',
    vehicleFamily: 'copter',
    bundle: AP_BUNDLE,
  };
  // COPTER_MODE_GUIDED is 4; the vehicle's own table says 99 and wins.
  assert.equal(modeNumberFor('GUIDED', ctx), 99);
  assert.equal(modeNameFor(99, ctx), 'Guided');
  // A name the cache does not hold still falls through to the dialect enum.
  assert.equal(modeNumberFor('LOITER', ctx), 5);
});

test('a blank-named standard mode resolves through MAV_STANDARD_MODE', () => {
  // Measured 2026-08-18: standard-mode rows arrive with an empty mode_name;
  // the dialect enum names them (MAV_STANDARD_MODE_LAND = 7).
  const ctx = {
    component: componentWith([
      { name: '', standardMode: 7, customMode: px4CustomMode(4, 2) },
    ]),
    firmware: 'px4',
    bundle: loadBundled('common'),
  };
  assert.equal(modeNameFor(px4CustomMode(4, 2), ctx), 'LAND');
  assert.equal(modeNumberFor('land', ctx), px4CustomMode(4, 2));
});

test('ArduPilot dispatches by family: copter and boat read different enums', () => {
  const copter = { firmware: 'ardupilot', vehicleFamily: 'copter', bundle: AP_BUNDLE };
  const boat = { firmware: 'ardupilot', vehicleFamily: 'boat', bundle: AP_BUNDLE };
  assert.equal(modeNumberFor('GUIDED', copter), 4); // COPTER_MODE_GUIDED
  assert.equal(modeNumberFor('GUIDED', boat), 15); // ROVER_MODE_GUIDED (boat is Rover firmware)
  assert.equal(modeNameFor(4, copter), 'GUIDED');
  assert.equal(modeNameFor(4, boat), 'HOLD'); // ROVER_MODE_HOLD
  // Names match case-insensitively; the answer keeps the enum's spelling.
  assert.equal(modeNumberFor('guided', copter), 4);
});

test('PX4 packs main/sub into the custom_mode word and round-trips it', () => {
  const ctx = { firmware: 'px4' };
  // Measured words (PX4 1.18 SIH): Position = 0x00030000, Hold = 0x03040000.
  assert.equal(modeNumberFor('Position', ctx), 0x00030000);
  assert.equal(modeNumberFor('Hold', ctx), 0x03040000);
  assert.equal(modeNameFor(0x03040000, ctx), 'Hold');
  assert.equal(px4MainMode(0x03040000), 4);
  assert.equal(px4SubMode(0x03040000), 3);
  assert.equal(px4CustomMode(4, 3), 0x03040000);
  // DO_SET_MODE wants the decomposed pair on PX4 (§14), the whole number
  // everywhere else.
  assert.deepEqual(setModeParams('Hold', ctx), { 2: 4, 3: 3 });
  assert.deepEqual(
    setModeParams('GUIDED', { firmware: 'ardupilot', vehicleFamily: 'copter', bundle: AP_BUNDLE }),
    { 2: 4 }
  );
});

test('an unresolved name is NaN — loud at the wire, never 0 and never undefined', () => {
  assert.equal(Number.isNaN(modeNumberFor('WARP_9', { firmware: 'ardupilot', vehicleFamily: 'copter', bundle: AP_BUNDLE })), true);
  assert.equal(Number.isNaN(modeNumberFor('GUIDED', { firmware: 'custom' })), true);
  // The PX4 split propagates the NaN into both params rather than packing 0.
  const params = setModeParams('WARP_9', { firmware: 'px4' });
  assert.equal(Number.isNaN(params[2]), true);
  assert.equal(Number.isNaN(params[3]), true);
  // custom matches no packing case — no ArduPilot-shaped param2 invented.
  assert.deepEqual(setModeParams('GUIDED', { firmware: 'custom' }), {});
});

test('an unresolved number is undefined — outputs omit the name, keep the number', () => {
  assert.equal(modeNameFor(9999, { firmware: 'ardupilot', vehicleFamily: 'copter', bundle: AP_BUNDLE }), undefined);
  assert.equal(modeNameFor(4, { firmware: 'custom' }), undefined);
  assert.equal(modeNameFor(4, { firmware: 'ardupilot', vehicleFamily: 'unknown', bundle: AP_BUNDLE }), undefined);
});

test('an absent mode is undefined, not mode 0 — Number(null) must not name STABILIZE', () => {
  // A component with only an AVAILABLE_MODES cache and no HEARTBEAT yet has
  // flightMode null. Number(null) is 0, and 0 is COPTER_MODE_STABILIZE, so an
  // unguarded lookup reports a resolved name for a mode that was never
  // observed — the §0 false-success shape (#346 review). null and undefined
  // stay undefined; only a real 0 names STABILIZE.
  const apCopter = { firmware: 'ardupilot', vehicleFamily: 'copter', bundle: AP_BUNDLE };
  assert.equal(modeNameFor(null, apCopter), undefined);
  assert.equal(modeNameFor(undefined, apCopter), undefined);
  assert.equal(modeNameFor(0, apCopter), 'STABILIZE');
});
