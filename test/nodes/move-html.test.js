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
  assert.match(html, /altRef:\s*state\.isGoto/, 'altitude reference shown on goto only');
  assert.match(html, /lat:\s*state\.isGoto/, 'global position gated on goto');
  // isSteer, not !isGoto: the roster added the command actions (Turn, Speed),
  // which own none of the position surface. Gating on "not goto" would have
  // shown Steer's reference and field groups on both of them.
  assert.match(html, /reference:\s*state\.isSteer/, 'reference shown on steer only');
  assert.match(html, /heading:\s*state\.isTurn/, 'heading shown on turn only');
  assert.match(html, /throttle:\s*state\.isSpeed/, 'throttle shown on speed only');
  // Steer's field groups moved behind the disclosure checkboxes (#304 §4), so
  // the gate is the group rather than `isSteer` — `groups` is computed from
  // isSteer AND the box AND the plane collapse, and the executable test below
  // proves each of those arms rather than trusting this shape.
  assert.match(html, /north:\s*state\.groups\.position && !state\.planeSteer/, 'north is disclosed, and off on a plane');
  assert.match(html, /up:\s*state\.groups\.position/, 'the vertical axis survives the plane collapse');
  assert.match(html, /vNorth:\s*state\.groups\.velocity/, 'velocity fields gated on the velocity group');
  assert.match(html, /aNorth:\s*state\.groups\.accel/, 'accel fields gated on the acceleration group');
  assert.match(html, /yawRate:\s*state\.groups\.yaw \|\| state\.isAttitude/, 'yaw rate rides the yaw group or Attitude');
  assert.match(html, /const isCommandPath = isGoto && !isStream/, 'the command path is goto off Stream');
  // Ground speed is shared by Go to's DO_REPOSITION param and the Speed
  // action's own — one spelling for one operator concept (§14).
  assert.match(html, /speed:\s*state\.isCommandPath \|\| state\.isSpeed/, 'ground speed on goto command path and on Speed');
  assert.match(html, /radius:\s*state\.isCommandPath/, 'loiter radius hides on Stream');
  assert.match(html, /changeMode:\s*state\.isCommandPath/, 'change mode hides on Stream');
  // Every acked action can wait for its ack, not just goto.
  assert.match(
    html,
    /ackTimeout:\s*\(state\.isGoto \|\| state\.isTurn \|\| state\.isSpeed\) && state\.delivery === 'confirm'/,
    'ACK timeout on the confirm tier of every acked action'
  );
  assert.match(html, /delivery === 'stream'/, 'stream rate and TTL gated on delivery');
});

test('mavlink-move Action surface: goto default, both actions offered, retired fields gone', () => {
  // A wrong or missing default changes the wire message for every Move node
  // that never touched the field; goto is the acked direction the redesign
  // leads with.
  // Defaults-based, not a source regex: action grew a validator (the Steer
  // "something to command" rule), so its literal is no longer one line.
  assert.equal(loadNodeDefaults('mavlink-move').action.value, 'goto', 'action defaults to goto');
  assert.match(html, /option value="goto"/, 'goto action offered');
  assert.match(html, /option value="steer"/, 'steer action offered');
  // Defaults-based, not a source regex: altRef grew its membership ring.
  assert.equal(loadNodeDefaults('mavlink-move').altRef.value, 'home', 'altRef defaults to home (the GCS default)');
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
  const map = /const DELIVERY_OPTIONS = \{[\s\S]*?\n {6}\};/.exec(html);
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
  // The keep-live-then-saved rule and the Send fallback moved into the shared
  // `refreshOptionSelect` (#304 §4), which is proven executably in
  // mavlink-editor-resource.test.js. What this file still owns is that Move
  // hands it the right inputs.
  assert.match(html, /select: '#node-input-delivery'/, 'the delivery select is rebuilt through the shared helper');
  assert.match(html, /saved: node\.delivery/, 'the saved delivery is what survives a withholding');
  assert.match(html, /fallback: 'send'/, 'an illegal saved delivery falls back to Send — still a wire tier');
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
    // A saved config without `action` parses as steer, so
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

test('mavlink-move: a Steer group is all-or-nothing, in the dialog and on the wire', () => {
  // Filling any axis names the group, and under the derived type_mask the
  // blanks are commanded zeros — the EKF origin for a position on an absolute
  // frame, a commanded zero rate for a velocity. The runtime refuses these too
  // now (owner ruling, 2026-08-14), so the dialog is where an operator finds
  // out rather than the only layer that looks.
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
    /commanded 0 under the type_mask/, 'the reason names the hazard');

  // Velocity and acceleration are held to the same rule now. They used to be
  // exempt on the reasoning that a blank rate is a zero rate and so inert —
  // but under the mask a zero rate is *commanded* zero, which is how a
  // velocity north with the other two left empty became "and hold 0 sideways".
  const groupVerdicts = (cfg, axes) => axes.map((a) => defaults[a].validate.call(cfg, cfg[a], {}) === true);
  assert.deepEqual(
    groupVerdicts({ id: 'm1', action: 'steer', vNorth: '1', vEast: '', vUp: '' }, ['vNorth', 'vEast', 'vUp']),
    [true, false, false],
    'one velocity axis reds the other two'
  );
  assert.deepEqual(
    groupVerdicts({ id: 'm1', action: 'steer', aNorth: '1', aEast: '0', aUp: '0' }, ['aNorth', 'aEast', 'aUp']),
    [true, true, true],
    'a full acceleration triplet passes'
  );

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
    'row-move-targetComponent',
  ]) {
    const at = html.indexOf(`id="${id}"`);
    assert.ok(
      at > advancedAt && at < templateEnd,
      `${id} must live inside the Advanced div`
    );
  }
});

