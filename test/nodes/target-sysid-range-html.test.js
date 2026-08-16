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
    // The range rule must come from the shared helpers, not a
    // reimplementation — validateUint8 directly, or validateTargetSystem,
    // which layers the broadcast-on-an-acked-tier rule over it (§6, #260).
    assert.match(
      descriptorBlock(html, prop),
      /RED\.mavlink\.(validateUint8\(0\)|validateTargetSystem\()/,
      `${prop} must use a shared RED.mavlink target validator`
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
  // [file, the tiers that wait for a reply]
  ['mavlink-command.html', ['confirm', 'complete']],
  // Move gates on delivery too since the Action surface (§6 redesign):
  // Send & confirm is only offered on the Go to action, so the tier field
  // alone carries the rule — the carrier field it used to read is gone.
  ['mavlink-move.html', ['confirm']],
  // Every Param action waits for a reply, so every tier is gated — including
  // Build, since a built broadcast PARAM_SET forwarded to mavlink-out is the
  // same fleet-wide write.
  ['mavlink-param.html', ['build', 'send', 'confirm', 'collect']],
  ['mavlink-payload.html', ['confirm']],
];

for (const [file, tiers] of CONDITIONAL_BROADCAST_FILES) {
  test(`${file}: targetSystem reds a configured broadcast on the acked tiers (#260)`, () => {
    const html = fs.readFileSync(path.join(nodesDir, file), 'utf8');
    const block = descriptorBlock(html, 'targetSystem');
    // One helper, not a copy per node: the rule and its wording live in the
    // shared editor resource, so the four cannot drift apart.
    assert.match(block, /RED\.mavlink\.validateTargetSystem\(/);
    for (const tier of tiers) {
      assert.ok(block.includes(`'${tier}'`), `${tier} must be listed as an acked tier`);
    }
  });
}

// The pins above read source text, which cannot catch a validator that is
// present but wrong. It happened: the first cut of these conditionals rejected
// a *blank* targetSystem on the confirm tier, because Number('') is 0 and the
// broadcast check ran before any blank test — reddening the commonest config
// (blank = inherit the profile target) while every source pin stayed green.
// So evaluate the real descriptor and call it (CodeRabbit).
const vm = require('node:vm');

/**
 * Evaluate a node HTML's `targetSystem` descriptor and return its validator,
 * bound to a given saved-config object.
 *
 * @param {string} file  node HTML filename
 * @param {object} saved  the node config `this` the validator reads
 * @returns {(v: *) => true|string}
 */
function targetSystemValidator(file, saved) {
  const html = fs.readFileSync(path.join(nodesDir, file), 'utf8');
  const context = {
    RED: { mavlink: {}, validators: { number: () => () => true } },
    // No dialog is open in a test, so every live read misses and liveOr falls
    // back to the saved value — the node-first half of the helper.
    $: () => ({ length: 0, val: () => undefined }),
  };
  installEditorHelpers(context);
  const descriptor = vm.runInNewContext(`({ ${descriptorBlock(html, 'targetSystem').replace(/^\{/, '').replace(/\}$/, '')} })`, context);
  return (v) => descriptor.validate.call(saved, v, {});
}

for (const [file, tierField, tierValue] of [
  ['mavlink-command.html', 'delivery', 'confirm'],
  ['mavlink-move.html', 'delivery', 'confirm'],
]) {
  test(`${file}: a blank targetSystem still inherits on the ${tierValue} tier (#260 regression)`, () => {
    // Confirm implies the acked path on both nodes now — Move's editor only
    // offers the tier on the Go to action, so the saved action rides along
    // for realism but the validator keys on delivery alone.
    const saved = { [tierField]: tierValue, action: 'goto' };
    const validate = targetSystemValidator(file, saved);

    assert.equal(validate(''), true, "blank means inherit the profile target — Number('') is 0, but blank is not broadcast");
    assert.equal(validate(undefined), true, 'an unset field inherits too');
    assert.equal(validate(1), true, 'a real sysid is fine');
    assert.match(String(validate(0)), /cannot be confirmed/, 'an explicit 0 is still refused');
    assert.match(String(validate('0')), /cannot be confirmed/, 'the string form the editor stores is refused too');
  });
}

test('mavlink-command.html: an explicit 0 stays valid on the Send tier (#260)', () => {
  const validate = targetSystemValidator('mavlink-command.html', { delivery: 'send' });
  assert.equal(validate(0), true, 'broadcast addressing is a designed capability where no ack is awaited');
  assert.equal(validate(''), true);
});

test('mavlink-move.html: an explicit 0 stays valid on the unacked tiers (#260)', () => {
  // The old form of this test saved {delivery:'confirm', carrier:'setpoint'}
  // — a combo the Action surface makes unrepresentable (confirm is only
  // offered on Go to). What survives is the real rule: broadcast is legal
  // wherever no ack is awaited.
  for (const delivery of ['send', 'stream', 'build']) {
    const validate = targetSystemValidator('mavlink-move.html', { delivery, action: 'steer' });
    assert.equal(validate(0), true, `broadcast is legal on ${delivery} — nothing awaits an ack`);
  }
});

test('mavlink-payload.html: targetSystem stays unconditional — its editor cannot know the ack mode (#260)', () => {
  const html = fs.readFileSync(path.join(nodesDir, 'mavlink-payload.html'), 'utf8');
  assert.doesNotMatch(
    descriptorBlock(html, 'targetSystem'),
    /cannot be confirmed/,
    'a message-kind recipe (confirmation "none") broadcasts legally on the confirm tier'
  );
});
