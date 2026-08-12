'use strict';

/**
 * mavlink-move editor: Action × Delivery drive the form (DESIGN.md §6
 * redesign, 2026-08-12). The operator states an intent — goto or steer — and
 * no dropdown may offer an option the current selection makes illegal:
 * delivery options are rebuilt per action, goto shows only the global
 * position, and steer never shows the command-path params.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { assertChangeHandlerContains, loadNodeDefaults } = require('./html-assert');

const html = fs.readFileSync(
  path.join(__dirname, '..', '..', 'nodes', 'mavlink-move.html'),
  'utf8'
);

const ROW_IDS = [
  'row-move-altRef',
  'row-move-reference',
  'row-move-speed',
  'row-move-radius',
  'row-move-changeMode',
  'row-move-ackTimeout',
  'row-move-north',
  'row-move-east',
  'row-move-up',
  'row-move-lat',
  'row-move-lon',
  'row-move-alt',
  'row-move-vNorth',
  'row-move-vEast',
  'row-move-vUp',
  'row-move-aNorth',
  'row-move-aEast',
  'row-move-aUp',
  'row-move-yaw',
  'row-move-yawRate',
  'row-move-rate',
  'row-move-ttl',
];

test('mavlink-move editor reshapes fields by action and delivery (§6)', () => {
  assert.match(html, /function refreshVisibility/, 'action/delivery drive row visibility');
  assert.match(
    html,
    /\$\('#node-input-action'\)\.on\('change', refreshVisibility\)/,
    'action change refreshes visibility'
  );
  assert.match(
    html,
    /\$\('#node-input-altRef'\)\.on\('change', refreshVisibility\)/,
    'altitude-reference change refreshes visibility'
  );
  assert.match(
    html,
    /\$\('#node-input-reference'\)\.on\('change', refreshVisibility\)/,
    'reference change refreshes visibility'
  );
  assertChangeHandlerContains(
    html,
    "$('#node-input-delivery')",
    'RED.mavlink.reloadTargetCompId(node)',
    'delivery change refreshes CompID catalog'
  );
  assert.match(html, /refreshVisibility\(\)/, 'visibility is applied on dialog open');

  for (const id of ROW_IDS) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} row must exist`);
  }

  // The gates themselves: goto owns the global position + altitude reference;
  // steer owns the reference and the optional field groups; the command-path
  // params exist only on goto's Build/Send/Send & confirm.
  assert.match(html, /altRef:\s*isGoto/, 'altitude reference shown on goto only');
  assert.match(html, /lat:\s*isGoto/, 'global position gated on goto');
  assert.match(html, /reference:\s*!isGoto/, 'reference shown on steer only');
  assert.match(html, /north:\s*!isGoto/, 'steer position fields gated on steer');
  assert.match(html, /vNorth:\s*!isGoto/, 'velocity fields gated on steer');
  assert.match(html, /aNorth:\s*!isGoto/, 'accel fields gated on steer');
  assert.match(html, /yawRate:\s*!isGoto/, 'yaw rate is a setpoint field — steer only');
  assert.match(html, /var isCommandPath = isGoto && !isStream/, 'the command path is goto off Stream');
  assert.match(html, /speed:\s*isCommandPath/, 'ground speed hides on Stream (the runtime refuses it there)');
  assert.match(html, /radius:\s*isCommandPath/, 'loiter radius hides on Stream');
  assert.match(html, /changeMode:\s*isCommandPath/, 'change mode hides on Stream');
  assert.match(html, /ackTimeout:\s*isGoto && delivery === 'confirm'/, 'ACK timeout on goto confirm only');
  assert.match(html, /delivery === 'stream'/, 'stream rate and TTL gated on delivery');
});

test('mavlink-move Action surface: goto default, both actions offered, retired fields gone', () => {
  // A wrong or missing default changes the wire message for every Move node
  // that never touched the field; goto is the acked direction the redesign
  // leads with.
  assert.match(html, /action:\s*\{\s*value:\s*'goto'\s*\}/, 'action defaults to goto');
  assert.match(html, /option value="goto"/, 'goto action offered');
  assert.match(html, /option value="steer"/, 'steer action offered');
  assert.match(html, /altRef:\s*\{\s*value:\s*'home'\s*\}/, 'altRef defaults to home (the GCS default)');
  // Defaults-based, not a source regex: reference grew a validator (Codex
  // #277 Body-on-Build gate) so its literal is no longer one line.
  assert.equal(loadNodeDefaults('mavlink-move').reference.value, 'world', 'reference defaults to world (works everywhere)');

  // The old carrier/mode/frame triple and the PX4-compat checkbox are
  // retired, not hidden (YAGNI, pre-1.0: delete and re-pick). The wire
  // number is code now, so no field of any spelling may survive.
  for (const gone of ['carrier', 'mode', 'frame', 'px4Compat']) {
    assert.doesNotMatch(
      html,
      new RegExp(`node-input-${gone}"`),
      `retired field ${gone} must have no input`
    );
    assert.doesNotMatch(
      html,
      new RegExp(`row-move-${gone}"`),
      `retired field ${gone} must have no row`
    );
  }
  assert.doesNotMatch(html, /FRAME_COMPAT/, 'the *_INT canonicalization map died with the frame field');
  // The frame is derived, never picked: no MAV_FRAME select options of any
  // spelling (the help may still *name* frames when explaining the derivation).
  for (const frame of [
    'LOCAL_NED',
    'LOCAL_OFFSET_NED',
    'BODY_OFFSET_NED',
    'BODY_NED',
    'GLOBAL_RELATIVE_ALT',
    'GLOBAL',
    'GLOBAL_TERRAIN_ALT',
    'GLOBAL_RELATIVE_ALT_INT',
  ]) {
    assert.doesNotMatch(
      html,
      new RegExp(`option value="${frame}"`),
      `no frame option ${frame}`
    );
  }
  // No raw type_mask input — the mask derives from filled fields; raw masks
  // live in mavlink-build.
  assert.doesNotMatch(html, /type_?[mM]ask"|node-input-typeMask/, 'no raw type_mask field');
});

test('mavlink-move delivery options are rebuilt per action — confirm is goto-only (§9)', () => {
  assert.match(html, /function refreshDeliveryOptions/, 'the delivery select is rebuilt, not just toggled');
  const map = /var DELIVERY_OPTIONS = \{[\s\S]*?\n {6}\};/.exec(html);
  assert.ok(map, 'DELIVERY_OPTIONS map must be extractable');
  const steer = /steer:\s*\[[\s\S]*?\n {8}\]/.exec(map[0]);
  assert.ok(steer, 'steer option list must be extractable');
  assert.doesNotMatch(steer[0], /confirm/, 'steer setpoints carry no ack — confirm is never offered');
  const goto = /goto:\s*\[[\s\S]*?\n {8}\]/.exec(map[0]);
  assert.ok(goto, 'goto option list must be extractable');
  for (const tier of ['build', 'send', 'confirm', 'stream']) {
    assert.match(goto[0], new RegExp(`'${tier}'`), `goto offers ${tier}`);
  }
  for (const tier of ['build', 'send', 'stream']) {
    assert.match(steer[0], new RegExp(`'${tier}'`), `steer offers ${tier}`);
  }
  // The saved (or in-progress) value survives when still legal; an illegal
  // one falls back to Send — still a wire tier, like the old coercion.
  assert.match(html, /\[live, node\.delivery\]\.filter/, 'live then saved value preserved when legal');
  assert.match(html, /\$delivery\.val\(keep \|\| 'send'\)/, 'illegal saved delivery falls back to Send');
});

test('mavlink-move goto requires the global position at deploy, steer requires nothing', () => {
  // Behavioral, not grep: the validators mirror the runtime's
  // §10 rule ("blank coordinates must not become 0,0 at ground level") — the
  // editor now owns it outright, required on goto, saved or live, silent on steer,
  // where the runtime derives the mode from what is filled and refuses an
  // all-blank steer at input time.
  const defaults = loadNodeDefaults('mavlink-move');
  const gotoNode = { action: 'goto' };
  const steerNode = { action: 'steer' };

  for (const field of ['lat', 'lon', 'alt']) {
    assert.match(
      String(defaults[field].validate.call(gotoNode, '', {})),
      /required for Go to/,
      `${field} blank reds on goto`
    );
    assert.equal(defaults[field].validate.call(steerNode, '', {}), true, `${field} blank passes on steer`);
    // A saved config without `action` parses as steer (resolveMoveAction), so
    // the validator's blank-action fallback must be steer too.
    assert.equal(defaults[field].validate.call({}, '', {}), true, `${field} blank passes on a pre-action save`);
  }
  assert.equal(defaults.lat.validate.call(gotoNode, 47.5, {}), true);
  assert.equal(defaults.lon.validate.call(gotoNode, -122.3, {}), true);
  assert.equal(defaults.alt.validate.call(gotoNode, 30, {}), true);
  // The degE7 int32 ceiling makes range a guard, not pedantry — same rule as
  // §10 — the editor is the only place this is enforced.
  assert.match(String(defaults.lat.validate.call(gotoNode, 91, {})), /\[-90, 90\]/);
  assert.match(String(defaults.lon.validate.call(gotoNode, 181, {})), /\[-180, 180\]/);
  assert.match(String(defaults.alt.validate.call(gotoNode, 'abc', {})), /number of metres/);
});

test('mavlink-move Body on Build requires the Vehicle Profile dialect (Codex #277)', () => {
  // Build with a concrete dialect has no firmware source, so a Body node
  // would deploy clean and refuse every input — the editor must red it. The
  // Vehicle Profile dialect escape supplies the firmware and passes; every
  // wire tier gets firmware from the Connection and never reds.
  const defaults = loadNodeDefaults('mavlink-move');
  const validate = defaults.reference.validate;
  // Arity first: DESIGN §14 measured that Node-RED coerces a one-arg
  // validator's return with `!!`, so a reason string is truthy and the field
  // passes. This gate shipped that way — correct in isolation, dead in the
  // editor — and the assertions below cannot see it, because calling the
  // validator directly returns the string either way.
  assert.equal(validate.length, 2, 'a reason-returning validator must declare (v, opt) or it always passes');
  assert.match(
    String(validate.call({ action: 'steer', delivery: 'build', dialect: 'common' }, 'body', {})),
    /Body on Build needs a firmware/
  );
  assert.equal(validate.call({ action: 'steer', delivery: 'build', dialect: '__vehicle' }, 'body', {}), true);
  assert.equal(validate.call({ action: 'steer', delivery: 'send', dialect: '' }, 'body', {}), true);
  assert.equal(validate.call({ action: 'steer', delivery: 'stream', dialect: '' }, 'body', {}), true);
  assert.equal(validate.call({ action: 'steer', delivery: 'build', dialect: 'common' }, 'world', {}), true);
  assert.equal(validate.call({ action: 'goto', delivery: 'build', dialect: 'common' }, 'body', {}), true,
    'a hidden reference on a goto node never reds');
});

test('mavlink-move steer fields default blank and an all-blank steer stays clean', () => {
  // Filling fields IS the mode: a default of 0 would put every fresh steer
  // node in a position+velocity+accel mix the runtime refuses. Blank is the
  // only default that means "not commanded" — and a node with nothing filled
  // must not red, or every freshly dropped Move node arrives broken.
  //
  // Executed, not grepped: the position axes carry a different validator now,
  // and a regex over the source cannot tell whether blank still passes.
  const defaults = loadNodeDefaults('mavlink-move');
  const fields = ['north', 'east', 'up', 'vNorth', 'vEast', 'vUp', 'aNorth', 'aEast', 'aUp', 'yaw', 'yawRate'];
  const allBlank = { id: 'm1', action: 'steer' };
  for (const field of fields) {
    assert.equal(defaults[field].value, '', `${field} defaults blank`);
    assert.equal(
      defaults[field].validate.call(allBlank, '', {}),
      true,
      `${field} accepts blank when nothing else is filled`
    );
  }
});

test('mavlink-move: a Steer position triplet is all-or-nothing (the runtime no longer checks)', () => {
  // Filling any axis makes this a position setpoint and the blanks encode 0 —
  // the EKF origin on an absolute frame. The runtime coerces without looking
  // (AGENTS.md, input trust), so this validator is the only layer that sees a
  // half-typed triplet. Velocity and acceleration are exempt by design: a
  // blank rate is a zero rate, which is inert.
  const defaults = loadNodeDefaults('mavlink-move');
  const AXES = ['north', 'east', 'up'];
  const verdicts = (north, east, up, action = 'steer') => {
    const cfg = { id: 'm1', action, north, east, up };
    return AXES.map((axis, i) => defaults[axis].validate.call(cfg, [north, east, up][i], {}) === true);
  };

  assert.deepEqual(verdicts('', '', ''), [true, true, true], 'all blank is a steer with no position group');
  assert.deepEqual(verdicts('5', '2', '3'), [true, true, true], 'a full triplet passes');
  assert.deepEqual(verdicts('5', '', ''), [true, false, false], 'one axis filled reds the other two');
  assert.deepEqual(verdicts('5', '2', ''), [true, true, false], 'two filled reds the last');
  // An explicit 0 is a value, not a blank — it commits the triplet.
  assert.deepEqual(verdicts('0', '', ''), [true, false, false], 'explicit 0 counts as filled');
  // Whitespace is blank (#174), so it reds rather than passing as Number(' ') = 0.
  assert.deepEqual(verdicts('5', ' ', '3'), [true, false, true], 'a whitespace axis is blank');
  assert.match(String(defaults.east.validate.call({ id: 'm1', action: 'steer', north: '5' }, '', {})),
    /commands the origin/, 'the reason names the hazard');

  // Go to does not show the triplet, so a stale value there must never red a
  // node that will not read it — the same gating every Steer-only field uses.
  assert.deepEqual(verdicts('5', '', '', 'goto'), [true, true, true], 'goto ignores the triplet entirely');
});

test('mavlink-move: a saved position triplet can be cleared to switch steering modes (Codex, #284)', () => {
  // The bug this pins: reading siblings through liveOr made a full triplet
  // impossible to clear. liveOr answers "blank live value means no answer,
  // use the saved one" — correct where a field inherits, wrong here, where an
  // empty box IS the answer. Each cleared axis saw its siblings as still
  // filled, all three stayed red, and the operator could not move a Steer node
  // off position onto velocity. Sibling reads go through ownDialogField now.
  const AXES = ['north', 'east', 'up'];
  const dialog = (n, e, u) => ({
    '#node-input-action': { val: 'steer' },
    '#node-input-north': { val: n },
    '#node-input-east': { val: e },
    '#node-input-up': { val: u },
  });
  const open = (dom, saved) => {
    const defaults = loadNodeDefaults('mavlink-move', {}, { dom, editStack: [{ id: 'm1' }] });
    return AXES.map((axis) => defaults[axis].validate.call(saved, dom[`#node-input-${axis}`].val, {}) === true);
  };
  const savedFull = { id: 'm1', action: 'steer', north: '5', east: '2', up: '3' };

  assert.deepEqual(open(dialog('', '', ''), savedFull), [true, true, true],
    'clearing every axis of a saved triplet must validate — this is the regression');
  assert.deepEqual(open(dialog('5', '', ''), savedFull), [true, false, false],
    'clearing only some of them is still the half-typed form');
  assert.deepEqual(open(dialog('5', '2', '3'), savedFull), [true, true, true], 'untouched full triplet passes');

  // With no dialog of ours open — deploy, import, or somebody else's tray on
  // top (#217) — the saved config is the only truth, and Node-RED passes this
  // node's own saved value as `v`. A foreign dialog's empty boxes must not
  // red a node whose own triplet is complete.
  const foreign = loadNodeDefaults('mavlink-move', {}, { dom: dialog('', '', ''), editStack: [{ id: 'other' }] });
  assert.deepEqual(
    AXES.map((axis) => foreign[axis].validate.call(savedFull, savedFull[axis], {}) === true),
    [true, true, true],
    "a foreign dialog cannot red a closed node's complete triplet"
  );
  const savedHalf = { id: 'm1', action: 'steer', north: '5', east: '', up: '' };
  assert.deepEqual(
    AXES.map((axis) => foreign[axis].validate.call(savedHalf, savedHalf[axis], {}) === true),
    [true, false, false],
    'a genuinely half-saved triplet still reds on its own merits'
  );
});

test('mavlink-move targetSystem broadcast refusal keys on the confirm tier', () => {
  // Broadcast (0) is refused only where an ack is actually awaited (#260) —
  // and confirm is a goto-only tier now, so the delivery IS the gate; there
  // is no carrier field left to consult.
  const defaults = loadNodeDefaults('mavlink-move');
  const validate = defaults.targetSystem.validate;
  assert.match(
    String(validate.call({ delivery: 'confirm' }, 0, {})),
    /cannot be confirmed/,
    'an explicit 0 reds on confirm'
  );
  assert.match(String(validate.call({ delivery: 'confirm' }, '0', {})), /cannot be confirmed/);
  assert.equal(validate.call({ delivery: 'confirm' }, '', {}), true, 'blank inherits the profile target');
  assert.equal(validate.call({ delivery: 'confirm' }, 1, {}), true);
  assert.equal(validate.call({ delivery: 'send' }, 0, {}), true, 'Send stays broadcast-legal');
  assert.equal(validate.call({ delivery: 'stream' }, 0, {}), true, 'Stream stays broadcast-legal');
  assert.doesNotMatch(
    /targetSystem:\s*\{[\s\S]*?\n {6}\},/.exec(html)[0],
    /carrier/,
    'the retired carrier gate is gone from the validator'
  );
});

test('mavlink-move Advanced section: toggle link, hidden div, the right rows inside', () => {
  assert.match(html, /id="move-advanced-toggle"/, 'the Advanced toggle link exists');
  assert.match(html, /id="move-advanced" style="display:none"/, 'the Advanced div starts hidden');
  assert.match(html, /\$adv\.toggle\(\)/, 'plain jQuery show/hide, no widget');
  const advancedAt = html.indexOf('id="move-advanced"');
  const templateEnd = html.indexOf('</script>', advancedAt);
  for (const id of [
    'row-move-changeMode',
    'row-move-ackTimeout',
    'row-move-radius',
    'row-move-aNorth',
    'row-move-aEast',
    'row-move-aUp',
    'row-move-targetComponent',
  ]) {
    const at = html.indexOf(`id="${id}"`);
    assert.ok(
      at > advancedAt && at < templateEnd,
      `${id} must live inside the Advanced div`
    );
  }
});

test('mavlink-move Change mode tip states the measured §14 gate', () => {
  // The flag is the gate on both stacks (measured 2026-08-12): without it,
  // outside GUIDED (AP) / Hold (PX4), the answer is DENIED (2). The tip must
  // say so — an operator who unticks it needs to know what refuses.
  const tip = /id="node-input-changeMode"[\s\S]*?<\/span>/.exec(html);
  assert.ok(tip, 'changeMode row must carry a form-tips span');
  assert.match(tip[0], /must already be in GUIDED \(ArduPilot\) \/ Hold \(PX4\)/, 'off-state names the required modes');
  assert.match(tip[0], /answers DENIED/, 'off-state names the refusal');
  assert.match(tip[0], /flies itself into guided mode \(§14\)/, 'on-state names the mode change and the measurement');
  assert.match(html, /changeMode:\s*\{\s*value:\s*false\s*\}/, 'changeMode defaults off');
  assert.match(html, /type="checkbox" id="node-input-changeMode"/, 'changeMode is a checkbox');
});

test('mavlink-move goto params: blank-sentinel fields and the positive ACK timeout', () => {
  for (const field of ['speed', 'radius']) {
    assert.match(
      html,
      new RegExp(`${field}:\\s*\\{\\s*value:\\s*'',\\s*validate:\\s*RED\\.validators\\.number\\(true\\)`),
      `${field} defaults blank with the blank-allowed numeric validator`
    );
  }
  // ackTimeout is blank-allowed too, but 0 and negatives are not a shorter
  // wait — they fire the ack timer before the vehicle can answer — so its
  // validator requires a positive number rather than any number.
  const ackValidator = /ackTimeout:\s*\{[\s\S]*?\n {6}\},/.exec(html);
  assert.ok(ackValidator, 'ackTimeout validate function must be extractable');
  assert.match(ackValidator[0], /value:\s*''/, 'ackTimeout defaults blank (inherit the 10 s default)');
  assert.match(ackValidator[0], /isBlank\(v\)\)\s*return true/, 'blank stays valid');
  assert.match(ackValidator[0], /Number\(v\) > 0/, 'zero and negatives are rejected');
  assert.doesNotMatch(ackValidator[0], /RED\.validators\.number\(true\)/, 'the any-number validator is gone');
  // Blank speed/radius/yaw encode the spec sentinels at runtime; the
  // placeholders say so instead of implying zero.
  assert.match(html, /id="node-input-speed"[^>]*placeholder="\(vehicle default\)"/, 'speed placeholder names the sentinel');
  assert.match(html, /id="node-input-radius"[^>]*placeholder="\(ignored\)"/, 'radius placeholder names the sentinel');
});

test('mavlink-move speaks one canonical vocabulary and labels the body reference forward/right', () => {
  // Pre-1.0, no aliases (AGENTS.md "no migrations, no compatibility shims"):
  // neither the pre-frame mode names nor the retired carrier vocabulary may
  // appear anywhere in the editor.
  assert.doesNotMatch(html, /local-position|local-velocity|global-position/, 'no legacy mode names');
  assert.doesNotMatch(html, /setpoint \(stream|reposition \(guided/i, 'no carrier option labels');
  assert.match(html, /isBody \? 'Metres forward' : 'Metres north'/, 'body reference relabels north to forward');
  assert.match(html, /altRef === 'msl' \? 'Metres alt \(MSL\)' : 'Metres alt \(above home\)'/, 'alt label follows the altitude reference');
});

test('mavlink-move has one labeled row per parameter, not dual local/global rows', () => {
  assert.ok(
    !html.includes('North / Lat'),
    'dual North / Lat label must be gone'
  );
  assert.ok(
    !html.includes('East / Lon'),
    'dual East / Lon label must be gone'
  );
  assert.ok(
    !html.includes('Up / Alt'),
    'dual Up / Alt label must be gone'
  );
  assert.match(html, /Metres north/, 'north has its own label');
  assert.match(html, /Degrees lat/, 'lat has its own label');
  assert.match(html, /North m\/s/, 'vNorth has its own label');

  for (const id of ['node-input-north', 'node-input-lat', 'node-input-vNorth']) {
    const rowPattern = new RegExp(
      `<div class="form-row"[^>]*>[\\s\\S]*?id="${id}"`,
      'm'
    );
    const matches = html.match(new RegExp(rowPattern, 'g')) || [];
    assert.equal(matches.length, 1, `${id} must appear on exactly one form-row`);
  }
});

test('mavlink-move keeps target sysid/compid and reloadCompIdSelect catalog', () => {
  assert.match(html, /id="node-input-targetSystem"/, 'target sysid field remains');
  assert.match(html, /id="node-input-targetComponent"/, 'target compid select remains');
  assert.match(html, /RED\.mavlink\.reloadTargetCompId\(node\)/, 'compid enum catalog uses shared helper');
  assert.match(html, /ensureConfigNodePicker/, 'connection picker remains');
  assertChangeHandlerContains(
    html,
    "$('#node-input-connection')",
    'RED.mavlink.reloadTargetCompId(node)',
    'connection change reloads CompID'
  );
  assertChangeHandlerContains(
    html,
    "$('#node-input-vehicle')",
    'RED.mavlink.reloadTargetCompId(node)',
    'vehicle change reloads CompID'
  );
});

test('mavlink-move target sysid/compid default to empty (inherit profile) not 1', () => {
  assert.match(html, /targetSystem:\s*\{\s*value:\s*''/, 'sysid default is empty string');
  assert.match(html, /targetComponent:\s*\{\s*value:\s*''/, 'compid default is empty string');
  assert.match(html, /RED\.validators\.number\(true\)/, 'blank-allowed validator is used');
  assert.match(html, /placeholder="[^"]*profile default[^"]*"/, 'sysid has profile default placeholder');
  assert.match(html, /RED\.mavlink\.reloadTargetCompId\(node\)/, 'compid uses shared reloadTargetCompId');
});

test('mavlink-move has vehicle and identity defaults for role × tier matrix (§6)', () => {
  // The vehicle (mavlink-vehicle) descriptor is contributed by the shared
  // buildTierDialectDefaults(); the delegation is asserted below.
  assert.match(html, /identity:\s*\{\s*value:\s*''/, 'identity default is empty string');
  assert.match(html, /ensureConfigNodePicker[^)]*'vehicle'/, 'vehicle uses config node picker');
  assert.match(html, /id="node-input-identity"/, 'identity select exists in template');
  assert.match(html, /id="row-move-vehicle"/, 'vehicle row has ID for tier-driven toggling');
  assert.match(html, /id="row-move-identity"/, 'identity row has ID for tier-driven toggling');
  assert.match(html, /id="row-move-connection"/, 'connection row has ID for tier-driven toggling');
});

test('mavlink-move fills identity select and re-fills on connection change (§6)', () => {
  assert.match(html, /RED\.mavlink\.refreshIdentitySelect\(node\)/, 'shared refreshIdentitySelect fills the identity dropdown');
  assert.match(
    html,
    /\$\('#node-input-identity'\)\.on\('change', refreshVisibility\)/,
    'identity change triggers visibility refresh'
  );
  assert.match(
    html,
    /\$\('#node-input-connection'\)\.on\('change'/,
    'connection change handler exists'
  );
  assertChangeHandlerContains(
    html,
    "$('#node-input-connection')",
    'RED.mavlink.refreshIdentitySelect(node)',
    'identity refilled on connection change'
  );
});

test('mavlink-move companion hides both target sysid and compid rows (§6)', () => {
  assert.match(
    html,
    /RED\.mavlink\.applyCompanionTargetVisibility\(/,
    'shared companion target visibility helper is used'
  );
  assert.match(html, /id="row-move-targetSystem"/, 'targetSystem row has ID for toggling');
  assert.match(html, /id="row-move-targetComponent"/, 'targetComponent row has ID for toggling');
  assert.match(
    html,
    /targetSystemRow:\s*['"]#row-move-targetSystem['"]/,
    'sysid gated by companion for move'
  );
  assert.match(
    html,
    /targetComponentRow:\s*['"]#row-move-targetComponent['"]/,
    'compid also gated by companion for move (no spec exception here)'
  );
  assert.doesNotMatch(
    html,
    /hideCompidWhenCompanion:\s*false/,
    'move does not take the Payload compid exception'
  );
});

test('mavlink-move build tier shows vehicle, hides connection/identity (§6)', () => {
  assert.match(
    html,
    /RED\.mavlink\.applyBuildTierRowVisibility\(\{/,
    'Move must call the shared visibility helper'
  );
  assert.match(html, /dialectRow:\s*'#row-move-dialect'/, 'dialect row selector passed');
  assert.match(html, /vehicleRow:\s*'#row-move-vehicle'/, 'vehicle row selector passed');
  assert.match(html, /connectionRow:\s*'#row-move-connection'/, 'connection row selector passed');
  assert.match(html, /identity:\s*isWire/, 'identity row shown only for wire tiers (local)');
  assert.doesNotMatch(
    html,
    /\$\('#row-move-dialect'\)\.toggle/,
    'no hand-rolled dialect row toggle'
  );
});

test('mavlink-move dialect + vehicle defaults come from the shared Build-tier helper', () => {
  // dialect/vehicle descriptors + validators are the shared §6 rule, merged via
  // buildTierDialectDefaults (delivery mode, no firmware). Validator behaviour
  // is proven in mavlink-editor-resource.test.js.
  assert.match(
    html,
    /Object\.assign\([\s\S]*RED\.mavlink\.buildTierDialectDefaults\(\)\s*\)/,
    'Move defaults must merge buildTierDialectDefaults()'
  );
});

test('mavlink-move Build dialect select uses shared helper with Vehicle Profile escape', () => {
  // Option value/label are injected by populateDialectSelect; Move pins the call.
  assert.match(html, /id="row-move-dialect"/, 'template must have a dialect row');
  assert.match(html, /id="node-input-dialect"/, 'template must have a dialect select');
  assert.match(html, /RED\.mavlink\.populateDialectSelect\(/, 'dialect select must use shared helper');
});

test('mavlink-move has no Firmware row and no silent ardupilotmega default', () => {
  assert.doesNotMatch(html, /node-input-firmware|row-move-firmware|Firmware/, 'Move must not add a Firmware row');
  assert.doesNotMatch(html, /ardupilotmega/, 'Move editor must not invent a default dialect');
});

// ── Help text: the load-bearing statements, in the new vocabulary ────────────

test('mavlink-move help documents the goto command path and the mode-change gate', () => {
  assert.match(html, /DO_REPOSITION/, 'help names the command');
  assert.match(html, /COMMAND_INT/, 'help names the wire message');
  assert.match(html, /MAV_DO_REPOSITION_FLAGS_CHANGE_MODE/, 'help names the flag');
  assert.match(html, /mode change/, 'the flag is documented as a mode change');
  // The measured §14 gate, in one sentence flows can act on.
  assert.match(
    html,
    /accepted iff the flag is set or the vehicle is already in GUIDED \(ArduPilot\) \/ Hold \(PX4\)/,
    'help states the CHANGE_MODE gate as measured'
  );
  assert.match(html, /denied \(2\)/, 'help names the refusal code');
  // The failure words are documented as flows will see them: the MAV_RESULT
  // name lowercased IS the record's result field, verbatim from the ack path.
  assert.match(html, /command_int_only/, 'help names the failure surfacing as the result word');
  assert.match(html, /<code>unconfirmed<\/code>/, 'a missing ack reports unconfirmed, not failure');
});

test('mavlink-move help keeps the result vocabulary and the expired discriminator', () => {
  for (const word of ['sent', 'streaming', 'stopped', 'accepted', 'denied']) {
    assert.match(html, new RegExp(`<code>${word}</code>`), `result word ${word} documented`);
  }
  assert.match(html, /result === "expired"/, 'expiry is branched on result — result IS the discriminator');
  assert.match(html, /result: "stopped"/, 'stop completes with result stopped');
  assert.match(html, /brakeError/, 'a failed expiry brake rides its own field');
  assert.match(html, /setpoint watchdog is the failsafe on a dead link/, 'the TTL/deadman paragraph survives');
});

test('mavlink-move help keeps the sentinel, unit, and body-frame statements', () => {
  assert.match(html, /−1 \(vehicle default\)/, 'blank speed sentinel −1');
  assert.match(html, /0 \(ignored/, 'blank radius sentinel 0');
  assert.match(html, /NaN \(keep the current heading mode/, 'blank yaw sentinel NaN');
  assert.match(html, /up-positive/, 'verticals are entered up-positive');
  assert.match(html, /degrees[\s\S]{0,80}radians/, 'yaw converts degrees to radians once');
  assert.match(html, /BODY_OFFSET_NED \(9\)/, 'ArduPilot body frame named');
  assert.match(html, /BODY_NED \(8\)/, 'PX4 body frame named');
  assert.match(html, /velocity only/, 'PX4 body frames carry velocity only');
});

test('mavlink-move help documents the action-shaped overrides and refuses the retired set', () => {
  for (const key of ['altRef', 'reference', 'position', 'velocity', 'accel', 'yawRate', 'rateHz', 'ttlMs', 'timeBootMs', 'changeMode']) {
    assert.match(
      html,
      new RegExp(`<code>${key}`),
      `payload override ${key} documented`
    );
  }
  assert.match(html, /action: "stop"/, 'the stop action is documented');
  assert.match(html, /msg\.payload === false<\/code> suppresses/, 'the suppress sentinel is documented');
});
