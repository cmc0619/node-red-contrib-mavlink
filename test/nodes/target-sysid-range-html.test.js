'use strict';

/**
 * Target / filter sysid fields are uint8 (0..255); blank means inherit / all.
 * Enforcement is defaults.validate — HTML min/max alone does not red the node.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const nodesDir = path.join(__dirname, '..', '..', 'nodes');

test('shared validateUint8 helper is two-arg (string return = invalid reason)', () => {
  // The helper is defined once in the shared editor resource (DESIGN.md §6);
  // node HTML only calls RED.mavlink.validateUint8(0).
  const resource = fs.readFileSync(
    path.join(__dirname, '..', '..', 'resources', 'mavlink-editor.js'),
    'utf8'
  );
  assert.match(resource, /RED\.mavlink\.validateUint8\s*=\s*function/);
  assert.match(
    resource,
    /validateUint8\s*=\s*function\s*\(\s*min\s*\)\s*\{\s*return\s*function\s*\(\s*v\s*,\s*_?opt/,
    'validator must take (v, opt) so a returned string fails validation'
  );
  assert.match(resource, /n < min \|\| n > 255/);
});

const TARGET_FILES = [
  ['mavlink-command.html', 'targetSystem'],
  ['mavlink-move.html', 'targetSystem'],
  ['mavlink-param.html', 'targetSystem'],
  ['mavlink-payload.html', 'targetSystem'],
  ['mavlink-mission.html', 'targetSystem'],
  ['mavlink-state.html', 'targetSystem'],
  ['mavlink-in.html', 'sysid'],
];

for (const [file, prop] of TARGET_FILES) {
  test(`${file}: ${prop} validates as uint8 0..255 and has min/max on the input`, () => {
    const html = fs.readFileSync(path.join(nodesDir, file), 'utf8');
    assert.match(
      html,
      new RegExp(`${prop}:\\s*\\{[\\s\\S]*?validate:\\s*RED\\.mavlink\\.validateUint8\\(0\\)`),
      `${prop} must use RED.mavlink.validateUint8(0)`
    );
    assert.match(
      html,
      new RegExp(`id="node-input-${prop}"[^>]*min="0"[^>]*max="255"|id="node-input-${prop}"[^>]*max="255"[^>]*min="0"`),
      `${prop} input must declare min=0 max=255`
    );
  });
}

test('vehicle defaultTargetSystem still uses the shared uint8 validator', () => {
  const html = fs.readFileSync(path.join(nodesDir, 'mavlink-vehicle.html'), 'utf8');
  assert.match(
    html,
    /defaultTargetSystem:\s*\{\s*value:\s*1,\s*validate:\s*RED\.mavlink\.validateUint8\(0\)/
  );
  assert.match(html, /id="node-config-input-defaultTargetSystem"[^>]*min="0"[^>]*max="255"/);
});
