'use strict';

/**
 * Drift guard: palette nodes must call lib/delivery / lib helpers rather than
 * re-declaring badge caps, status records, or band magic numbers (DESIGN.md §6/§14).
 */

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const nodesDir = path.join(__dirname, '..', '..', 'nodes');

function nodeJsSources() {
  return fs.readdirSync(nodesDir)
    .filter((name) => name.startsWith('mavlink-') && name.endsWith('.js'))
    .map((name) => ({
      name,
      text: fs.readFileSync(path.join(nodesDir, name), 'utf8'),
    }));
}

test('nodes do not redeclare BADGE_MAX or local cap/badge24 helpers', () => {
  for (const { name, text } of nodeJsSources()) {
    assert.doesNotMatch(text, /BADGE_MAX\s*=\s*24/, `${name}: no local BADGE_MAX`);
    assert.doesNotMatch(text, /function\s+cap\s*\(/, `${name}: no local cap()`);
    assert.doesNotMatch(text, /function\s+badge24\s*\(/, `${name}: no local badge24()`);
    assert.doesNotMatch(text, /BAND_CONTROL\s*=/, `${name}: use BAND.CONTROL`);
  }
});

test('In does not double-cap badge text', () => {
  const text = fs.readFileSync(path.join(nodesDir, 'mavlink-in.js'), 'utf8');
  assert.doesNotMatch(text, /capBadge\([^)]+\)\.slice\(/);
});

test('Move and Swarm share lib/move config mappers and Swarm uses mergeParams', () => {
  const move = fs.readFileSync(path.join(nodesDir, 'mavlink-move.js'), 'utf8');
  const swarm = fs.readFileSync(path.join(nodesDir, 'mavlink-swarm.js'), 'utf8');
  assert.match(move, /positionFrom,\s*\n\s*velocityFrom,\s*\n\s*valueFrom/);
  assert.match(move, /require\('\.\.\/lib\/move'\)/);
  assert.match(swarm, /require\('\.\.\/lib\/move'\)/);
  assert.match(swarm, /mergeParams\(/);
  assert.doesNotMatch(swarm, /function\s+positionFrom\s*\(/);
  assert.doesNotMatch(swarm, /function\s+numericPayloadParams\s*\(/);
});
