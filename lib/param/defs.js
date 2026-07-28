'use strict';

/**
 * Parameter definition catalog for ArduPilot and PX4 (DESIGN.md §4).
 *
 * Fetches apm.pdef.json from ArduPilot's autotest server (or a custom URL),
 * parses it into a flat map of paramId → { description, unit, min, max,
 * increment, values }, and caches in memory (and optionally on disk under
 * userDir/mavlink/param-defs/).
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

/** In-memory cache: url → Map<paramId, def>. */
const _memCache = new Map();

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
  if (custom) {
    assertSafeDefsUrl(custom);
    return custom;
  }
  if (firmware === 'ardupilot') {
    const vehicle = FAMILY_TO_ARDUPILOT_VEHICLE[vehicleFamily];
    if (vehicle) return `${ARDUPILOT_PDEF_BASE}/${vehicle}/apm.pdef.json`;
  }
  return null;
}

/**
 * Reject non-HTTPS and private/link-local destinations so the admin route
 * cannot be used as an SSRF trampoline into the Node-RED host's network.
 *
 * @param {string} urlString
 * @throws {Error} with code `PARAM_DEFS_URL_FORBIDDEN`
 */
function assertSafeDefsUrl(urlString) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    const err = new Error(`parameter defs URL is not a valid URL: ${urlString}`);
    err.code = 'PARAM_DEFS_URL_FORBIDDEN';
    throw err;
  }
  if (url.protocol !== 'https:') {
    const err = new Error(`parameter defs URL must use https (got ${url.protocol})`);
    err.code = 'PARAM_DEFS_URL_FORBIDDEN';
    throw err;
  }
  if (url.username || url.password) {
    const err = new Error('parameter defs URL must not include credentials');
    err.code = 'PARAM_DEFS_URL_FORBIDDEN';
    throw err;
  }
  const host = url.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.lan')
  ) {
    const err = new Error(`parameter defs URL host is not allowed: ${host}`);
    err.code = 'PARAM_DEFS_URL_FORBIDDEN';
    throw err;
  }
  if (isBlockedIpLiteral(host)) {
    const err = new Error(`parameter defs URL must not target a private or link-local address`);
    err.code = 'PARAM_DEFS_URL_FORBIDDEN';
    throw err;
  }
}

/**
 * @param {string} host  hostname or IP literal (no brackets)
 * @returns {boolean}
 */
function isBlockedIpLiteral(host) {
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (bare === '::1' || bare === '0.0.0.0' || bare === '::') return true;
  // IPv4 literal
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(bare)) {
    const parts = bare.split('.').map(Number);
    if (parts.some((n) => n > 255)) return true;
    const [a, b] = parts;
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  // IPv6 unique-local / link-local
  if (bare.includes(':')) {
    const lower = bare.toLowerCase();
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
    if (lower.startsWith('fe80')) return true;
    if (lower === '::1') return true;
  }
  return false;
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
 * @param {{fetchFn?: Function, cacheDir?: string}} [opts]
 * @returns {Promise<Map<string, object>>}
 */
async function fetchParamDefs(url, opts = {}) {
  assertSafeDefsUrl(url);
  const cached = _memCache.get(url);
  if (cached) return cached;

  const cacheDir = opts.cacheDir || null;
  const cacheFile = cacheDir ? path.join(cacheDir, urlToFilename(url)) : null;

  // Prefer disk cache over a network round-trip.
  if (cacheFile) {
    try {
      const raw = fs.readFileSync(cacheFile, 'utf8');
      const map = parsePdefJson(JSON.parse(raw));
      _memCache.set(url, map);
      return map;
    } catch {
      // Corrupt or missing — fall through to network fetch.
    }
  }

  const fetchFn = opts.fetchFn || defaultFetch;
  const json = await fetchFn(url);
  const map = parsePdefJson(json);
  _memCache.set(url, map);

  if (cacheFile) {
    try {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify(json));
    } catch {
      // Non-fatal; memory cache still serves subsequent calls.
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
 * Derive a filesystem-safe filename from a URL for the disk cache.
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
async function defaultFetch(url, hops = 0) {
  assertSafeDefsUrl(url);
  if (hops > 3) throw new Error(`too many redirects fetching ${url}`);
  if (typeof globalThis.fetch === 'function') {
    // Manual redirects so every hop is re-checked against the SSRF allow rules.
    const res = await globalThis.fetch(url, {
      signal: globalThis.AbortSignal.timeout(15000),
      redirect: 'manual',
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new Error(`HTTP ${res.status} redirect without Location from ${url}`);
      const next = new URL(loc, url).toString();
      return defaultFetch(next, hops + 1);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
    return res.json();
  }
  // Node 18 fallback: native https only (assertSafeDefsUrl already required it).
  const https = require('node:https');
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        defaultFetch(next, hops + 1).then(resolve, reject);
        return;
      }
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

/** Clear the in-memory cache (useful in tests). */
function clearMemCache() {
  _memCache.clear();
}

module.exports = {
  resolveDefsUrl,
  assertSafeDefsUrl,
  fetchParamDefs,
  parsePdefJson,
  clearMemCache,
  FAMILY_TO_ARDUPILOT_VEHICLE,
};
