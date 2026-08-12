'use strict';

/**
 * An editor validator that returns a reason string must declare `(v, opt)`.
 *
 * DESIGN §14 (measured on the editor client, Node-RED 4/5, same rule since
 * 3.x): Node-RED only treats a returned string as an invalid *reason* when the
 * validator's arity is 2. A one-argument validator has its return coerced with
 * `!!`, so a non-empty reason string is truthy and the field **passes** — the
 * guard reads as working, reds nothing, and the reason never renders.
 *
 * This is invisible at every other level. The validator is correct in
 * isolation, and a unit test that calls it directly gets the string back and
 * asserts it happily — which is exactly how `mavlink-move`'s Body-on-Build gate
 * shipped dead: one arg, a reason string, and a test that called it with
 * `.call(this, 'body', {})` and never exercised the arity path at all.
 *
 * Swept rather than asserted per node: the failure is silent, the check is
 * identical for each editor, and a validator added later inherits the guard
 * instead of quietly skipping it. Boolean-only validators are left alone — a
 * one-arg validator that never returns a reason is legitimate, and ten of them
 * are in the tree today.
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

/** Inline `validate: function (…) {` — `RED.validators.*` factories are not ours to check. */
const VALIDATOR = /validate:\s*function\s*\(([^)]*)\)\s*\{/g;

/**
 * The function body starting at its opening brace, by brace matching. Good
 * enough for editor source: these validators hold no brace-bearing string or
 * regex literals, and the sweep's own vacuity test would catch it drifting.
 *
 * @param {string} src
 * @param {number} open  index of the opening brace
 * @returns {string}
 */
function bodyAt(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return src.slice(open);
}

/**
 * Every inline validator in one editor, with the facts the rule needs.
 *
 * @param {string} name  editor filename
 * @returns {Array<{name: string, line: number, arity: number, returnsReason: boolean}>}
 */
function validatorsIn(name) {
  const src = fs.readFileSync(path.join(NODES_DIR, name), 'utf8');
  const found = [];
  for (const match of src.matchAll(VALIDATOR)) {
    const arity = match[1].split(',').map((p) => p.trim()).filter(Boolean).length;
    const body = bodyAt(src, match.index + match[0].length - 1);
    found.push({
      name,
      line: src.slice(0, match.index).split('\n').length,
      arity,
      returnsReason: /return\s+['"`]/.test(body),
    });
  }
  return found;
}

const ALL = EDITORS.flatMap(validatorsIn);

test('the sweep sees inline validators at all (it is not vacuous)', () => {
  assert.ok(ALL.length >= 20, `expected 20+ inline validators across the editors, found ${ALL.length}`);
  assert.ok(
    ALL.some((v) => v.returnsReason),
    'expected at least one validator returning a reason string — the rule has nothing to guard otherwise'
  );
});

for (const name of EDITORS) {
  const reasoned = ALL.filter((v) => v.name === name && v.returnsReason);
  if (reasoned.length === 0) continue;
  test(`${name}: every validator returning a reason string declares (v, opt)`, () => {
    const dead = reasoned.filter((v) => v.arity !== 2);
    assert.deepEqual(
      dead.map((v) => `${v.name}:${v.line} (arity ${v.arity})`),
      [],
      'a one-arg validator returning a reason string always passes — DESIGN §14'
    );
  });
}
