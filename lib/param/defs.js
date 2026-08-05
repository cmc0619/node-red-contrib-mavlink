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
 * Parse a parameter-metadata document into `id → {description, unit, …}`.
 *
 * Two upstream shapes, because the two firmwares publish differently:
 *
 *   ArduPilot `apm.pdef.json`  nested objects keyed by param id, one or two
 *                              levels deep, `Description`/`humanName` text
 *   PX4 `parameters.json`      `{parameters: [{name, shortDesc, …}]}` — a flat
 *                              array carrying the id *inside* each entry
 *
 * The array form has to be handled explicitly: the object walk below takes the
 * key as the param id, so on an array it would read "0", "1", "2".
 *
 * @param {object} json
 * @returns {Map<string, object>}
 */
function parsePdefJson(json) {
  const map = new Map();
  if (!json || typeof json !== 'object' || Array.isArray(json)) return map;

  if (Array.isArray(json.parameters)) {
    for (const entry of json.parameters) {
      if (entry && typeof entry === 'object' && looksLikeParamEntry(entry)) {
        addParam(map, entry.name, entry);
      }
    }
    return map;
  }

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
    Array.isArray(obj.documentation) ||
    typeof obj.Description === 'string' ||
    typeof obj.DisplayName === 'string' ||
    // PX4 spellings. `shortDesc` is on 100% of PX4 entries, `longDesc` on 61%.
    typeof obj.shortDesc === 'string' ||
    typeof obj.longDesc === 'string'
  );
}

function addParam(map, paramId, entry) {
  const id = String(paramId || '').trim().toUpperCase();
  if (!id) return;

  // PX4 carries both a one-line `shortDesc` and a fuller `longDesc`; prefer the
  // fuller one and fall back, since only 61% of entries have it.
  const rawDoc = entry.documentation !== undefined
    ? entry.documentation
    : (entry.Description !== undefined ? entry.Description : entry.longDesc);
  const description = Array.isArray(rawDoc)
    ? rawDoc.join(' ')
    : (rawDoc || entry.humanName || entry.DisplayName || entry.shortDesc || '');

  const fields = entry.fields || {};
  const rawRange = entry.Range !== undefined
    ? entry.Range
    : (fields.Range || fields.range || '');
  let minRaw;
  let maxRaw;
  if (rawRange && typeof rawRange === 'object' && !Array.isArray(rawRange)) {
    minRaw = rawRange.low;
    maxRaw = rawRange.high;
  } else {
    const rangeStr = typeof rawRange === 'string' ? rawRange.trim() : '';
    const rangeParts = rangeStr ? rangeStr.split(/\s+/) : [];
    minRaw = rangeParts[0];
    maxRaw = rangeParts[1];
  }
  // PX4 states bounds as plain numbers per entry rather than an ArduPilot
  // "low high" Range string, so they are a fallback rather than another parse.
  if ((minRaw === undefined || minRaw === '') && typeof entry.min === 'number') minRaw = entry.min;
  if ((maxRaw === undefined || maxRaw === '') && typeof entry.max === 'number') maxRaw = entry.max;
  const incRaw = entry.Increment !== undefined
    ? entry.Increment
    : (fields.Increment || fields.increment || entry.increment);
  const min = minRaw !== undefined && minRaw !== '' ? Number(minRaw) : undefined;
  const max = maxRaw !== undefined && maxRaw !== '' ? Number(maxRaw) : undefined;
  const increment = incRaw !== undefined && incRaw !== '' ? Number(incRaw) : undefined;
  const unit = String(
    entry.Units !== undefined
      ? entry.Units
      : (fields.Units || fields.units || entry.units || '')
  ).trim();
  const rawValues = entry.Values !== undefined ? entry.Values : (entry.values || null);
  let values;
  if (Array.isArray(rawValues)) {
    // PX4: [{value, description}]. Entries without a finite value are dropped
    // rather than becoming NaN options in the editor's select.
    values = rawValues
      .filter((v) => v && typeof v === 'object' && Number.isFinite(Number(v.value)))
      .map((v) => ({
        value: Number(v.value),
        label: String(v.description !== undefined ? v.description : v.label ?? ''),
      }));
    if (values.length === 0) values = undefined;
  } else if (rawValues && typeof rawValues === 'object') {
    // ArduPilot: {"0": "Label"}.
    values = Object.entries(rawValues).map(([value, label]) => ({
      value: Number(value),
      label: String(label),
    }));
  }

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
 * Compressed containers we can recognize but not decode. Recognizing them is
 * the whole point: PX4 publishes `parameters.json.xz` and serves it as
 * `Content-Type: application/json`, so the header is a lie and only the magic
 * number tells the truth.
 */
const ARCHIVE_MAGIC = [
  { name: 'XZ', bytes: [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00] },
  { name: 'gzip', bytes: [0x1f, 0x8b] },
  { name: 'zstd', bytes: [0x28, 0xb5, 0x2f, 0xfd] },
  { name: 'bzip2', bytes: [0x42, 0x5a, 0x68] },
  { name: 'Zip', bytes: [0x50, 0x4b, 0x03, 0x04] },
];

/**
 * ASCII-only excerpt for an error message. A raw `JSON.parse` failure quotes
 * whatever it choked on, which for a binary body means control characters and
 * replacement glyphs in the operator's editor.
 *
 * @param {Uint8Array} bytes
 * @param {number} [limit]
 * @returns {string}
 */
function printableHead(bytes, limit = 40) {
  let out = '';
  for (let i = 0; i < Math.min(bytes.length, limit); i += 1) {
    const code = bytes[i];
    out += code >= 0x20 && code < 0x7f ? String.fromCharCode(code) : '.';
  }
  return out;
}

async function defaultFetch(url) {
  const response = await globalThis.fetch(url, {
    signal: globalThis.AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${url}`);

  const bytes = new Uint8Array(await response.arrayBuffer());
  const archive = ARCHIVE_MAGIC.find((sig) => sig.bytes.every((b, i) => bytes[i] === b));
  if (archive) {
    throw new Error(
      `${url} is a ${archive.name} archive, not JSON. Parameter definitions must be an `
      + 'uncompressed JSON document; point at one, or decompress this file and host it yourself.'
    );
  }

  try {
    return JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch (err) {
    throw new Error(
      `${url} did not return JSON (starts with "${printableHead(bytes)}")`,
      { cause: err }
    );
  }
}

module.exports = {
  paramDefsPath,
  parsePdefJson,
  readParamDefs,
  updateParamDefs,
};
