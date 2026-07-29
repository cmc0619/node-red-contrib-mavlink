'use strict';

/**
 * Vehicle type must still register and load a seeded dialect when
 * mavlink-mappings is unavailable — metadata no longer depends on it.
 *
 * Runs the stub program in a child process so parallel suite workers that
 * already loaded mavlink-mappings cannot poison the stub.
 */

const { spawnSync } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const FIXTURE = path.join(__dirname, 'fixtures', 'register-without-mappings-child.js');

test('mavlink-vehicle registers even when mavlink-mappings cannot be loaded', () => {
  const result = spawnSync(process.execPath, [FIXTURE], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /OK/);
});
