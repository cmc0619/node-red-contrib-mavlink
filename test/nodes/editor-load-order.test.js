'use strict';

/**
 * The editor's `RED.mavlink` load-order guarantee (DESIGN.md §6).
 *
 * `mavlink-editor.js` is loaded through Node-RED's resource mechanism, and
 * `appendConfig` defers every inline node script until that relative-`src`
 * script's onload fires. So `RED.mavlink` exists before any `registerType`
 * runs — and the node files rely on that *at parse time*, inside their
 * `defaults` blocks, where no guard could help anyway.
 *
 * That makes an `if (RED.mavlink && …)` existence check inside a handler
 * strictly harmful: it cannot fire, and if the guarantee ever broke it would
 * convert a loud registration failure into a silently degraded dialog — a
 * dialog missing its pickers and enum pulldowns, with nothing in the log.
 * The repo's rule is the other way round (§2: fail loud).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const NODES = path.join(__dirname, '..', '..', 'nodes');
const EDITOR = path.join(__dirname, '..', '..', 'resources', 'mavlink-editor.js');

/** Every node HTML file, as [name, source]. */
function nodeFiles() {
  return fs.readdirSync(NODES)
    .filter((f) => f.endsWith('.html'))
    .map((f) => [f, fs.readFileSync(path.join(NODES, f), 'utf8')]);
}

test('registration dereferences RED.mavlink unguarded — the guarantee is load-bearing (§6)', () => {
  // This is the keystone: these calls run while `defaults` is being evaluated,
  // before any handler exists. If RED.mavlink were absent the node type would
  // fail to register at all, loudly. Any file below proves the guarantee.
  const parseTime = nodeFiles().filter(([, src]) => {
    const start = src.indexOf('defaults:');
    if (start === -1) return false;
    return /RED\.mavlink\./.test(src.slice(start, src.indexOf('inputs:', start)));
  });

  assert.ok(
    parseTime.length >= 5,
    `expected several files to deref RED.mavlink at parse time, found ${parseTime.length}`
  );
});

test('mavlink-local-identity is the first node-red.nodes entry — it loads the editor resource (§6)', () => {
  // The other half of the guarantee: mavlink-local-identity is the only node
  // HTML that loads resources/mavlink-editor.js, and Node-RED appends node
  // HTML sequentially. Measured on Node-RED 5.0.1: moving it last leaves 2 of
  // 10 palette nodes registered, with a TypeError on RED.mavlink.validateUint8.
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
  assert.equal(Object.keys(pkg['node-red'].nodes)[0], 'mavlink-local-identity');
});

test('no editor-API existence guards — they can only degrade a hard failure (§6)', () => {
  // Same rule for the platform's own editor APIs: `RED.nodes`, `RED.editor`,
  // and `$` are unconditionally present in any editor that rendered the
  // dialog, so guarding them (`RED.nodes && …`, `typeof $ !== 'undefined'`)
  // converts a loud failure into a silently degraded dialog too.
  const GUARD = /RED\.(mavlink|nodes|editor)\s*&&|typeof\s+(\$|RED\.(mavlink|nodes|editor))[.\w]*\s*[!=]==/;
  const offenders = [];
  for (const [name, src] of nodeFiles()) {
    src.split('\n').forEach((line, i) => {
      if (GUARD.test(line)) offenders.push(`nodes/${name}:${i + 1}`);
    });
  }
  // mavlink-editor.js must not guard itself either: a function assigned to
  // RED.mavlink cannot run without RED.mavlink existing.
  fs.readFileSync(EDITOR, 'utf8').split('\n').forEach((line, i) => {
    if (GUARD.test(line)) offenders.push(`resources/mavlink-editor.js:${i + 1}`);
  });

  assert.deepEqual(offenders, [], `editor-API existence guards must not come back:\n${offenders.join('\n')}`);
});
