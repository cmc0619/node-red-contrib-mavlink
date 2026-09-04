'use strict';

/**
 * Why command-param enum pulldowns carry no blank option.
 *
 * An unset command param resolves to 0 — Advanced fills unset slots, and the
 * preset path starts from `[0,0,0,0,0,0,0]`. So a blank choice sends 0. Where
 * 0 means something, the dialect already enumerates it, which makes blank a
 * second spelling of an entry that exists; where the enum has no 0, blank
 * sends a value the enum does not define.
 *
 * Upstream marks genuinely unused params `Empty` / `reserved`, and
 * `isHiddenParam` drops those before they reach a control. A param that
 * reaches the form is one the dialect chose to expose.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadBundled } = require('../../lib/metadata/bundled');
const { catalogFromBundle } = require('../../lib/metadata/commands-list');

/**
 * The editor's checkbox rule (`RED.mavlink.isFalseTrueEnum` in
 * resources/mavlink-editor.js): exactly two entries, *_FALSE=0 and *_TRUE=1.
 *
 * @param {Array<{name: string, value: number|string}>} entries
 * @returns {boolean}
 */
function isFalseTrueEnum(entries) {
  return entries.length === 2
    && entries.some((e) => /(^|_)FALSE$/.test(e.name) && Number(e.value) === 0)
    && entries.some((e) => /(^|_)TRUE$/.test(e.name) && Number(e.value) === 1);
}

/** Params that render a plain pulldown: enum-backed, not hidden, not a bitmask,
 *  not FALSE/TRUE (those are checkboxes). */
function blankableParams(catalog) {
  const out = [];
  const seen = new Set();
  for (const command of catalog.commands || []) {
    for (const param of command.params || []) {
      if (param.hidden || !param.enum || param.bitmask) continue;
      const entries = catalog.enums[param.enum];
      if (!entries || !entries.length) continue;
      if (isFalseTrueEnum(entries)) continue;
      const key = `${command.name}:${param.index}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ command: command.name, index: param.index, enumName: param.enum, entries });
    }
  }
  return out;
}

test('dropping the blank keeps the wire identical wherever the enum defines 0', () => {
  const catalog = catalogFromBundle(loadBundled('ardupilotmega'));
  const params = blankableParams(catalog);
  assert.ok(params.length > 40, `sanity: a real number of pulldowns (${params.length})`);

  const moved = params.filter((p) => Number(p.entries[0].value) !== 0);

  // With no blank the browser selects the first entry. Where that entry is 0,
  // it is byte-identical to what blank produced.
  assert.ok(
    params.length - moved.length >= 40,
    `${params.length - moved.length} of ${params.length} send exactly what blank sent`
  );

  // The exceptions are the whole point: blank was sending a value the enum
  // never defined. Naming them here means a dialect update that adds another
  // one shows up as a test failure rather than a silent behaviour change.
  assert.deepEqual(
    [...new Set(moved.map((p) => p.enumName))].sort(),
    ['ACCELCAL_VEHICLE_POS'],
    'only enums with no 0 entry change, and this is the known set'
  );
  for (const param of moved) {
    assert.ok(
      !param.entries.some((entry) => Number(entry.value) === 0),
      `${param.enumName} would not have moved if it defined 0`
    );
  }
});

test('every 0-valued entry a command param can reach is a real choice, not "unset"', () => {
  const catalog = catalogFromBundle(loadBundled('ardupilotmega'));
  const zeroNames = new Set();
  for (const param of blankableParams(catalog)) {
    const zero = param.entries.find((entry) => Number(entry.value) === 0);
    if (zero) zeroNames.add(zero.name);
  }

  // A sample of what 0 actually means. Half are "none"-ish (MAV_ROI_NONE,
  // PARACHUTE_DISABLE); the other half are actions — which is why a blank
  // reading as abstention was worse than redundant.
  for (const name of ['MAV_ROI_NONE', 'PARACHUTE_DISABLE', 'GRIPPER_ACTION_RELEASE',
    'MAV_MOUNT_MODE_RETRACT', 'CAMERA_MODE_IMAGE']) {
    assert.ok(zeroNames.has(name), `${name} is reachable as a 0 entry`);
  }
});
