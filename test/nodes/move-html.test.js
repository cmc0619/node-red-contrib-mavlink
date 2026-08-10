'use strict';

/**
 * mavlink-move editor: mode/delivery-driven field visibility (DESIGN.md §6).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { assertChangeHandlerContains } = require('./html-assert');

const html = fs.readFileSync(
  path.join(__dirname, '..', '..', 'nodes', 'mavlink-move.html'),
  'utf8'
);

const ROW_IDS = [
  'row-move-carrier',
  'row-move-mode',
  'row-move-frame',
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
  'row-move-px4Compat',
  'row-move-rate',
  'row-move-ttl',
];

test('mavlink-move editor reshapes fields by mode, frame, and delivery (§6)', () => {
  assert.match(html, /function refreshVisibility/, 'mode/frame/delivery drive row visibility');
  assert.match(
    html,
    /\$\('#node-input-mode'\)\.on\('change', refreshVisibility\)/,
    'mode change refreshes visibility'
  );
  assert.match(
    html,
    /\$\('#node-input-frame'\)\.on\('change', refreshVisibility\)/,
    'frame change refreshes visibility'
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

  assert.match(html, /usesPosition && !isGlobalFrame/, 'local position fields gated on mode + frame');
  assert.match(html, /usesPosition && isGlobalFrame/, 'global position fields gated on mode + frame');
  assert.match(html, /vNorth: usesVelocity/, 'velocity fields gated on mode');
  assert.match(html, /aNorth: usesAccel/, 'accel fields gated on mode');
  assert.match(html, /delivery === 'stream'/, 'stream rate and TTL gated on delivery');
});

test('mavlink-move declares the frame default and the acceleration validators', () => {
  // A wrong or missing default frame changes the carrier message for every
  // Move node that never touched the field.
  assert.match(html, /frame:\s*\{\s*value:\s*'LOCAL_NED'\s*\}/, 'frame defaults to LOCAL_NED');
  for (const field of ['aNorth', 'aEast', 'aUp']) {
    assert.match(
      html,
      new RegExp(`${field}:\\s*\\{\\s*value:\\s*0,\\s*validate:\\s*RED\\.validators\\.number\\(true\\)`),
      `${field} declares the blank-allowed numeric validator`
    );
  }
});

test('mavlink-move offers the full mode and frame matrix', () => {
  for (const mode of ['position', 'velocity', 'position-velocity', 'acceleration', 'yaw-only']) {
    assert.match(html, new RegExp(`option value="${mode}"`), `mode ${mode} offered`);
  }
  // Force is gone, not hidden: no firmware actuated the force bit (§14).
  assert.doesNotMatch(html, /option value="force"/, 'force is not offered');
  for (const frame of [
    'LOCAL_NED',
    'LOCAL_OFFSET_NED',
    'BODY_OFFSET_NED',
    'BODY_NED',
    'GLOBAL_RELATIVE_ALT',
    'GLOBAL',
    'GLOBAL_TERRAIN_ALT',
  ]) {
    assert.match(html, new RegExp(`option value="${frame}"`), `frame ${frame} offered`);
  }
  // The deprecated *_INT spellings are accepted at runtime as aliases, never
  // advertised: the editor offers only the canonical names (owner-ruled
  // 2026-08-09).
  for (const deprecated of ['GLOBAL_INT', 'GLOBAL_RELATIVE_ALT_INT', 'GLOBAL_TERRAIN_ALT_INT']) {
    assert.doesNotMatch(
      html,
      new RegExp(`option value="${deprecated}"`),
      `deprecated frame ${deprecated} not offered`
    );
  }
  // No raw type_mask input — named modes only; raw masks live in mavlink-build.
  assert.doesNotMatch(html, /type_?[mM]ask"|node-input-typeMask/, 'no raw type_mask field');
});

test('mavlink-move PX4-compat checkbox: default checked, shown only for global frames', () => {
  // Default on is the byte-identical wire choice (owner-ruled 2026-08-09):
  // checked emits the *_INT numbers 5/6/11; unchecked the spec-current 0/3/10.
  assert.match(html, /px4Compat:\s*\{\s*value:\s*true\s*\}/, 'px4Compat defaults to checked');
  assert.match(html, /type="checkbox" id="node-input-px4Compat"/, 'px4Compat is a checkbox');
  assert.match(html, /id="row-move-px4Compat"/, 'px4Compat row has ID for frame-driven toggling');
  assert.match(html, /px4Compat:\s*isGlobalFrame/, 'px4Compat shown only when a global frame is selected');
});

test('mavlink-move speaks one canonical vocabulary and labels body frames forward/right', () => {
  // Pre-1.0, no aliases (AGENTS.md "no migrations, no compatibility shims"):
  // the pre-frame mode names must not appear anywhere in the editor.
  assert.doesNotMatch(html, /local-position|local-velocity|global-position/, 'no legacy mode names');
  assert.match(html, /isBodyFrame \? 'Metres forward' : 'Metres north'/, 'body frames relabel north to forward');
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

test('mavlink-move editor canonicalizes legacy *_INT global frames on open (Codex, #240)', () => {
  // One explicit compatibility boundary (AGENTS.md "Backward compatibility"):
  // flows saved before the 2026-08-09 frame ruling store the deprecated *_INT
  // names. Without the map, the select has no matching option, refreshVisibility
  // falls back to LOCAL_NED, and saving silently reinterprets a global move as
  // a local-origin move.
  assert.match(html, /var FRAME_COMPAT = \{/, 'the compatibility map exists');
  assert.match(html, /GLOBAL_INT: 'GLOBAL'/, 'GLOBAL_INT canonicalizes');
  assert.match(html, /GLOBAL_RELATIVE_ALT_INT: 'GLOBAL_RELATIVE_ALT'/, 'GLOBAL_RELATIVE_ALT_INT canonicalizes');
  assert.match(html, /GLOBAL_TERRAIN_ALT_INT: 'GLOBAL_TERRAIN_ALT'/, 'GLOBAL_TERRAIN_ALT_INT canonicalizes');
  assert.match(
    html,
    /if \(FRAME_COMPAT\[node\.frame\]\) \{\s*\$\('#node-input-frame'\)\.val\(FRAME_COMPAT\[node\.frame\]\);/,
    'the saved frame is canonicalized into the select before anything reads it'
  );
  // The boundary must run before the visibility pass that would otherwise
  // read the unmatched select as LOCAL_NED.
  const compatAt = html.indexOf('var FRAME_COMPAT');
  const visibilityCallAt = html.indexOf('refreshVisibility()');
  assert.ok(compatAt > -1 && compatAt < visibilityCallAt, 'canonicalization precedes the first visibility pass');
  // And the legacy names must not be select options — accepted, never offered.
  assert.doesNotMatch(html, /<option value="GLOBAL_RELATIVE_ALT_INT"/, 'legacy options are not offered');
});

// ── Reposition carrier (#239) ───────────────────────────────────────────────

test('mavlink-move carrier field: setpoint default, both carriers offered, change refreshes', () => {
  // A wrong or missing default flips every existing Move node onto the
  // command path; setpoint is the pre-#239 behavior and must stay the default.
  assert.match(html, /carrier:\s*\{\s*value:\s*'setpoint'\s*\}/, 'carrier defaults to setpoint');
  assert.match(html, /option value="setpoint"/, 'setpoint carrier offered');
  assert.match(html, /option value="reposition"/, 'reposition carrier offered');
  assert.match(
    html,
    /\$\('#node-input-carrier'\)\.on\('change', refreshVisibility\)/,
    'carrier change refreshes visibility'
  );
});

test('mavlink-move delivery tiers follow the carrier (§9: tiers are computed, not fixed)', () => {
  assert.match(html, /option value="confirm">Send &amp; confirm/, 'Send & confirm offered');
  // Stream is setpoint-only (COMMAND_INT has no streaming semantics); confirm
  // is reposition-only (setpoints carry no ack). An invalid saved selection
  // falls back to Send rather than deploying a per-input refusal.
  assert.match(
    html,
    /option\[value="stream"\]'\)\.toggle\(!isReposition\)/,
    'stream option hidden on reposition'
  );
  assert.match(
    html,
    /option\[value="confirm"\]'\)\.toggle\(isReposition\)/,
    'confirm option shown only on reposition'
  );
  assert.match(
    html,
    /isReposition && liveDelivery === 'stream'\) \|\| \(!isReposition && liveDelivery === 'confirm'/,
    'invalid carrier/delivery combos coerce'
  );
});

test('mavlink-move reposition reshapes the form: position-only, global frames only', () => {
  // Reposition implies position semantics: the mode select is coerced and its
  // row hidden, so a stale setpoint mode never deploys into a refusal.
  assert.match(html, /if \(isReposition\) \{\s*\$\('#node-input-mode'\)\.val\('position'\)/, 'mode coerced to position');
  assert.match(html, /mode:\s*!isReposition/, 'mode row hidden on reposition');
  // DO_REPOSITION rides frames 0/3 only: the Local optgroup and terrain
  // option are withdrawn and a non-global saved frame coerces to relative-alt.
  assert.match(html, /optgroup\[label="Local"\]'\)\.toggle\(!isReposition\)/, 'local frames withdrawn on reposition');
  assert.match(html, /option\[value="GLOBAL_TERRAIN_ALT"\]'\)\.toggle\(!isReposition\)/, 'terrain frame withdrawn on reposition');
  assert.match(html, /\.val\('GLOBAL_RELATIVE_ALT'\)/, 'non-global saved frame coerces to GLOBAL_RELATIVE_ALT');
  // COMMAND_INT wants the spec-current 0/3 — no *_INT twin, so no PX4-compat
  // checkbox; yaw rate has no DO_REPOSITION field.
  assert.match(html, /px4Compat:\s*isGlobalFrame && !isReposition/, 'px4Compat hidden on reposition');
  assert.match(html, /yawRate:\s*!isReposition/, 'yaw rate hidden on reposition');
});

test('mavlink-move reposition params: blank-sentinel fields and the CHANGE_MODE opt-in', () => {
  for (const field of ['speed', 'radius', 'ackTimeout']) {
    assert.match(
      html,
      new RegExp(`${field}:\\s*\\{\\s*value:\\s*'',\\s*validate:\\s*RED\\.validators\\.number\\(true\\)`),
      `${field} defaults blank with the blank-allowed numeric validator`
    );
  }
  // Blank speed/radius/yaw encode the spec sentinels at runtime; the
  // placeholders say so instead of implying zero.
  assert.match(html, /id="node-input-speed"[^>]*placeholder="\(vehicle default\)"/, 'speed placeholder names the sentinel');
  assert.match(html, /id="node-input-radius"[^>]*placeholder="\(ignored\)"/, 'radius placeholder names the sentinel');
  // CHANGE_MODE is a mode change: an explicit opt-in checkbox, default off,
  // documented as such in the help.
  assert.match(html, /changeMode:\s*\{\s*value:\s*false\s*\}/, 'changeMode defaults off');
  assert.match(html, /type="checkbox" id="node-input-changeMode"/, 'changeMode is a checkbox');
  assert.match(html, /speed:\s*isReposition/, 'speed shown only on reposition');
  assert.match(html, /radius:\s*isReposition/, 'radius shown only on reposition');
  assert.match(html, /changeMode:\s*isReposition/, 'changeMode shown only on reposition');
  assert.match(html, /ackTimeout:\s*delivery === 'confirm'/, 'ACK timeout shown only on confirm');
});

test('mavlink-move help documents the reposition carrier and the mode-change flag', () => {
  assert.match(html, /DO_REPOSITION/, 'help names the command');
  assert.match(html, /COMMAND_INT/, 'help names the wire message');
  assert.match(html, /MAV_DO_REPOSITION_FLAGS_CHANGE_MODE/, 'help names the flag');
  assert.match(html, /mode change/, 'the flag is documented as a mode change');
  assert.match(html, /COMMAND_INT_ONLY/, 'help names the failure surfacing');
});
