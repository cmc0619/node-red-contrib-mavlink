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

test('Move uses lib/move config mappers; Fan-out imports no message builders (§10)', () => {
  const move = fs.readFileSync(path.join(nodesDir, 'mavlink-move.js'), 'utf8');
  const fanout = fs.readFileSync(path.join(nodesDir, 'mavlink-fanout.js'), 'utf8');
  // Assert each mapper by name, not the destructuring layout: a reformat or a
  // reorder must not fail a test about *where the code lives*.
  for (const mapper of ['positionFrom', 'velocityFrom', 'accelFrom', 'valueFrom']) {
    assert.match(move, new RegExp(`\\b${mapper}\\b`), `Move uses ${mapper}`);
    assert.doesNotMatch(
      move,
      new RegExp(`function\\s+${mapper}\\s*\\(`),
      `Move must not redeclare ${mapper} locally`
    );
  }
  assert.match(move, /require\('\.\.\/lib\/move'\)/);
  // Fan-out is a replicator: message construction lives in the action nodes'
  // Build tiers, so no builder module may be imported here.
  assert.doesNotMatch(fanout, /require\('\.\.\/lib\/move'\)/);
  assert.doesNotMatch(fanout, /mergeParams|buildCommand|buildMoveMessage|buildPayloadMessage|buildParamMessage/);
});
