'use strict';

/**
 * Target / filter sysid fields are uint8 (0..255); blank means inherit / all.
 * Enforcement is defaults.validate — HTML min/max alone does not red the node.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { installEditorHelpers } = require('../helpers/editor-resource');

const nodesDir = path.join(__dirname, '..', '..', 'nodes');

test('shared validateUint8 helper is two-arg (string return = invalid reason)', () => {
  // The helper is defined once in the shared editor resource (DESIGN.md §6);
  // node HTML only calls RED.mavlink.validateUint8(0).
  const resource = fs.readFileSync(
    path.join(__dirname, '..', '..', 'resources', 'mavlink-editor.js'),
    'utf8'
  );
  assert.match(resource, /RED\.mavlink\.validateUint8\s*=\s*function/);

  // Behaviour, not source text: validateUint8 delegates to the shared
  // validateIntRange, so pinning its inlined body pinned an implementation
  // detail. What must hold is the contract — two-arg, and 0..255.
  const context = { RED: { mavlink: {} }, $: () => ({ length: 0, val: () => undefined }) };
  installEditorHelpers(context);
  const validate = context.RED.mavlink.validateUint8(0);

  assert.equal(validate.length, 2, 'two-arg, so a returned string fails validation');
  assert.equal(validate(0), true, 'broadcast id');
  assert.equal(validate(255), true, 'the uint8 ceiling');
  assert.equal(validate(''), true, 'blank means inherit / all');
  assert.match(String(validate(256)), /between 0 and 255/, 'a string is the invalid reason');
  assert.match(String(validate(-1)), /between 0 and 255/);
  assert.match(String(validate(1.5)), /integer/);
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

/**
 * The `prop: { … }` descriptor body, brace-matched. A lazy `[\s\S]*?` span
 * could satisfy itself from a *later* property's validator, which matters now
 * that some of these descriptors carry a conditional wrapper rather than a
 * one-line validator (#260).
 *
 * @param {string} html
 * @param {string} prop
 * @returns {string}
 */
function descriptorBlock(html, prop) {
  const start = html.search(new RegExp(`${prop}:\\s*\\{`));
  assert.ok(start >= 0, `${prop} descriptor not found`);
  const open = html.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) return html.slice(open, i + 1);
  }
  throw new Error(`unbalanced braces in ${prop} descriptor`);
}

for (const [file, prop] of TARGET_FILES) {
  test(`${file}: ${prop} validates as uint8 0..255 and has min/max on the input`, () => {
    const html = fs.readFileSync(path.join(nodesDir, file), 'utf8');
    // The range rule must come from the shared helper, not a reimplementation —
    // reached directly or through a conditional wrapper (§6, #260).
    assert.match(
      descriptorBlock(html, prop),
      /RED\.mavlink\.validateUint8\(0\)/,
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

// ── Broadcast on an ack-confirmed tier is refused at deploy, not first input ──
//
// The runtime guard (#260) still covers the rungs the editor cannot see — a
// Vehicle Profile default and a msg.payload.target override — but a statically
// configured sysid 0 on a confirm tier is a cross-field static requirement, so
// AGENTS puts it in the editor ("conditional validation when requirements
// depend on another configured field").
//
// Payload is deliberately absent: its editor has no verb→confirmation map
// (PAYLOAD_VERBS carries labels only), and a recipe whose kind is 'message'
// resolves confirmation 'none' and legitimately broadcasts on the confirm tier
// by falling through to an unconfirmed send. An unconditional validator there
// would red a legal flow.
const CONDITIONAL_BROADCAST_FILES = [
  ['mavlink-command.html', "liveOr('#node-input-delivery'"],
  ['mavlink-move.html', "liveOr('#node-input-carrier'"],
];

for (const [file, gate] of CONDITIONAL_BROADCAST_FILES) {
  test(`${file}: targetSystem reds a configured broadcast on the ack-confirmed tier (#260)`, () => {
    const html = fs.readFileSync(path.join(nodesDir, file), 'utf8');
    const block = descriptorBlock(html, 'targetSystem');
    assert.match(block, /Number\(v\) !== 0/, 'the rule must key on a literal 0');
    assert.match(block, /cannot be confirmed/, 'the reason must say why, not just fail');
    assert.ok(
      block.includes(gate),
      `the rule must be gated on the tier/carrier field, not applied unconditionally (${gate})`
    );
    // Gating uses the node-first helper rather than a bare global selector:
    // a raw $('#node-input-…') read is the cross-dialog leak shape of #217.
    assert.ok(!/\$\(\s*['"]#node-input-/.test(block), 'gate via RED.mavlink.liveOr, not a raw selector');
  });
}

test('mavlink-payload.html: targetSystem stays unconditional — its editor cannot know the ack mode (#260)', () => {
  const html = fs.readFileSync(path.join(nodesDir, 'mavlink-payload.html'), 'utf8');
  assert.doesNotMatch(
    descriptorBlock(html, 'targetSystem'),
    /cannot be confirmed/,
    'a message-kind recipe (confirmation "none") broadcasts legally on the confirm tier'
  );
});
