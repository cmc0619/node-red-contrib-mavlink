'use strict';

/**
 * The shipped parameter-definition seed (DESIGN.md §4).
 *
 * Layout under `seed/`, mirroring the dialect seed:
 *
 *   params-active.json                     — pointer { file, stamp, sources }
 *   param-defs-YYYY-MM-DD-<hash>.seed.gz   — gunzip → JSON, firmware → vehicle → defs
 *
 * Produced by `scripts/generate-param-seed.js`. Reads are lazy and cached: the
 * blob is gunzipped at most once per process, on the first lookup that needs it.
 *
 * The seed is a *baseline*, not an authority. A Vehicle Profile that has
 * downloaded its own definitions overrides it, because that download came from
 * the firmware the operator is actually flying, while this is a snapshot taken
 * whenever the seed was last regenerated. Nothing here expires on its own — a
 * newer seed arrives only with a new release of this package.
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SEED_DIR = path.join(__dirname, '..', '..', 'seed');
const ACTIVE_FILE = path.join(SEED_DIR, 'params-active.json');

/**
 * Vehicle Profile `vehicleFamily` → ArduPilot's per-vehicle document name.
 *
 * `boat` maps to Rover because ArduPilot ships boats in the Rover parameter
 * set; there is no separate document. `unknown` is deliberately absent — it
 * takes the union of every document (see {@link defsFor}), which offers more
 * names than any one vehicle has rather than silently picking a wrong one.
 *
 * Every other document gets a family. A document with no entry here is
 * reachable only inside the union, which is how Blimp's 3127 definitions were
 * unreachable until measurement caught it (DESIGN.md §14) — adding a document
 * to `scripts/generate-param-seed.js` is half the job.
 */
const ARDUPILOT_VEHICLE = {
  copter: 'ArduCopter',
  plane: 'ArduPlane',
  rover: 'Rover',
  boat: 'Rover',
  sub: 'ArduSub',
  blimp: 'Blimp',
  'antenna-tracker': 'AntennaTracker',
};

/** @type {?object} gunzipped blob, or null until first use */
let cached = null;
/** @type {boolean} whether a load has been attempted (success or failure) */
let attempted = false;
/** @type {?string} why the last load failed, for callers that want to say so */
let loadError = null;

/**
 * Load and cache the seed blob. A missing seed is not fatal: this package is
 * usable without parameter metadata, so callers get an empty result and a
 * reason rather than an exception.
 *
 * @returns {?object}
 */
function load() {
  if (attempted) return cached;
  attempted = true;

  try {
    const active = JSON.parse(fs.readFileSync(ACTIVE_FILE, 'utf8'));
    const file = typeof active.file === 'string' ? path.basename(active.file) : '';
    if (!file.endsWith('.seed.gz')) {
      throw new Error(`pointer at ${ACTIVE_FILE} names no seed file`);
    }
    const blob = path.join(SEED_DIR, file);
    cached = JSON.parse(zlib.gunzipSync(fs.readFileSync(blob)).toString('utf8'));
  } catch (err) {
    cached = null;
    loadError = err && err.code === 'ENOENT'
      ? 'No parameter-definition seed is installed. Run: node scripts/generate-param-seed.js'
      : `Parameter-definition seed is unreadable: ${err.message}`;
  }
  return cached;
}

/**
 * Seeded definitions for a firmware and vehicle family.
 *
 * @param {{firmware?: string, vehicleFamily?: string}} [opts]
 * @returns {Map<string, object>} empty when the seed is absent or the firmware
 *   is unknown — never a partial guess at a different firmware's parameters
 */
function defsFor(opts = {}) {
  const seed = load();
  const firmware = String(opts.firmware || '').trim().toLowerCase();
  const result = new Map();
  if (!seed || !firmware) return result;

  const entry = (seed.firmwares || {})[firmware];
  const vehicles = entry && entry.vehicles;
  if (!vehicles) return result;

  const family = String(opts.vehicleFamily || '').trim().toLowerCase();
  const named = firmware === 'ardupilot' ? ARDUPILOT_VEHICLE[family] : 'default';

  if (named && vehicles[named]) {
    for (const [id, def] of Object.entries(vehicles[named])) result.set(id, def);
    return result;
  }

  // Unknown vehicle: offer the union of names. A picker that lists a parameter
  // the vehicle lacks costs a failed read; one that hides a parameter the
  // vehicle has cannot be recovered from inside the editor.
  //
  // Names only, though — see {@link unionSafe}. Which document an id came from
  // is arbitrary here, and the documents disagree.
  for (const perVehicle of Object.values(vehicles)) {
    for (const [id, def] of Object.entries(perVehicle)) {
      if (!result.has(id)) result.set(id, unionSafe(def));
    }
  }
  return result;
}

/**
 * The part of a definition that survives a union.
 *
 * Measured across ArduPilot's six documents (DESIGN.md §14): of the 5467 ids
 * that appear in more than one, 122 disagree on `values`, 25 on `max`, 23 on
 * `min`, 5 on `increment`. Whichever document happened to be enumerated first
 * wins, so serving those is a coin flip presented as fact — and both fields
 * *act*. A wrong bound refuses a value the vehicle accepts; a wrong
 * enumeration offers "AltHold (2)" for a vehicle whose mode 2 is something
 * else, so the operator sets the wrong mode and the editor looks confident.
 *
 * `type` goes with them. No ArduPilot document publishes one today, so the
 * union strips nothing in practice — but a type is what the value is encoded
 * as on the wire, and a union cannot vouch for a field that acts.
 *
 * Description and unit also disagree (50 and 19), and are kept: they are
 * advisory text an operator reads, not a control that refuses input or names
 * the wrong mode.
 *
 * @param {object} def
 * @returns {object} without bounds or enumeration
 */
function unionSafe(def) {
  const { min, max, increment, values, type, ...rest } = def;
  return rest;
}

/**
 * The installed seed's stamp, or null when no seed is readable.
 *
 * @returns {?string}
 */
function seedStamp() {
  const seed = load();
  return seed && typeof seed.stamp === 'string' ? seed.stamp : null;
}

/**
 * Why the seed could not be read, or null when it loaded.
 *
 * @returns {?string}
 */
function seedError() {
  load();
  return cached ? null : loadError;
}

/** Drop the cache. Tests only — the blob never changes within a process. */
function _resetForTests() {
  cached = null;
  attempted = false;
  loadError = null;
}

module.exports = {
  ARDUPILOT_VEHICLE,
  defsFor,
  seedStamp,
  seedError,
  _resetForTests,
};
