'use strict';

/**
 * Every `$('#id')` an editor script reaches for must name an element that
 * editor's own template defines.
 *
 * A selector that matches nothing is silent: jQuery returns an empty set,
 * `.val()` returns undefined, and the feature behind it simply never appears.
 * That is how the Force checkbox on Arm/Disarm shipped dead — the renderer
 * asked `#node-input-commandId` for the MAV_CMD, an id no template has (the
 * real one is `#node-input-advancedCommand`), so the magic-boolean lookup was
 * always keyed `"undefined:2"` and always missed. Unit tests on the helper
 * passed the whole time, because the helper was fine.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const NODES_DIR = path.join(__dirname, '..', '..', 'nodes');

const EDITORS = fs
  .readdirSync(NODES_DIR)
  .filter((name) => name.endsWith('.html'))
  .sort();

test('editors have html to check', () => {
  assert.ok(EDITORS.length > 0);
});

for (const name of EDITORS) {
  test(`${name}: every $('#id') selector names an element the template defines`, () => {
    const html = fs.readFileSync(path.join(NODES_DIR, name), 'utf8');
    const used = new Set(
      [...html.matchAll(/\$\(\s*['"]#([A-Za-z0-9_-]+)['"]\s*\)/g)].map((m) => m[1])
    );
    const defined = new Set(
      [...html.matchAll(/id=["']([A-Za-z0-9_-]+)["']/g)].map((m) => m[1])
    );
    const missing = [...used].filter((id) => !defined.has(id));
    assert.deepEqual(missing, [], `selectors match no element: ${missing.join(', ')}`);
  });
}
