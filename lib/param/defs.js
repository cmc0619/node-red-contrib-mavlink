'use strict';

/**
 * Parameter definition catalog for ArduPilot and PX4 (DESIGN.md §4).
 *
 * Fetches apm.pdef.json from ArduPilot's autotest server (or a custom URL),
 * parses it into a flat map of paramId → { description, unit, min, max,
 * increment, values }, and persists under `userDir/mavlink/param-defs/` so the
 * Param editor can author offline after a bench download — same role as the
 * dialect XML library, not a hot-path speed cache. An in-process map dedupes
 * repeated admin GETs within one Node-RED process.
 *
 * fetchFn is injectable so the network call can be replaced in tests.
 *
 * ArduPilot apm.pdef.json format:
 *   { "VehicleName": { "PARAM_ID": { humanName, documentation, user, fields, values } } }
 *   fields: { Units, Range, Increment, ... }
 *   values: { "0": "Disabled", "1": "Enabled" }   (numeric key → label)
 */

const fs = require('node:fs');
const path = require('node:path');

const ARDUPILOT_PDEF_BASE = 'https://autotest.ardupilot.org/Parameters';

/** vehicleFamily → ArduPilot subdirectory name. */
const FAMILY_TO_ARDUPILOT_VEHICLE = {
  copter: 'ArduCopter',
  plane: 'ArduPlane',
  rover: 'Rover',
  boat: 'Rover',
  sub: 'Sub',
};

/** In-process dedupe: url → Map<paramId, def>. */
const _memByUrl = new Map();

/**
 * Resolve the parameter definitions URL for a vehicle profile.
 *
 * @param {string} vehicleFamily  Vehicle family from profile (copter|plane|rover|boat|sub|generic|…)
 * @param {string} firmware       ardupilot|px4|custom
 * @param {string|undefined} paramDefsUrl  Explicit override from the profile config
 * @returns {string|null} URL, or null if no defs apply
 */
function resolveDefsUrl(vehicleFamily, firmware, paramDefsUrl) {
  const custom = paramDefsUrl ? String(paramDefsUrl).trim() : '';
  if (custom) return custom;
  if (firmware === 'ardupilot') {
    const vehicle = FAMILY_TO_ARDUPILOT_VEHICLE[vehicleFamily];
    if (vehicle) return `${ARDUPILOT_PDEF_BASE}/${vehicle}/apm.pdef.json`;
  }
  return null;
}

/**
 * Fetch and parse parameter definitions from a URL.
 *
 * Returns a Map<paramId (uppercase), def> where each def is:
 *   { description: string, unit: string,
 *     min?: number, max?: number, increment?: number,
 *     values?: Array<{ value: number, label: string }> }
 *
 * @param {string} url
 * @param {{fetchFn?: Function, storeDir?: string}} [opts]
 * @returns {Promise<Map<string, object>>}
 */
async function fetchParamDefs(url, opts = {}) {
  const memo = _memByUrl.get(url);
  if (memo) return memo;

  const storeDir = opts.storeDir || null;
  const storeFile = storeDir ? path.join(storeDir, urlToFilename(url)) : null;

  // Prefer the authoring store on disk (offline after a bench download).
  if (storeFile) {
    try {
      const raw = fs.readFileSync(storeFile, 'utf8');
      const map = parsePdefJson(JSON.parse(raw));
      _memByUrl.set(url, map);
      return map;
    } catch {
      // Corrupt or missing — fall through to network fetch.
    }
  }

  const fetchFn = opts.fetchFn || defaultFetch;
  const json = await fetchFn(url);
  const map = parsePdefJson(json);
  _memByUrl.set(url, map);

  if (storeFile) {
    try {
      fs.mkdirSync(path.dirname(storeFile), { recursive: true });
      fs.writeFileSync(storeFile, JSON.stringify(json));
    } catch {
      // Non-fatal; in-process map still serves subsequent calls this process.
    }
  }

  return map;
}

/**
 * Parse an apm.pdef.json (ArduPilot) or compatible flat-dict into a param map.
 *
 * Handles two shapes:
 *   - Top-level vehicle namespace: { "ArduCopter": { "PARAM": {...} } }
 *   - Flat: { "PARAM": { humanName|documentation, ... } }
 *
 * @param {object} json
 * @returns {Map<string, object>}
 */
