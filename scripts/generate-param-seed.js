#!/usr/bin/env node
'use strict';

/**
 * Build the shipped parameter-definition seed (DESIGN.md §4).
 *
 * Mirrors `scripts/generate-seed.js`: one stamped gzip blob plus a tiny
 * pointer, regenerated explicitly so a newer upstream never silently changes a
 * deployed flow.
 *
 *   seed/params-active.json                    → { "file": "param-defs-…seed.gz", … }
 *   seed/param-defs-YYYY-MM-DD-<hash>.seed.gz  → gunzip → JSON (see below)
 *
 * Upstream publishes one document per ArduPilot vehicle and one for PX4, and
 * each is stored here exactly as parsed. The six ArduPilot vehicles do overlap
 * almost completely — 6649 of 6827 ids are byte-identical across every vehicle
 * that has them — but hoisting the common ones into a shared table to save
 * ~670 KB gzipped buys nothing at this package size and costs a fold, an
 * unfold, and two shapes to reason about. Whole maps, no cleverness.
 *
 *   {
 *     stamp, generatedAt, sources: [{firmware, vehicle, url, bytes}],
 *     firmwares: {
 *       ardupilot: { vehicles: {ArduCopter: {ID: def}, ArduPlane: {…}, …} },
 *       px4:       { vehicles: {default: {ID: def}} }
 *     }
 *   }
 *
 * Regenerate:
 *   npm run generate-param-seed
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const { parsePdefJson, paramDocumentFromXml } = require('../lib/param/defs');

const REPO_ROOT = path.resolve(__dirname, '..');
const SEED_DIR = path.join(REPO_ROOT, 'seed');
const ACTIVE_FILE = path.join(SEED_DIR, 'params-active.json');

/**
 * Upstream sources. ArduPilot publishes one document per vehicle type; PX4
 * publishes a single `_general` document — and only its XML is uncompressed
 * (`parameters.json` exists solely as an `.xz`, which this project refuses by
 * name rather than decoding).
 */
const SOURCES = [
  { firmware: 'ardupilot', vehicle: 'ArduCopter', url: 'https://autotest.ardupilot.org/Parameters/ArduCopter/apm.pdef.json' },
  { firmware: 'ardupilot', vehicle: 'ArduPlane', url: 'https://autotest.ardupilot.org/Parameters/ArduPlane/apm.pdef.json' },
  { firmware: 'ardupilot', vehicle: 'Rover', url: 'https://autotest.ardupilot.org/Parameters/Rover/apm.pdef.json' },
  { firmware: 'ardupilot', vehicle: 'ArduSub', url: 'https://autotest.ardupilot.org/Parameters/ArduSub/apm.pdef.json' },
  { firmware: 'ardupilot', vehicle: 'Blimp', url: 'https://autotest.ardupilot.org/Parameters/Blimp/apm.pdef.json' },
  { firmware: 'ardupilot', vehicle: 'AntennaTracker', url: 'https://autotest.ardupilot.org/Parameters/AntennaTracker/apm.pdef.json' },
  { firmware: 'px4', vehicle: '', url: 'https://artifacts.px4.io/Firmware/_general/parameters.xml' },
];

/**
 * @param {string} text
 * @returns {string} first 7 hex characters of the sha256
 */
function shortHash(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 7);
}

/**
 * @param {string} url
 * @returns {Promise<string>}
 */
async function fetchText(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${url}`);
  return response.text();
}

/**
 * Normalize one upstream document to `Map<id, def>` using the same parser the
 * runtime uses, so a seeded definition and a downloaded one are the same shape
 * by construction rather than by agreement.
 *
 * @param {string} text
 * @returns {Map<string, object>}
 */
function normalize(text) {
  const document = text.trimStart().startsWith('<')
    ? paramDocumentFromXml(text)
    : JSON.parse(text);
  return parsePdefJson(document);
}

async function main() {
  const byFirmware = new Map();
  const sources = [];

  for (const source of SOURCES) {
    process.stderr.write(`fetching ${source.firmware}${source.vehicle ? `/${source.vehicle}` : ''} … `);
    const text = await fetchText(source.url);
    const map = normalize(text);
    if (map.size === 0) throw new Error(`${source.url} yielded no parameter definitions`);
    process.stderr.write(`${map.size} parameters\n`);

    sources.push({
      firmware: source.firmware,
      vehicle: source.vehicle,
      url: source.url,
      bytes: Buffer.byteLength(text, 'utf8'),
      parameters: map.size,
    });
    if (!byFirmware.has(source.firmware)) byFirmware.set(source.firmware, new Map());
    byFirmware.get(source.firmware).set(source.vehicle || 'default', map);
  }

  const firmwares = {};
  for (const [firmware, byVehicle] of byFirmware) {
    const vehicles = {};
    for (const [vehicle, map] of byVehicle) vehicles[vehicle] = Object.fromEntries(map);
    firmwares[firmware] = { vehicles };
    process.stderr.write(
      `${firmware}: ${Object.keys(vehicles).length} vehicle(s), `
      + `${Object.values(vehicles).reduce((n, v) => n + Object.keys(v).length, 0)} definitions\n`
    );
  }

  const body = { sources, firmwares };
  const encoded = JSON.stringify(body);
  const stamp = `${new Date().toISOString().slice(0, 10)}-${shortHash(encoded)}`;
  const fileName = `param-defs-${stamp}.seed.gz`;
  const seedFile = path.join(SEED_DIR, fileName);

  const blob = zlib.gzipSync(
    JSON.stringify({ stamp, generatedAt: new Date().toISOString(), ...body }),
    { level: 9 }
  );

  fs.mkdirSync(SEED_DIR, { recursive: true });
  fs.writeFileSync(seedFile, blob);
  fs.writeFileSync(
    ACTIVE_FILE,
    `${JSON.stringify({ file: fileName, stamp, generatedAt: new Date().toISOString(), sources }, null, 2)}\n`
  );

  // Old blobs are dead weight in the published package; the pointer names
  // exactly one.
  for (const name of fs.readdirSync(SEED_DIR)) {
    if (name.startsWith('param-defs-') && name.endsWith('.seed.gz') && name !== fileName) {
      fs.unlinkSync(path.join(SEED_DIR, name));
      process.stderr.write(`removed superseded ${name}\n`);
    }
  }

  process.stderr.write(`\nwrote ${path.relative(REPO_ROOT, seedFile)} (${blob.length} bytes gzipped)\n`);
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err.message}\n`);
  process.exitCode = 1;
});
