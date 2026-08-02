'use strict';

/**
 * Profile-keyed parameter-definition holding files (DESIGN.md §4).
 *
 * Reads are strictly local. Network access happens only through the explicit
 * update operation, which validates a nonempty document before atomically
 * replacing the profile's last good holding file.
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

/**
 * Return the deterministic holding-file path for a Vehicle Profile.
 *
 * @param {string} userDir Node-RED user directory
 * @param {string} profileId Vehicle Profile node ID
 * @returns {string}
 */
function paramDefsPath(userDir, profileId) {
  const id = String(profileId || '').trim();
  if (!id) throw new Error('Vehicle Profile ID is required');
  if (id === '.' || id === '..' || /[\\/]/.test(id)) {
    throw new Error('Vehicle Profile ID contains unsupported characters');
  }
  return path.join(userDir, 'mavlink', 'param-defs', `${id}.json`);
}

/**
 * Read and validate one profile's local holding file.
 *
 * A missing file is the supported no-seed state and returns an empty map.
 * Every other read, JSON parse, or document-validation error propagates.
 *
 * @param {string} userDir
 * @param {string} profileId
 * @returns {Promise<Map<string, object>>}
 */
async function readParamDefs(userDir, profileId) {
  const file = paramDefsPath(userDir, profileId);
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return new Map();
    throw err;
  }
  return validatedParamDefs(JSON.parse(raw));
}

/**
 * Download, validate, and atomically replace one profile's holding file.
 *
 * @param {string} userDir
 * @param {string} profileId
 * @param {string} url
 * @param {{fetchFn?: Function}} [opts]
 * @returns {Promise<{count: number}>}
 */
async function updateParamDefs(userDir, profileId, url, opts = {}) {
  const sourceUrl = typeof url === 'string' ? url.trim() : '';
  if (!sourceUrl) throw new Error('Parameter definitions URL is required');

  const fetchFn = opts.fetchFn || defaultFetch;
  const document = await fetchFn(sourceUrl);
  const map = validatedParamDefs(document);
  const file = paramDefsPath(userDir, profileId);
  const tempFile = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}-${randomUUID()}.tmp`
  );

  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(tempFile, JSON.stringify(document), { encoding: 'utf8', flag: 'wx' });
    await fs.rename(tempFile, file);
  } catch (err) {
    try {
      await fs.unlink(tempFile);
    } catch (cleanupErr) {
      if (!cleanupErr || cleanupErr.code !== 'ENOENT') {
        err.cleanupError = cleanupErr;
      }
    }
    throw err;
  }

  return { count: map.size };
}

/**
 * Parse an apm.pdef.json (ArduPilot) or compatible flat dictionary.
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
      addParam(map, topKey, topVal);
    } else {
      for (const [paramId, entry] of Object.entries(topVal)) {
        if (entry && typeof entry === 'object' && looksLikeParamEntry(entry)) {
          addParam(map, paramId, entry);
        }
      }
    }
  }

  return map;
}

function validatedParamDefs(document) {
  const map = parsePdefJson(document);
  if (map.size === 0) {
    throw new Error('Document contains no parameter definitions');
  }
  return map;
}

function looksLikeParamEntry(obj) {
  return (
    typeof obj.humanName === 'string' ||
    typeof obj.documentation === 'string' ||
    Array.isArray(obj.documentation)
  );
}

function addParam(map, paramId, entry) {
  const id = String(paramId || '').trim().toUpperCase();
  if (!id) return;

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
  const values = rawValues && typeof rawValues === 'object' && !Array.isArray(rawValues)
    ? Object.entries(rawValues).map(([value, label]) => ({
      value: Number(value),
      label: String(label),
    }))
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

async function defaultFetch(url) {
  const response = await globalThis.fetch(url, {
    signal: globalThis.AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${url}`);
  return response.json();
}

module.exports = {
  paramDefsPath,
  parsePdefJson,
  readParamDefs,
  updateParamDefs,
};