function parsePdefJson(json) {
  const map = new Map();
  if (!json || typeof json !== 'object' || Array.isArray(json)) return map;

  for (const [topKey, topVal] of Object.entries(json)) {
    if (!topVal || typeof topVal !== 'object') continue;
    if (looksLikeParamEntry(topVal)) {
      // Flat format: topKey is the param id.
      addParam(map, topKey, topVal);
    } else {
      // Namespaced format: topKey is a vehicle/group name, iterate its params.
      for (const [paramId, entry] of Object.entries(topVal)) {
        if (entry && typeof entry === 'object' && looksLikeParamEntry(entry)) {
          addParam(map, paramId, entry);
        }
      }
    }
  }

  return map;
}

/**
 * @param {object} obj
 * @returns {boolean}
 */
function looksLikeParamEntry(obj) {
  return (
    typeof obj.humanName === 'string' ||
    typeof obj.documentation === 'string' ||
    Array.isArray(obj.documentation)
  );
}

/**
 * @param {Map} map
 * @param {string} paramId
 * @param {object} entry
 */
function addParam(map, paramId, entry) {
  const id = String(paramId || '').trim().toUpperCase();
  if (!id) return;

  // documentation may be a string or an array of strings.
  const rawDoc = entry.documentation;
  const description = Array.isArray(rawDoc)
    ? rawDoc.join(' ')
    : (rawDoc || entry.humanName || '');

  const fields = entry.fields || {};
  const rangeStr = (fields.Range || fields.range || '').trim();
  const rangeParts = rangeStr ? rangeStr.split(/\s+/) : [];
  const minRaw = rangeParts[0];
  const maxRaw = rangeParts[1];

  const incRaw = fields.Increment || fields.increment;

  const min = minRaw !== undefined && minRaw !== '' ? Number(minRaw) : undefined;
  const max = maxRaw !== undefined && maxRaw !== '' ? Number(maxRaw) : undefined;
  const increment = incRaw !== undefined && incRaw !== '' ? Number(incRaw) : undefined;
  const unit = (fields.Units || fields.units || '').trim();

  const rawValues = entry.values || null;
  const values =
    rawValues && typeof rawValues === 'object' && !Array.isArray(rawValues)
      ? Object.entries(rawValues).map(([k, v]) => ({ value: Number(k), label: String(v) }))
      : undefined;

  map.set(id, {
    description: String(description || ''),
    unit,
    min: min !== undefined && Number.isFinite(min) ? min : undefined,
    max: max !== undefined && Number.isFinite(max) ? max : undefined,
    increment: increment !== undefined && Number.isFinite(increment) ? increment : undefined,
    values,
  });
}

/**
 * Derive a filesystem-safe filename from a URL for the authoring store.
 * @param {string} url
 * @returns {string}
 */
function urlToFilename(url) {
  const safe = url.replace(/[^a-zA-Z0-9_.-]/g, '_');
  // Keep at most 200 chars to avoid path-length issues.
  return safe.slice(-200) + '.json';
}

/**
 * Default fetch using the global fetch (Node 22+) or native http/https.
 * @param {string} url
 * @returns {Promise<object>}
 */
async function defaultFetch(url) {
  if (typeof globalThis.fetch === 'function') {
    const res = await globalThis.fetch(url, { signal: globalThis.AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
    return res.json();
  }
  // Node 18 fallback: native http/https.
  const mod = url.startsWith('https') ? require('node:https') : require('node:http');
  return new Promise((resolve, reject) => {
    const req = mod.get(url, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (err) {
          reject(new Error(`JSON parse error from ${url}: ${err.message}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error(`timeout fetching ${url}`)));
  });
}

/** Clear the in-process map (tests). */
function clearMemCache() {
  _memByUrl.clear();
}

module.exports = {
  resolveDefsUrl,
  fetchParamDefs,
  parsePdefJson,
  clearMemCache,
  FAMILY_TO_ARDUPILOT_VEHICLE,
};
