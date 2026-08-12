'use strict';

/**
 * The identity row is labelled **Identity** in every editor that has one.
 *
 * It used to read *Send as*, which is the wire-message selector's label on
 * Command, Payload and Formation (§6 — the options there are the literal
 * MAVLink messages). Two rows wearing one label in the same dialog is a
 * question the operator cannot answer from the form: the two choose unrelated
 * things — who the frame claims to be from, and which message carries it.
 *
 * Swept rather than asserted per node: six editors carry the row today, the
 * check is identical for each, and a seventh added later inherits the guard
 * instead of quietly skipping it.
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

const IDENTITY_LABEL = /<label[^>]*for=["']node-input-identity["'][^>]*>([^<]*)<\/label>/g;

test('some editor actually carries an identity row (the sweep is not vacuous)', () => {
  const withRow = EDITORS.filter((name) =>
    new RegExp(IDENTITY_LABEL.source).test(fs.readFileSync(path.join(NODES_DIR, name), 'utf8'))
  );
  assert.ok(withRow.length >= 6, `expected the identity row in six editors, found ${withRow.length}`);
});

for (const name of EDITORS) {
  test(`${name}: the identity row is labelled Identity, never Send as`, () => {
    const html = fs.readFileSync(path.join(NODES_DIR, name), 'utf8');
    const labels = [...html.matchAll(IDENTITY_LABEL)].map((m) => m[1].trim());
    for (const label of labels) {
      assert.equal(label, 'Identity', `identity row reads "${label}"`);
    }
  });
}