test('mavlink-move Change mode is an opt-in checkbox, defaulting off', () => {
  // Flying the vehicle into guided mode is a mode change, so it is never the
  // saved default. What the flag gates is stated once, in the help pane —
  // pinned by 'help documents the goto command path and the mode-change gate'.
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
  assert.match(html, /altRef === 'msl' \? 'Metres alt \(MSL\)'[\s\S]{0,20}: altRef === 'terrain' \? 'Metres alt \(above terrain\)' : 'Metres alt \(above home\)'/, 'alt label follows the altitude reference');
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
  // Wire tier alone does not show it: a Connection binding one identity offers
  // no choice, so the row goes rather than showing a one-option select.
  assert.match(
    html,
    /identity:\s*state\.isWire && state\.identityIsChoice/,
    'identity row also needs the Connection to offer a choice'
  );
  assert.match(
    html,
    /identityIsChoice:\s*RED\.mavlink\.hasIdentityChoice\(/,
    'the choice test is the shared predicate'
  );
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
  assert.match(html, /identity:\s*state\.isWire/, 'identity row shown only for wire tiers (local)');
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

test('mavlink-move: Steer must command something — any combination of groups counts', () => {
  // Both rules moved out of the runtime (AGENTS.md, input trust): the configured
  // path is the editor's, and a msg that blanks or mixes the groups is trusted.
  //
  // No *individual* Steer field can be required — filling fields IS the mode —
  // but "at least one of them" can be, which is what makes an all-blank Steer
  // catchable at all. It reds on Action because Action is what gives the
  // fields meaning.
  const defaults = loadNodeDefaults('mavlink-move');
  const verdict = (over) =>
    defaults.action.validate.call(Object.assign({ id: 'm1', action: 'steer' }, over), 'steer', {});

  assert.equal(defaults.action.validate.length, 2, 'a reason-returning validator declares (v, opt) — §14');
  assert.equal(defaults.action.validate.call({ id: 'm1', action: 'goto' }, 'goto', {}), true,
    'Go to reads none of these fields, so it never fires');

  assert.match(String(verdict({})), /needs at least one field filled/, 'an all-blank Steer reds');
  for (const filled of [{ north: '5' }, { vNorth: '1' }, { aUp: '0.5' }, { yaw: '90' }, { yawRate: '10' }]) {
    assert.equal(verdict(filled), true, `${Object.keys(filled)[0]} alone is something to command`);
  }
  // An explicit 0 is a value; whitespace is not (#174).
  assert.equal(verdict({ vNorth: '0' }), true, 'a zero velocity is a commanded zero');
  assert.match(String(verdict({ vNorth: ' ' })), /needs at least one field filled/, 'whitespace is blank');

  // The measured combinations are modes: one ignore bit each on the wire, and
  // ArduPilot names them as guided submodes (§14). Nothing here may red a
  // filled form. position+acceleration-without-velocity is the exception and
  // has its own test — it is the one combination with no submode and no
  // measurement.
  assert.equal(verdict({ aUp: '0.5', vNorth: '1' }), true, 'acceleration + velocity');
  assert.equal(verdict({ north: '5', vNorth: '1', aUp: '0.5' }), true, 'all three together');
  assert.equal(verdict({ north: '5', vNorth: '1' }), true, 'position + velocity');
});

test('mavlink-move: clearing the last live Steer field reds while the dialog is open', () => {
  // The saved-property path above is deploy-time. This is the other one: the
  // dialog is open, the operator empties the box that was carrying the config,
  // and the verdict has to follow the box, not the property behind it.
  //
  // That is why `fieldValue` reads through `ownDialogField` rather than
  // `liveOr`. `liveOr` treats a blank live value as "no answer" and falls back
  // to the saved one — right for a field that inherits, wrong here, where an
  // empty box is the operator's answer. With `liveOr` a saved `north` would
  // keep vouching for a form the operator has just emptied, and the node would
  // deploy an all-ignore Steer that reported clean.
  const open = (dom) => loadNodeDefaults('mavlink-move', {}, {
    dom, editStack: [{ id: 'm1' }],
  }).action;
  const node = { id: 'm1', action: 'steer', north: '5', east: '0', up: '0' };

  assert.match(
    String(open({
      '#node-input-north': { val: '' },
      '#node-input-east': { val: '' },
      '#node-input-up': { val: '' },
    }).validate.call(node, 'steer', {})),
    /needs at least one field filled/,
    'cleared live boxes beat the saved triplet'
  );
  assert.equal(
    open({
      '#node-input-north': { val: '' },
      '#node-input-east': { val: '' },
      '#node-input-up': { val: '' },
      '#node-input-vNorth': { val: '2' },
    }).validate.call(node, 'steer', {}),
    true,
    'clearing position and typing a velocity is a legal switch of mode'
  );
  // Same DOM, no edit-stack entry: some *other* node's dialog is on top, so
  // the live boxes are not this node's and the saved triplet stands (#217).
  assert.equal(
    loadNodeDefaults('mavlink-move', {}, {
      dom: { '#node-input-north': { val: '' }, '#node-input-east': { val: '' }, '#node-input-up': { val: '' } },
      editStack: [{ id: 'someone-else' }],
    }).action.validate.call(node, 'steer', {}),
    true,
    'another dialog\'s fields are not this node\'s answer'
  );
});

test('mavlink-move: position + acceleration without velocity reds', () => {
  // The one steer combination lib/move/frames.js MODES does not carry: no
  // named ArduPilot guided submode on the Copter-4.7.0 read, and no §14
  // measurement either way. A setpoint gets no COMMAND_ACK, so the operator
  // would see "sent" while the vehicle held position.
  const { action } = loadNodeDefaults('mavlink-move');
  const verdict = (over) =>
    action.validate.call(Object.assign({ id: 'm1', action: 'steer' }, over), 'steer', {});

  assert.match(String(verdict({ north: '5', aUp: '0.5' })), /has no guided submode/);
  assert.match(String(verdict({ up: '5', aNorth: '0.5' })), /has no guided submode/,
    'any axis of either group is the group');
  // Both escapes named in the message actually work.
  assert.equal(verdict({ north: '5', aUp: '0.5', vNorth: '1' }), true, 'adding a velocity');
  assert.equal(verdict({ north: '5' }), true, 'clearing the acceleration');
  // And the measured combinations are untouched.
  assert.equal(verdict({ vNorth: '1', aUp: '0.5' }), true, 'velocity + acceleration');
  assert.equal(verdict({ aUp: '0.5' }), true, 'acceleration alone');
});

test('mavlink-move: Steer cannot be set to the confirm tier', () => {
  // The dialog never offers it — DELIVERY_OPTIONS.steer is build/send/stream —
  // but a hand-edited flow can hold it, and the runtime falls through to the
  // Send branch and reports `sent`. True of the wire, misleading about the
  // tier. Both fields are known at deploy, so the editor says so.
  const { delivery } = loadNodeDefaults('mavlink-move');
  const verdict = (over) => delivery.validate.call(
    Object.assign({ id: 'm1' }, over), over.delivery, {}
  );

  assert.equal(delivery.validate.length, 2, 'a reason-returning validator declares (v, opt) — §14');
  assert.match(String(verdict({ action: 'steer', delivery: 'confirm' })), /cannot confirm/);
  assert.equal(verdict({ action: 'goto', delivery: 'confirm' }), true, 'Go to has an ack to wait for');
  for (const tier of ['build', 'send', 'stream']) {
    assert.equal(verdict({ action: 'steer', delivery: tier }), true, `steer + ${tier} is offered`);
  }
  // A config with no action parses as steer, so it reds too.
  assert.match(String(verdict({ delivery: 'confirm' })), /cannot confirm/);
});

// ── Offset from here: LOCAL_OFFSET_NED as Steer's third reference ────────────

test('mavlink-move: Offset is offered as a Steer reference and the markup carries it', () => {
  assert.match(
    html,
    /<option value="offset">Offset from here \(relative\)<\/option>/,
    'the static template offers Offset'
  );
  assert.match(html, /const REFERENCE_OPTIONS = \[/, 'the reference list is rebuildable, like delivery');
  assert.match(html, /function refreshReferenceOptions/, 'the list is rebuilt per firmware');
  // The rebuild has to run before anything reads the reference back, because
  // the delivery list depends on it.
  // The rebuild returns the value now selected rather than being read back
  // out of the DOM, so "rebuilt before it is read" is structural instead of
  // ordering-by-convention: there is no second read to get wrong.
  assert.match(
    html,
    /const reference = refreshReferenceOptions\(gate\) \|\| 'world'/,
    'the reference in force is the rebuild\'s own answer'
  );
  const rebuilt = html.indexOf('const reference = refreshReferenceOptions(gate)');
  // The trailing `;` picks the call site — the declaration a few lines above
  // carries the same argument list and would otherwise match first.
  const used = html.indexOf('refreshDeliveryOptions(action, reference, gate);');
  assert.ok(rebuilt > 0 && used > rebuilt, 'delivery is rebuilt from the settled reference');
});

test('mavlink-move: Stream is withdrawn for Offset — a repeating offset walks the vehicle', () => {
  // Every tick is resolved against the vehicle's position at that moment, so
  // the tier has no meaning here (source-read 2026-08-13).
  assert.match(
    html,
    /if \(action === 'steer' && reference === 'offset'\) return true;/,
    'refreshDeliveryOptions withholds the stream tier for offset'
  );
  assert.match(
    html,
    /function refreshDeliveryOptions\(action, reference, gate\)/,
    'the delivery list keys on the reference and the vehicle, not the action alone'
  );
});

test('mavlink-move: a blank position axis is legal on Offset — a zero offset is not a place', () => {
  // The all-or-nothing triplet exists because a blank encodes 0, and 0 on an
  // absolute local frame is the EKF origin. On frame 7 it is a zero *offset*
  // — no movement — so filling one axis is the normal use, not a half-typed
  // form. QGC fills only the vertical; ArduPlane reads only the vertical.
  const defaults = loadNodeDefaults('mavlink-move');
  const AXES = ['north', 'east', 'up'];
  const verdict = (cfg) => AXES.map((axis) => defaults[axis].validate.call(cfg, cfg[axis], {}));

  const offsetUpOnly = { id: 'm1', action: 'steer', reference: 'offset', north: '', east: '', up: '10' };
  assert.deepEqual(verdict(offsetUpOnly), [true, true, true], 'up alone is legal on offset');

  // World is unchanged: the same half-filled triplet still reds its blanks.
  const worldUpOnly = { id: 'm1', action: 'steer', reference: 'world', north: '', east: '', up: '10' };
  const worldVerdict = verdict(worldUpOnly);
  assert.equal(worldVerdict[2], true, 'the filled axis passes');
  assert.match(String(worldVerdict[0]), /commanded 0 under the type_mask/, 'world still reds a blank north');
  assert.match(String(worldVerdict[1]), /commanded 0 under the type_mask/, 'world still reds a blank east');

  // There was an assertion here that offset "does not disable the numeric
  // check". It could not fail: steerAxisValidator never returns undefined,
  // and html-assert stubs RED.validators.number as `() => () => true`, so the
  // numeric arm answers true in this harness whether or not it runs. Removed
  // rather than reworded — the offset exemption is what this test owns, and the
  // blank-axis cases above prove it (CodeRabbit).
});

test('mavlink-move: Offset reds on a PX4 profile rather than being silently rewritten', () => {
  // PX4 accepts frame 7 and never acts on it (§14 2026-08-05). The dropdown
  // stops offering it, but a node that already had it saved must not be
  // quietly downgraded to World — that would change what the operator
  // configured without telling them. So it stays selectable and reds here.
  const lookup = {
    connPx4: { vehicle: 'vehPx4' },
    vehPx4: { firmware: 'px4', dialect: 'common' },
    connAp: { vehicle: 'vehAp' },
    vehAp: { firmware: 'ardupilot', dialect: 'ardupilotmega' },
  };
  const { reference } = loadNodeDefaults('mavlink-move', lookup);
  const verdict = (over) => reference.validate.call(
    Object.assign({ id: 'm1', action: 'steer' }, over), over.reference, {}
  );

  assert.equal(reference.validate.length, 2, 'a reason-returning validator declares (v, opt) — §14');
  assert.match(
    String(verdict({ reference: 'offset', delivery: 'send', connection: 'connPx4' })),
    /does nothing on PX4/,
    'offset on a PX4 profile reds with the reason'
  );
  assert.equal(
    verdict({ reference: 'offset', delivery: 'send', connection: 'connAp' }),
    true,
    'offset on ArduPilot is the whole point'
  );
  // No profile to consult is not a refusal: frame 7 is one number everywhere,
  // and the driver has an answer to give (unlike body, which does not).
  assert.equal(
    verdict({ reference: 'offset', delivery: 'build', dialect: 'common' }),
    true,
    'offset on Build with a concrete dialect is offered'
  );
  // Go to never reads the reference, so it cannot red on it.
  assert.equal(
    verdict({ action: 'goto', reference: 'offset', delivery: 'send', connection: 'connPx4' }),
    true,
    'the reference is a Steer field'
  );
  // The body rules are untouched by the new arm.
  assert.match(
    String(verdict({ reference: 'body', delivery: 'build', dialect: 'common' })),
    /Body on Build needs a firmware/,
    'body on Build with a concrete dialect still reds'
  );
});

test('mavlink-move: terrain altRef reds on a PX4 profile rather than being silently rewritten', () => {
  // Terrain frames are ArduPilot's in practice — PX4's support is patchy. The
  // dropdown withholds the option on a named non-ArduPilot firmware
  // (refreshAltRefOptions), and a node that already holds it keeps it and
  // reds here with the reason (§9 ruling 6 — withhold, never rewrite).
  const lookup = {
    connPx4: { vehicle: 'vehPx4' },
    vehPx4: { firmware: 'px4', dialect: 'common' },
    connAp: { vehicle: 'vehAp' },
    vehAp: { firmware: 'ardupilot', dialect: 'ardupilotmega' },
  };
  const { altRef } = loadNodeDefaults('mavlink-move', lookup);
  const verdict = (over) => altRef.validate.call(
    Object.assign({ id: 'm1', action: 'goto' }, over), over.altRef, {}
  );

  assert.match(
    String(verdict({ altRef: 'terrain', delivery: 'send', connection: 'connPx4' })),
    /ArduPilot frame/,
    'terrain on a PX4 profile reds with the reason'
  );
  assert.equal(
    verdict({ altRef: 'terrain', delivery: 'send', connection: 'connAp' }),
    true,
    'terrain on ArduPilot is the whole point'
  );
  // No profile gates nothing: hiding requires knowledge.
  assert.equal(
    verdict({ altRef: 'terrain', delivery: 'build', dialect: 'common' }),
    true,
    'terrain with no firmware knowledge is offered'
  );
  // The saved altRef is a Go to field; other actions never read it.
  assert.equal(
    verdict({ action: 'steer', altRef: 'terrain', delivery: 'send', connection: 'connPx4' }),
    true,
    'the altitude reference is a Go to field'
  );
  // The dropdown half: the rebuilt list withholds terrain per firmware, and
  // the static markup offers it so the two copies cannot drift.
  assert.match(html, /const ALTREF_OPTIONS = \[/, 'the altRef list is rebuilt per firmware');
  assert.match(html, /<option value="terrain">/, 'terrain is offered in the static markup');
  assert.match(
    html,
    /return value === 'terrain' && Boolean\(firmware\) && firmware !== 'ardupilot';/,
    'terrain alone is withheld, and only on a named non-ArduPilot firmware'
  );
});

test('mavlink-move: Offset cannot be set to the stream tier', () => {
  // The dialog never offers it — refreshDeliveryOptions withdraws Stream for
  // Offset — but a hand-edited flow can hold it, and the runtime streams it
  // happily, re-resolving against the vehicle's position every tick until the
  // TTL. Same shape as the steer × confirm verdict, and known at deploy.
  const { delivery } = loadNodeDefaults('mavlink-move');
  const verdict = (over) => delivery.validate.call(
    Object.assign({ id: 'm1' }, over), over.delivery, {}
  );

  assert.match(
    String(verdict({ action: 'steer', reference: 'offset', delivery: 'stream' })),
    /Offset cannot stream/
  );
  // Both escapes named in the message actually work.
  assert.equal(verdict({ action: 'steer', reference: 'offset', delivery: 'send' }), true, 'Send');
  assert.equal(verdict({ action: 'steer', reference: 'world', delivery: 'stream' }), true, 'World');
  assert.equal(verdict({ action: 'steer', reference: 'offset', delivery: 'build' }), true, 'Build');
  // Go to never reads the reference, so a stale saved 'offset' cannot red it.
  assert.equal(
    verdict({ action: 'goto', reference: 'offset', delivery: 'stream' }),
    true,
    'Go to streams global setpoints and does not read the reference'
  );
  // The pre-existing confirm verdict is untouched by the new arm.
  assert.match(String(verdict({ action: 'steer', delivery: 'confirm' })), /cannot confirm/);
  assert.equal(verdict({ action: 'goto', delivery: 'confirm' }), true);
});

// ── Turn and Speed: the acked motion commands ───────────────────────────────

test('mavlink-move: Turn and Speed are offered, with the command tiers only', () => {
  assert.match(html, /option value="turn"/, 'turn action offered');
  assert.match(html, /option value="speed"/, 'speed action offered');
  const map = /const DELIVERY_OPTIONS = \{[\s\S]*?\n {6}\};/.exec(html);
  assert.ok(map, 'DELIVERY_OPTIONS map must be extractable');
  for (const action of ['turn', 'speed']) {
    const list = new RegExp(`${action}:\\s*\\[[\\s\\S]*?\\n {8}\\]`).exec(map[0]);
    assert.ok(list, `${action} option list must be extractable`);
    // A MAV_CMD has no streaming semantics; it does have an ack.
    assert.doesNotMatch(list[0], /stream/, `${action} never offers Stream`);
    for (const tier of ['build', 'send', 'confirm']) {
      assert.match(list[0], new RegExp(`'${tier}'`), `${action} offers ${tier}`);
    }
  }
  for (const id of ['row-move-heading', 'row-move-turnRate', 'row-move-direction',
    'row-move-relative', 'row-move-throttle', 'row-move-speedType']) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} row must exist`);
  }
});

test('mavlink-move: Turn heading is required and bounded 0-360, because the vehicle FAILS outside it', () => {
  // ArduCopter answers MAV_RESULT_FAILED for a heading outside 0-360
  // (source-read 2026-08-13). The runtime sends it anyway — it is a legal
  // message and the ack is the feedback — so the editor is the only place an
  // operator learns before flying.
  const defaults = loadNodeDefaults('mavlink-move');
  const verdict = (over) => defaults.heading.validate.call(
    Object.assign({ id: 'm1', action: 'turn' }, over), over.heading, {}
  );

  assert.equal(defaults.heading.validate.length, 2, 'a reason-returning validator declares (v, opt) — §14');
  assert.match(String(verdict({ heading: '' })), /required for Turn/);
  assert.match(String(verdict({ heading: 400 })), /\[0, 360\]/);
  assert.match(String(verdict({ heading: -1 })), /\[0, 360\]/);
  assert.match(String(verdict({ heading: 'north' })), /\[0, 360\]/);
  assert.equal(verdict({ heading: 0 }), true, '0 is north, a real heading');
  assert.equal(verdict({ heading: 360 }), true, 'the upper bound is inclusive');
  assert.equal(verdict({ heading: 90 }), true);
  // Every other action ignores the field, so a stale blank cannot red them.
  for (const action of ['goto', 'steer', 'speed']) {
    assert.equal(
      defaults.heading.validate.call({ id: 'm1', action }, '', {}),
      true,
      `${action} does not read the heading`
    );
  }
});

test('mavlink-move: Turn reds on a non-ArduPilot profile and names the escape', () => {
  // CONDITION_YAW is an ArduPilot command; PX4 has no handler (§14). The
  // editor knows the profile at deploy, so it says so rather than letting the
  // node deploy clean and refuse every input.
  const lookup = {
    connPx4: { vehicle: 'vehPx4' },
    vehPx4: { firmware: 'px4', dialect: 'common' },
    connAp: { vehicle: 'vehAp' },
    vehAp: { firmware: 'ardupilot', dialect: 'ardupilotmega' },
  };
  const { action } = loadNodeDefaults('mavlink-move', lookup);
  const verdict = (over) => action.validate.call(
    Object.assign({ id: 'm1' }, over), over.action, {}
  );

  const denied = String(verdict({ action: 'turn', delivery: 'send', connection: 'connPx4' }));
  assert.match(denied, /ArduPilot command/);
  assert.match(denied, /Steer setpoint/, 'the reason names the path that works on PX4');
  assert.equal(
    verdict({ action: 'turn', delivery: 'send', connection: 'connAp' }),
    true,
    'ArduPilot is what the command is for'
  );
  // No profile to consult is not a refusal in the editor: Build with a
  // concrete dialect has no firmware source, and the runtime fails closed on
  // it with the same reason.
  assert.equal(verdict({ action: 'turn', delivery: 'build', dialect: 'common' }), true);
  // Speed asks no firmware question at all.
  assert.equal(verdict({ action: 'speed', delivery: 'send', connection: 'connPx4' }), true);
});

test('mavlink-move: a command action cannot be set to the stream tier', () => {
  // Third instance of the same finding (steer × confirm, offset × stream, and
  // now command × stream): the dialog cannot produce it, a text editor can, and
  // the runtime would report `sent` — true of the wire, a lie about the tier.
  const { delivery } = loadNodeDefaults('mavlink-move');
  const verdict = (over) => delivery.validate.call(
    Object.assign({ id: 'm1' }, over), over.delivery, {}
  );

  for (const action of ['turn', 'speed']) {
    assert.match(String(verdict({ action, delivery: 'stream' })), /a command cannot stream/);
    // The escapes named in the message work.
    assert.equal(verdict({ action, delivery: 'send' }), true, `${action} + send`);
    assert.equal(verdict({ action, delivery: 'confirm' }), true, `${action} + confirm`);
    assert.equal(verdict({ action, delivery: 'build' }), true, `${action} + build`);
  }
  // The setpoint actions still stream.
  assert.equal(verdict({ action: 'steer', reference: 'world', delivery: 'stream' }), true);
  assert.equal(verdict({ action: 'goto', delivery: 'stream' }), true);
});

// ── Attitude and Manual: the setpoint-shaped roster rows ────────────────────

test('mavlink-move: Attitude and Manual are offered with the setpoint tiers', () => {
  assert.match(html, /option value="attitude"/, 'attitude offered');
  assert.match(html, /option value="manual"/, 'manual offered');
  const map = /const DELIVERY_OPTIONS = \{[\s\S]*?\n {6}\};/.exec(html);
  for (const action of ['attitude', 'manual']) {
    const list = new RegExp(`${action}:\\s*\\[[\\s\\S]*?\\n {8}\\]`).exec(map[0]);
    assert.ok(list, `${action} option list must be extractable`);
    assert.doesNotMatch(list[0], /confirm/, `${action} carries no ack, so never offers confirm`);
    for (const tier of ['build', 'send', 'stream']) {
      assert.match(list[0], new RegExp(`'${tier}'`), `${action} offers ${tier}`);
    }
  }
});

test('mavlink-move: only the acked actions can confirm — stated once, not per action', () => {
  // Fourth instance of the same hand-edit family (steer × confirm, offset ×
  // stream, command × stream). Generalised rather than special-cased again.
  const { delivery } = loadNodeDefaults('mavlink-move');
  const verdict = (over) => delivery.validate.call(
    Object.assign({ id: 'm1' }, over), over.delivery, {}
  );

  for (const action of ['steer', 'attitude', 'manual']) {
    assert.match(
      String(verdict({ action, reference: 'world', delivery: 'confirm' })),
      /cannot confirm/,
      `${action} has no ack to wait for`
    );
  }
  for (const action of ['goto', 'turn', 'speed']) {
    assert.equal(verdict({ action, delivery: 'confirm' }), true, `${action} answers a COMMAND_ACK`);
  }
});

test('mavlink-move: Manual hides the target compid — the message has no such field', () => {
  // MANUAL_CONTROL's addressing field is `target`, a system id. Showing a
  // compid row would offer a control the wire has no room for.
  assert.match(html, /if \(isManual\) \$\('#row-move-targetComponent'\)\.hide\(\);/,
    'the compid row is hidden directly — applyCompanionTargetVisibility owns it, so a '
    + '`show` assignment would be a no-op (Gitar, #303)');
  for (const id of ['row-move-stickX', 'row-move-stickY', 'row-move-stickZ',
    'row-move-stickR', 'row-move-buttons', 'row-move-roll', 'row-move-pitch',
    'row-move-thrust', 'row-move-rollRate', 'row-move-pitchRate']) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} row must exist`);
  }
});

test('mavlink-move: sticks are required and bounded -1..1, thrust 0..1, in the editor', () => {
  // The wire is ±1000 and the surface is ±1, so a wire-unit value typed into a
  // stick is the mistake worth catching — the runtime scales whatever it gets.
  // Blank is a mistake too now: the runtime refuses an unfilled axis since the
  // INT16_MAX sentinel was dropped, so a blank box here would deploy a node
  // that fails every input.
  const defaults = loadNodeDefaults('mavlink-move');
  const manual = { id: 'm1', action: 'manual' };
  for (const stick of ['stickX', 'stickY', 'stickZ', 'stickR']) {
    assert.match(String(defaults[stick].validate.call(manual, '', {})), /is required for Manual/);
    assert.equal(defaults[stick].validate.call(manual, 0.5, {}), true);
    assert.equal(defaults[stick].validate.call(manual, -1, {}), true);
    assert.match(String(defaults[stick].validate.call(manual, 500, {})), /not wire units/);
    assert.match(String(defaults[stick].validate.call(manual, -1.5, {})), /-1\.\.1/);
    // Another action does not show the sticks, so a stale blank must not red a
    // node that will never read it — the gate every action-scoped field uses.
    assert.equal(defaults[stick].validate.call({ id: 'm1', action: 'steer' }, '', {}), true,
      'a non-Manual action ignores the sticks entirely');
  }
  assert.equal(defaults.thrust.validate.call({ id: 'm1' }, 0, {}), true, '0 is a commanded zero');
  assert.equal(defaults.thrust.validate.call({ id: 'm1' }, 1, {}), true);
  assert.match(String(defaults.thrust.validate.call({ id: 'm1' }, 60, {})), /not a percentage/);
  assert.match(String(defaults.buttons.validate.call({ id: 'm1' }, 70000, {})), /16-bit/);
});

test('mavlink-move: every `show` key actually reaches a toggle', () => {
  // The structural lint for the bug Gitar found: `show.targetComponent = false`
  // was dead, because the two target rows are the ones refreshVisibility does
  // NOT drive from `show` — applyCompanionTargetVisibility owns them. A source
  // grep for the assignment passed happily on code that did nothing.
  //
  // So the invariant is asserted directly: every key assigned into `show` is
  // either toggled from it, or named in the helper-managed allowlist below.
  // Adding a key without a toggle now fails here instead of silently leaving a
  // row on screen.
  const HELPER_MANAGED = new Set(['targetSystem', 'targetComponent']);

  const block = /function moveRowVisibility\(state\) \{\n {8}return \{([\s\S]*?)\n {8}\};/.exec(html);
  assert.ok(block, 'the row-visibility map must be extractable');
  const keys = [...block[1].matchAll(/^\s*([a-zA-Z]+):/gm)].map((m) => m[1]);
  assert.ok(keys.length > 20, `expected the full show map, got ${keys.length} keys`);

  // The toggles are now a loop over the map's own keys, so "a key with no
  // toggle" is unrepresentable rather than merely tested for. What can still
  // go wrong is the other end: a key whose row id does not exist in the
  // markup toggles nothing at all, silently — so that is what is asserted.
  assert.match(
    html,
    /Object\.keys\(show\)\.forEach\(\(key\) => \{[\s\S]{0,220}?\$\(`#row-move-\$\{key\}`\)\.toggle\(!!show\[key\]\);/,
    'every key of the map is toggled by construction'
  );
  assert.match(
    html,
    /if \(HELPER_ROWS\.indexOf\(key\) !== -1\) return;/,
    'and the helper-owned rows are the only ones the loop skips'
  );
  for (const key of keys) {
    if (HELPER_MANAGED.has(key)) continue;
    assert.match(
      html,
      new RegExp(`id="row-move-${key}"`),
      `show.${key} must name a row that exists, or the loop toggles nothing`
    );
  }
  // The allowlist in the source must agree with the one asserted here.
  assert.match(
    html,
    /const HELPER_ROWS = \['targetSystem', 'targetComponent'\];/,
    'the skip list is exactly the rows the companion helper owns'
  );

  // And the allowlist is not a place to hide things: both members must be
  // handed to the helper that does own them.
  for (const managed of HELPER_MANAGED) {
    assert.match(
      html,
      new RegExp(`${managed}Row: '#row-move-${managed}'`),
      `${managed} is allowlisted, so it must be passed to applyCompanionTargetVisibility`
    );
  }
});


// ── Family-aware Action list (#304 §4, §14 2026-08-14) ───────────────────────

/** Profiles for every ArduPilot family, plus a PX4 one to prove the gate's edge. */
const FAMILY_LOOKUP = {};
for (const family of ['copter', 'plane', 'rover', 'boat', 'sub', 'blimp', 'antenna-tracker', 'unknown']) {
  FAMILY_LOOKUP[`conn-${family}`] = { vehicle: `veh-${family}` };
  FAMILY_LOOKUP[`veh-${family}`] = {
    firmware: 'ardupilot', dialect: 'ardupilotmega', vehicleFamily: family,
  };
}
FAMILY_LOOKUP['conn-px4-blimp'] = { vehicle: 'veh-px4-blimp' };
FAMILY_LOOKUP['veh-px4-blimp'] = { firmware: 'px4', dialect: 'common', vehicleFamily: 'blimp' };

/**
 * `action.validate` run for real against a bound profile — the family gate is
 * a claim about behaviour, and the last version of this file string-matched a
 * source line that did nothing (Gitar, #303).
 *
 * @param {string} family
 * @param {string} action
 * @param {string} [connection]
 * @returns {true|string}
 */
function actionVerdict(family, action, connection) {
  const defaults = loadNodeDefaults('mavlink-move', FAMILY_LOOKUP);
  return defaults.action.validate.call(
    { id: 'm1', action, delivery: 'send', connection: connection || `conn-${family}` },
    action,
    {}
  );
}

test('mavlink-move: the Buttons multi-select composes the bitmask the operator used to hand-compute', () => {
  // The raw field's built-in trap: "button 3" is the value 4, and an operator
  // typing 3 pressed buttons 1 and 2. Node-RED's typedInput owns the menu; the
  // multi-select is a view over the same hidden canonical field — the config
  // value, its validator, and msg.payload.buttons are all unchanged — so this
  // extracts and executes the pure helpers that translate between the two.
  const options = /const BUTTON_OPTIONS = \[\];\n\s*for \(let bit = 0; bit < 16; bit\+\+\) BUTTON_OPTIONS\.push\([^\n]*\);\n/.exec(html);
  const toBits = /function buttonsToBits\(value\) \{[\s\S]*?\n {2}\}/.exec(html);
  const toMask = /function bitsToButtons\(csv\) \{[\s\S]*?\n {2}\}/.exec(html);
  const maskPred = /function isValidButtonsMask\(n\) \{[\s\S]*?\n {2}\}/.exec(html);
  assert.ok(options && toBits && toMask && maskPred, 'the helpers must be extractable');
  const RED = { mavlink: { isBlank: (v) => v === undefined || v === null || String(v).trim() === '' } };
  const helpers = new Function('RED', `${options[0]}\n${maskPred[0]}\n${toBits[0]}\n${toMask[0]}\nreturn { buttonsToBits, bitsToButtons, BUTTON_OPTIONS };`)(RED);

  assert.equal(helpers.BUTTON_OPTIONS.length, 16, 'sixteen is the uint16 type width, not a guess');
  assert.deepEqual(helpers.BUTTON_OPTIONS[2], { value: '2', label: 'Button 3' }, 'Button 3 is bit 2');

  // The off-by-one pin: Button 3 is bit 2 is the value 4.
  assert.equal(helpers.buttonsToBits('4'), '2', 'value 4 selects Button 3 and nothing else');
  assert.equal(helpers.bitsToButtons('2'), '4', 'and it composes back');

  // Round-trips at the edges.
  assert.equal(helpers.bitsToButtons(helpers.buttonsToBits('65535')), '65535', 'all sixteen');
  assert.equal(helpers.buttonsToBits('1'), '0', 'Button 1 is bit 0');
  // All-off composes blank, not '0' — an untouched dialog round-trips
  // byte-identical to what it always saved, and blank is what the runtime
  // reads as BUTTONS_NONE.
  assert.equal(helpers.bitsToButtons(helpers.buttonsToBits('')), '', 'blank stays blank');
  assert.equal(helpers.buttonsToBits('garbage'), '', 'a hand-edited non-number selects nothing');
  // Over-range too (Gitar, #305): 70000's low 16 bits used to tick while the
  // grid's warning called the mask invalid — now nothing is selected and the
  // 0-65535 validator is the one voice.
  assert.equal(helpers.buttonsToBits('70000'), '', 'an over-65535 mask selects nothing');

  // The canonical field survives as the save path and the deploy-time check,
  // and the view is set before its change handler binds, so opening a dialog
  // on an invalid mask cannot blank the value the validator is red-ringing.
  assert.match(html, /<input type="hidden" id="node-input-buttons">/, 'the hidden canonical field exists');
  assert.match(html, /id="move-buttons-pick"/, 'inside the toggled row, so visibility just works');
  assert.match(
    html,
    /\$buttonsPick\.typedInput\(\{ types: \[\{ value: 'buttons', multiple: true, options: BUTTON_OPTIONS \}\] \}\);\s*\$buttonsPick\.typedInput\('value', buttonsToBits\(node\.buttons\)\);\s*\$buttonsPick\.on\('change'/,
    "Node-RED's typedInput owns the menu; value set, then change bound"
  );
  const validator = /buttons:\s*\{[\s\S]*?\n {6}\},/.exec(html);
  assert.match(validator[0], /65535/, 'the 0-65535 validator still guards hand-edited flows');
});

test('mavlink-move: Go to × Stream reds on a saved Blimp binding — withheld options red on saved (§9 ruling 6)', () => {
  // The convergent finding from the #303 review: the dropdown withheld Stream
  // for goto on a Blimp (no SET_POSITION_TARGET handler — streamed setpoints
  // are discarded in silence, §14), but nothing red on a node that already
  // held the pair or was rebound to a blimp profile. It deployed clean,
  // reported `streaming`, and the vehicle heard nothing. Every other withheld
  // option in this dialog gets the deploy-time verdict; this pins the one
  // that was missing on both arms.
  const defaults = loadNodeDefaults('mavlink-move', FAMILY_LOOKUP);
  const verdict = (family, action, delivery) => defaults.delivery.validate.call(
    { id: 'm1', action, delivery, connection: `conn-${family}` },
    delivery,
    {}
  );

  assert.match(String(verdict('blimp', 'goto', 'stream')), /Blimp cannot stream Go to/);
  // The commands a Blimp does implement stay green — and so does streaming
  // everywhere the handler exists.
  assert.equal(verdict('blimp', 'goto', 'send'), true, 'DO_REPOSITION on Send is the Blimp path');
  assert.equal(verdict('blimp', 'goto', 'confirm'), true);
  assert.equal(verdict('copter', 'goto', 'stream'), true, 'a copter streams Go to fine');
  // No profile, or a PX4 one, gates nothing: hiding requires knowledge.
  assert.equal(verdict('px4-blimp', 'goto', 'stream'), true, 'PX4 families are not gated');
});

test('mavlink-move: the family matrix reds an action the vehicle has no handler for (§14)', () => {
  // Each row was read at source across all six ArduPilot vehicles' GCS
  // dispatch tables. The three that matter are the ones that surprised us:
  // Blimp ignores the joystick, a Tracker DOES move, and Turn is Copter+Sub
  // rather than ArduPilot-wide.
  const ALLOWED = {
    copter: ['goto', 'steer', 'turn', 'speed', 'attitude', 'manual'],
    plane: ['goto', 'steer', 'speed', 'attitude', 'manual'],
    rover: ['goto', 'steer', 'speed', 'attitude', 'manual'],
    boat: ['goto', 'steer', 'speed', 'attitude', 'manual'],
    sub: ['goto', 'steer', 'turn', 'speed', 'attitude', 'manual'],
    blimp: ['goto'],
    'antenna-tracker': ['attitude', 'manual'],
  };
  const EVERY = ['goto', 'steer', 'turn', 'speed', 'attitude', 'manual'];

  for (const [family, allowed] of Object.entries(ALLOWED)) {
    for (const action of EVERY) {
      const verdict = actionVerdict(family, action);
      if (allowed.includes(action)) {
        // Steer is the one action with a second validator arm (it wants a
        // field filled), so an allowed steer legitimately reds for that
        // reason — what must not appear is the family refusal.
        assert.doesNotMatch(
          String(verdict), /has no handler on ArduPilot/,
          `${family} must be offered ${action}`
        );
      } else {
        assert.match(
          String(verdict), /has no handler on ArduPilot/,
          `${family} must refuse ${action}`
        );
      }
    }
  }
});

test('mavlink-move: the family refusal names the wire and what to use instead', () => {
  // A refusal an operator cannot act on is a dead end. Each one says which
  // message the vehicle drops and which action does work there.
  assert.match(
    String(actionVerdict('blimp', 'manual')),
    /MANUAL_CONTROL[\s\S]*DO_REPOSITION is the one motion message a Blimp implements/,
    'Blimp discards the sticks — the escape is Go to'
  );
  assert.match(
    String(actionVerdict('antenna-tracker', 'goto')),
    /DO_REPOSITION[\s\S]*point it with Attitude or Manual/,
    'a tracker does not travel, but it does move'
  );
  assert.match(
    String(actionVerdict('plane', 'turn')),
    /CONDITION_YAW[\s\S]*no guided yaw command at all/,
    'ArduPlane has no yaw command — GUIDED_CHANGE_HEADING is the unbuilt forward entry'
  );
  assert.match(
    String(actionVerdict('rover', 'turn')),
    /CONDITION_YAW[\s\S]*give it a destination instead/,
    'Rover has no CONDITION_YAW handler either'
  );
});

test('mavlink-move: an unknown family gates nothing — hiding requires knowledge', () => {
  for (const action of ['goto', 'turn', 'speed', 'attitude', 'manual']) {
    assert.doesNotMatch(
      String(actionVerdict('unknown', action)), /has no handler on ArduPilot/,
      `unknown family must still offer ${action}`
    );
  }
  // No profile at all is the same answer for the same reason.
  const defaults = loadNodeDefaults('mavlink-move', FAMILY_LOOKUP);
  assert.equal(
    defaults.action.validate.call({ id: 'm1', action: 'manual', delivery: 'send' }, 'manual', {}),
    true,
    'no bound vehicle gates nothing'
  );
});

test('mavlink-move: family gating is ArduPilot-only — PX4 has no vehicle branch to gate on', () => {
  // The matrix is ArduPilot's per-vehicle dispatch. PX4 runs one receiver with
  // no vehicle branch in it and nothing here was measured against it, so a PX4
  // profile keeps the firmware-only gate it had before.
  assert.equal(
    actionVerdict('blimp', 'manual', 'conn-px4-blimp'), true,
    'a PX4 airship is not judged by ArduPilot Blimp'
  );
  assert.match(
    String(actionVerdict('blimp', 'turn', 'conn-px4-blimp')),
    /ArduPilot command \(CONDITION_YAW\)/,
    'the firmware gate still answers on PX4'
  );
});

test('mavlink-move: a fixed wing collapses Steer to the one frame it reads', () => {
  // ArduPlane's handler opens with an early return on any frame that is not
  // LOCAL_OFFSET_NED, then uses `z` alone (§14). World and Body are silent
  // no-ops there, so they are withheld and — per §9 ruling 6 — red on a node
  // that already holds one.
  const { reference } = loadNodeDefaults('mavlink-move', FAMILY_LOOKUP);
  const verdict = (family, ref, connection) => reference.validate.call(
    { id: 'm1', action: 'steer', delivery: 'send', reference: ref,
      connection: connection || `conn-${family}` },
    ref, {}
  );

  for (const ref of ['world', 'body']) {
    assert.match(
      String(verdict('plane', ref)), /accepts only MAV_FRAME_LOCAL_OFFSET_NED/,
      `${ref} reds on a plane`
    );
  }
  assert.equal(verdict('plane', 'offset'), true, 'offset is the frame a plane flies');

  // The field collapse follows the Reference actually in force, not the family.
  // A saved World survives the withholding (ruling 6), and a form that showed
  // one field while the Reference read World would describe a message it is not
  // sending.
  assert.match(
    html,
    /const planeSteer = isSteer && gate\.gated && gate\.family === 'plane'\s*\n\s*&& reference === 'offset';/,
    'the collapse keys on the frame in force'
  );
  // And it forces the Position group open rather than only showing it: an
  // altitude typed here must not vanish underneath the operator when the node
  // is rebound to a copter and the seeded disclosure takes over again.
  assert.match(
    html,
    /if \(planeSteer\) disclosed\.position = true;/,
    'the collapse writes the disclosure state, not just this paint'
  );
  assert.equal(verdict('copter', 'world'), true, 'a copter reads 1/7/8/9 — nothing collapses');
  assert.equal(
    verdict('plane', 'world', 'conn-px4-blimp'), true,
    'the collapse is ArduPlane\'s handler, not a property of fixed wings'
  );
});

test('mavlink-move: the rebuilt Action list and the static markup cannot drift', () => {
  // Two copies of the action list now exist — the <option> markup a browser
  // renders before oneditprepare runs, and ACTION_OPTIONS which replaces it.
  // A value in one and not the other is a silently unreachable action.
  const table = /const ACTION_OPTIONS = \[[\s\S]*?\n {6}\];/.exec(html);
  assert.ok(table, 'ACTION_OPTIONS must be extractable');
  const rebuilt = [...table[0].matchAll(/\['([a-z]+)',/g)].map((m) => m[1]);
  const markup = [...html.matchAll(/<option value="([a-z]+)">[^<]*\(/g)].map((m) => m[1]);
  for (const action of rebuilt) {
    assert.ok(markup.includes(action), `${action} is rebuilt but not in the static markup`);
  }
  assert.deepEqual(
    rebuilt, ['goto', 'steer', 'turn', 'speed', 'attitude', 'manual'],
    'the roster is the six built primitives'
  );
});


// ── Steer group disclosure (#304 §4, owner request) ──────────────────────────

test('mavlink-move: the Steer group checkboxes save nothing to config', () => {
  // The whole point of disclosure over a preset vocabulary: the type_mask
  // still derives from which fields carry values, so these boxes are a view
  // and never a stored setting. Node-RED persists `node-input-*` ids, so the
  // proof is that none of them carries that prefix.
  const defaults = loadNodeDefaults('mavlink-move');
  for (const group of ['position', 'velocity', 'accel', 'yaw']) {
    assert.match(html, new RegExp(`id="move-group-${group}"`), `${group} box exists`);
    assert.doesNotMatch(
      html, new RegExp(`node-input-move-group-${group}|node-input-${group}Group`),
      `${group} box must not be a persisted field`
    );
  }
  // `yaw` is a real config property and must stay one — it is the Steer/Go to
  // yaw *value*, not the group box.
  assert.ok(defaults.yaw, 'the yaw field itself is still config');
  for (const key of ['groups', 'disclosed', 'moveGroups', 'positionGroup']) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(defaults, key), false,
      `${key} must not become a saved property`
    );
  }
});

test('mavlink-move: clearing a group clears its fields, so the form and the mask agree', () => {
  // A hidden field that still holds a value still clears its ignore bit, so a
  // group hidden with values in it would keep commanding with nothing on
  // screen to explain it.
  assertChangeHandlerContains(
    html,
    `$(\`#move-group-\${entry[0]}\`)`,
    `$(\`#node-input-\${name}\`).val('')`,
    'clearing a box clears the group it discloses'
  );
  assertChangeHandlerContains(
    html,
    `$(\`#move-group-\${entry[0]}\`)`,
    'refreshVisibility()',
    'and repaints, so the rows follow'
  );
});

test('mavlink-move: the disclosure is seeded from the fields, not from a saved flag', () => {
  // Nothing to migrate, and a hand-edited flow discloses correctly without
  // knowing the feature exists.
  assert.match(html, /function seedDisclosure/, 'the seed exists');
  assert.match(
    html,
    /[=]> !RED\.mavlink\.isBlank\(node\[name\]\)/,
    'a group is open iff one of its fields carries a value'
  );
  assert.match(html, /if \(!any\) seeded\.position = true;/, 'an empty Steer node opens on Position');
});

test('mavlink-move: the acceleration rows left Advanced for their own checkbox', () => {
  // They were in Advanced because they are rarely touched; the checkbox does
  // that job now, and keeping both meant a box that revealed rows inside a
  // collapsed section.
  const advancedAt = html.indexOf('id="move-advanced"');
  for (const id of ['row-move-aNorth', 'row-move-aEast', 'row-move-aUp']) {
    assert.ok(html.indexOf(`id="${id}"`) < advancedAt, `${id} sits with the other Steer groups`);
  }
  assert.doesNotMatch(
    html,
    /isBlank\(node\.aNorth\)/,
    'and the Advanced auto-open no longer needs to check them'
  );
});


// ── Codex round, first ready-for-review pass ─────────────────────────────────

test('mavlink-move: an all-blank Attitude reds — every ignore bit set commands nothing', () => {
  // Attitude has Steer's shape and needed Steer's rule. Blank everything and
  // ATTITUDE_TARGET_TYPEMASK comes out 199 — all five ignore bits — while the
  // node still reports `sent` or `streaming`. A setpoint carries no ack, so
  // that is the failure mode with no symptom (Codex, #303).
  const { action } = loadNodeDefaults('mavlink-move');
  const verdict = (over) => action.validate.call(
    Object.assign({ id: 'm1', action: 'attitude' }, over), 'attitude', {}
  );

  assert.match(String(verdict({})), /Attitude needs at least one field filled/);
  for (const field of ['roll', 'pitch', 'yaw', 'rollRate', 'pitchRate', 'yawRate', 'thrust']) {
    assert.equal(verdict({ [field]: '1' }), true, `${field} alone is a mode`);
  }
  // An explicit 0 is a commanded zero, not a blank — the whole point of the
  // three-state rule (§5).
  assert.equal(verdict({ thrust: '0' }), true, 'an explicit zero thrust is commanded');

  // Manual is deliberately exempt: all-blank sends INT16_MAX on every axis,
  // which is a real message. ArduSub's failsafe disarms when MANUAL_CONTROL
  // stops arriving, so no-axis frames are a legitimate deadman keepalive.
  assert.equal(
    action.validate.call({ id: 'm1', action: 'manual' }, 'manual', {}), true,
    'an all-blank Manual is a keepalive, not an empty command'
  );
});

test('mavlink-move: the thrust stick warns on ArduSub, where the -1..1 surface lies', () => {
  // ArduSub reads z as 0..1000 with neutral 500, not -1000..1000 neutral 0
  // (§14, source-read). The runtime keeps the dialect's uniform scaling — a
  // per-family map is the unmeasured guess doctrine keeps off the wire — so
  // the editor is where an operator finds out. With the blank-axis INT16_MAX
  // sentinel gone there is no unset escape either, so this check is all that
  // stands between an operator's "neutral" and a dive (Codex, #303).
  const { stickZ, stickX } = loadNodeDefaults('mavlink-move', FAMILY_LOOKUP);
  const onSub = (v) => stickZ.validate.call(
    { id: 'm1', action: 'manual', delivery: 'send', connection: 'conn-sub' }, v, {}
  );
  const onCopter = (v) => stickZ.validate.call(
    { id: 'm1', action: 'manual', delivery: 'send', connection: 'conn-copter' }, v, {}
  );

  assert.match(String(onSub('-0.5')), /neutral 0\.5/, 'a negative thrust reds on a Sub');
  assert.match(String(onSub('0')), /full reverse thrust/, 'and so does the 0 an operator means as neutral');
  assert.equal(onSub('0.5'), true, 'the neutral a Sub actually reads passes');
  assert.equal(onSub('1'), true, 'full up passes');
  assert.match(String(onSub('')), /is required for Manual/, 'and blank is refused outright now');

  // Only the thrust axis, and only on a Sub — the other three match the
  // dialect's declared range everywhere.
  assert.equal(onCopter('-0.5'), true, 'a copter reads the declared -1..1 range');
  assert.equal(
    stickX.validate.call({ id: 'm1', action: 'manual', delivery: 'send', connection: 'conn-sub' }, '-0.5', {}),
    true,
    'pitch is unaffected on a Sub'
  );
  // The generic range check still applies on top.
  assert.match(String(onSub('5')), /must be -1\.\.1/, 'out of range still reds first');
});

test('move closed vocabularies and target compid carry rings (walled-garden sweep)', () => {
  const defaults = loadNodeDefaults('mavlink-move');

  for (const v of ['home', 'msl', 'terrain']) assert.equal(defaults.altRef.validate.call({}, v, {}), true, v);
  assert.match(String(defaults.altRef.validate.call({}, 'agl', {})), /must be one of/);

  // Direction rides as a float param — a stray token would reach the wire as
  // NaN, which is the dialog's to catch (14.105).
  for (const v of ['0', '1', '-1']) assert.equal(defaults.direction.validate.call({}, v, {}), true, v);
  assert.match(String(defaults.direction.validate.call({}, 'left', {})), /must be one of/);

  for (const v of ['groundspeed', 'airspeed', 'climb', 'descent']) {
    assert.equal(defaults.speedType.validate.call({}, v, {}), true, v);
  }
  assert.match(String(defaults.speedType.validate.call({}, 'warp', {})), /must be one of/);

  // Membership runs before the firmware/tier gates on reference.
  assert.match(String(defaults.reference.validate.call({ action: 'steer' }, 'sideways', {})), /must be one of/);

  assert.equal(defaults.targetComponent.validate.call({}, '', {}), true, 'blank inherits');
  assert.equal(defaults.targetComponent.validate.call({}, '190', {}), true);
  assert.match(String(defaults.targetComponent.validate.call({}, '300', {})), /between 0 and 255/);
});
