'use strict';

/**
 * Source scan: input handlers must not pair node.error with bare done()/finish()
 * (DESIGN.md §2 / §9 — Catch via done(err) through reportDoneError).
 */

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const NODES_DIR = path.join(__dirname, '..', '..', 'nodes');

/**
 * Strip block and line comments so JSDoc / narrative do not trip the scan.
 *
 * @param {string} src
 * @returns {string}
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/**
 * node.error(...); then bare done() or finish() within a short window.
 * reportDoneError / done(err) are the allowed paths.
 */
const FORBIDDEN = /node\.error\s*\([\s\S]{0,200}?\);[\s\S]{0,80}?\b(?:done|finish)\s*\(\s*\)/;

test('action nodes do not pair node.error with bare done()/finish()', () => {
  const files = fs.readdirSync(NODES_DIR)
    .filter((name) => name.startsWith('mavlink-') && name.endsWith('.js'))
    .sort();
  assert.ok(files.length > 0, 'expected mavlink-*.js under nodes/');

  /** @type {string[]} */
  const hits = [];
  for (const file of files) {
    const src = stripComments(fs.readFileSync(path.join(NODES_DIR, file), 'utf8'));
    if (FORBIDDEN.test(src)) hits.push(file);
  }
  assert.deepEqual(
    hits,
    [],
    `use reportDoneError / done(err), not node.error then bare done()/finish(): ${hits.join(', ')}`
  );
});
