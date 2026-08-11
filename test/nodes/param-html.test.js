'use strict';

/**
 * Param editor: param-def catalog loads from the admin API (DESIGN.md §6).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { installEditorHelpers } = require('../helpers/editor-resource');
const { assertChangeHandlerContains } = require('./html-assert');

const html = fs.readFileSync(
  path.join(__dirname, '..', '..', 'nodes', 'mavlink-param.html'),
  'utf8'
);

test('param defs load from the mavlink/param/defs admin route', () => {
  assert.match(html, /function loadParamDefs/, 'param defs loader exists');
  assert.match(
    html,
    /RED\.mavlink\.adminApiUrl\(['"]\/mavlink\/param\/defs['"]\)/,
    'param defs catalog is loaded from admin API'
  );
});

test('admin catalog fetches use adminApiUrl (httpAdminRoot-safe)', () => {
  assert.match(html, /RED\.mavlink\.adminApiUrl\(/, 'admin fetches must use adminApiUrl');
  assert.ok(
    !/\$\.getJSON\(\s*['"]\/mavlink\//.test(html),
    'bare absolute /mavlink getJSON paths must be gone'
  );
});

test('mavlink-param target sysid/compid default to empty (inherit profile) not 1', () => {
  assert.match(html, /targetSystem:\s*\{\s*value:\s*''/, 'sysid default is empty string');
  assert.match(html, /targetComponent:\s*\{\s*value:\s*''/, 'compid default is empty string');
  assert.match(html, /placeholder="[^"]*profile default[^"]*"/, 'sysid has profile default placeholder');
  assert.match(html, /RED\.mavlink\.reloadTargetCompId\(node\)/, 'compid uses shared reloadTargetCompId');
});

test('mavlink-param has identity default (vehicle comes from the shared helper)', () => {
  assert.match(
    html,
    /identity:\s*\{\s*value:\s*''\s*\}/,
    'identity default exists with empty value'
  );
});

test('mavlink-param calls refreshIdentitySelect on connection change', () => {
  assert.match(html, /RED\.mavlink\.refreshIdentitySelect\(node\)/, 'shared refreshIdentitySelect is called');
  assert.match(html, /node-input-identity/, 'identity select element exists');
  assert.doesNotMatch(html, /function refreshIdentitySelect/, 'no local identity-refresh copy');
});

test('mavlink-param dialect + vehicle + firmware defaults come from the shared helper', () => {
  // dialect/vehicle/firmware descriptors + the §6 Firmware XOR validator are
  // the shared Build-tier rule, merged via buildTierDialectDefaults with
  // withFirmware. Validator behaviour is proven in
  // mavlink-editor-resource.test.js.
  assert.match(
    html,
    /Object\.assign\([\s\S]*RED\.mavlink\.buildTierDialectDefaults\(\{\s*withFirmware:\s*true\s*\}\)\s*\)/,
    'Param defaults must merge buildTierDialectDefaults({ withFirmware: true })'
  );
});

test('mavlink-param Build shows Dialect and concrete dialects require Firmware', () => {
  assert.match(html, /node-input-dialect/, 'dialect select element exists');
  assert.match(html, /row-firmware/, 'firmware row exists');
  assert.match(html, /node-input-firmware/, 'firmware select element exists');
  assert.match(html, /value="ardupilot"/, 'ArduPilot firmware option exists');
  assert.match(html, /value="px4"/, 'PX4 firmware option exists');
  assert.match(html, /value="custom"/, 'custom firmware option exists');
  // Firmware XOR validator lives in buildTierDialectDefaults({ withFirmware: true })
  // — proven in mavlink-editor-resource.test.js. Param pins the merge, not a paste.
  assert.match(
    html,
    /buildTierDialectDefaults\(\{\s*withFirmware:\s*true\s*\}\)/,
    'firmware XOR validator comes from the shared Build-tier helper'
  );
});

test('mavlink-param has refreshVisibility and companion row hiding', () => {
  assert.match(html, /function refreshVisibility/, 'refreshVisibility function present');
  assert.match(
    html,
    /RED\.mavlink\.applyCompanionTargetVisibility\(/,
    'shared companion target visibility helper is used'
  );
  assert.match(html, /targetSystemRow:\s*['"]#row-targetSystem['"]/, 'row-targetSystem referenced');
  assert.match(html, /targetComponentRow:\s*['"]#row-targetComponent['"]/, 'row-targetComponent referenced');
  assert.match(html, /row-vehicle/, 'row-vehicle present for build tier');
  assert.match(html, /row-connection/, 'row-connection present for wire tiers');
  assert.match(html, /row-identity/, 'row-identity present for wire tiers');
  assert.match(html, /row-dialect/, 'row-dialect present for build tier');
  assert.match(html, /row-firmware/, 'row-firmware present for concrete build dialects');
  assert.match(
    html,
    /RED\.mavlink\.applyBuildTierRowVisibility\(\{/,
    'Param must call the shared visibility helper'
  );
  assert.match(html, /dialectRow:\s*'#row-dialect'/, 'dialect row selector passed');
  assert.match(html, /vehicleRow:\s*'#row-vehicle'/, 'vehicle row selector passed');
  assert.match(html, /firmwareRow:\s*'#row-firmware'/, 'firmware row selector passed');
  assert.match(html, /connectionRow:\s*'#row-connection'/, 'connection row selector passed');
  assert.doesNotMatch(
    html,
    /\$\('#row-dialect'\)\.toggle/,
    'no hand-rolled dialect row toggle'
  );
});

test('mavlink-param defs load delegates its catalog target to the shared resolver', () => {
  assert.match(html, /RED\.mavlink\.resolveCatalogTarget\(\)/,
    'the dialog resolves its target through the shared helper');
  assert.match(html, /RED\.mavlink\.resolveCatalogTarget\(\{\s*source:/,
    'and validation resolves the same way from saved config');

  // The resolver owns query construction and the connection→profile hop, so
  // the tier matrix is proven once against it (mavlink-editor-resource.test.js)
  // rather than re-asserted per node.
  assert.doesNotMatch(html, /query\s*=\s*\{\s*dialect:\s*dialect\s*\}/,
    'no hand-rolled defs query');
  assert.doesNotMatch(html, /connectionNode\.vehicle/,
    'no hand-rolled connection→vehicle hop');
  assert.doesNotMatch(html, /ardupilotmega/, 'defs load must not invent ardupilotmega');

  // Naming the field an operator still has to fill stays here: this is the
  // only dialog that requires firmware, and the only one showing the notice.
  assert.match(html, /dialect\s*===\s*'__vehicle'/,
    'the notice path distinguishes the Vehicle Profile escape');
  assert.match(html, /delivery.*===.*'build'|'build'.*===.*delivery/,
    'and is branched on delivery tier');
});

test('mavlink-param ensureConfigNodePicker called for vehicle', () => {
  assert.match(
    html,
    /ensureConfigNodePicker\(node,\s*'vehicle',\s*'mavlink-vehicle'/,
    'ensureConfigNodePicker invoked for vehicle field'
  );
});

test('mavlink-param populates Dialect select with Vehicle Profile escape', () => {
  assert.match(html, /populateDialectSelect/, 'Dialect helper is called');
});

test('mavlink-param CompID reloads when catalog source changes', () => {
  assertChangeHandlerContains(
    html,
    "$('#node-input-delivery')",
    'RED.mavlink.reloadTargetCompId(node)',
    'delivery change reloads CompID'
  );
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
  assertChangeHandlerContains(
    html,
    "$('#node-input-dialect')",
    'RED.mavlink.reloadTargetCompId(node)',
    'dialect change reloads CompID'
  );
});

/**
 * Mount the real value validator out of the file.
 *
 * Node-RED evaluates `validate` outside oneditprepare, against a saved config
 * with no dialog open, so the extracted body runs in a context carrying the
 * real shared helpers — a stubbed `resolveCatalogTarget` would quietly stop
 * proving that the loader and the validator derive the same key.
 *
 * @param {string} liveParamId  what the dialog's paramId field reports
 * @param {Function} [nodeFor]  RED.nodes.node stand-in
 * @param {object} [fields]  other live dialog fields, keyed by selector
 * @returns {object} the VM context: validateForTest, keyForTest, seed
 */
function mountValidator(liveParamId, nodeFor, fields = {}) {
  const start = html.indexOf('var _paramDefsByKey = {};');
  const end = html.indexOf("RED.nodes.registerType('mavlink-param'", start);
  assert.ok(start >= 0 && end > start, 'the keyed cache and key helper are present');

  // Anchor from the `value:` key: a bare search finds the first inline
  // validator in the file, so adding one earlier in paramDefaults would
  // silently point this harness at a different function.
  const valueKey = html.indexOf('value: {');
  assert.ok(valueKey > 0, 'the value default is present');
  const valueStart = html.indexOf('validate: function (v) {', valueKey);
  assert.ok(valueStart > valueKey, 'the value validator is present');
  const valueEnd = html.indexOf('\n        },', valueStart);
  // Unguarded, a moved closing brace makes this -1: the slice loses its last
  // character and the failure surfaces as a SyntaxError that names nothing.
  assert.ok(valueEnd > valueStart, 'the value validator terminates at the expected anchor');
  const body = html.slice(valueStart + 'validate: function (v) {'.length, valueEnd);
  assert.match(body, /_paramDefsByKey/, 'the extracted body is the definition-aware validator');

  const context = {
    // Selector-aware, and `length` agrees with `val()`. The previous stub
    // answered every selector with `length: 0` — "no such element" — while
    // still returning a live value from `.val()`, which real jQuery never
    // does; code that checks `length` before reading, as the shared helpers
    // do, saw a closed dialog and an open one at the same time.
    $: (selector) => {
      if (selector === '#node-input-paramId' && liveParamId !== undefined) {
        return { val: () => liveParamId, length: 1 };
      }
      if (Object.prototype.hasOwnProperty.call(fields, selector)) {
        return { val: () => fields[selector], length: 1 };
      }
      return { val: () => undefined, length: 0 };
    },
    Number,
    RED: {
      mavlink: {},
      nodes: { node: nodeFor || (() => null) },
      // The seeded live fields model this node's own open dialog, so the
      // edit stack says so too — liveOr only reads live for the stack's top
      // owner (#217). Unbound validator calls see the vm global as `this`,
      // so the context itself carries the owner id.
      editor: { getEditStack: () => [{ id: '__dialog-owner__' }] },
    },
    id: '__dialog-owner__',
  };
  installEditorHelpers(context);
  vm.runInNewContext(
    `${html.slice(start, end)}
     this.keyForTest = paramDefsKey;
     this.seed = function (map) { for (var k in map) { _paramDefsByKey[k] = map[k]; } };
     this.validateForTest = function (v) { ${body} };`,
    context
  );
  return context;
}

/** One definition set, under the key a dialog with no fields set would compute. */
function mountValueValidator(defs, liveParamId) {
  // Action `set`, because param_value exists only on PARAM_SET and the bounds
  // check exists only for it — a read carries no value to check.
  const context = mountValidator(liveParamId, undefined, { '#node-input-action': 'set' });
  context.seed({ [context.keyForTest({})]: defs });
  return context.validateForTest;
}

const RANGE_DEFS = { RC1_MIN: { min: 800, max: 2200 } };

test('mavlink-param value validator: blank defers to msg.payload rather than failing', () => {
  const validate = mountValueValidator(RANGE_DEFS, 'RC1_MIN');
  assert.equal(validate(''), true);
  assert.equal(validate(undefined), true);
  assert.equal(validate('   '), true);
});

test('mavlink-param value validator: refuses a value outside the documented range', () => {
  const validate = mountValueValidator(RANGE_DEFS, 'RC1_MIN');
  assert.equal(validate(1500), true, 'inside');
  assert.equal(validate(800), true, 'the bounds themselves are legal');
  assert.equal(validate(2200), true);
  assert.equal(validate(50), false, 'below min');
  assert.equal(validate(9000), false, 'above max');
});

test('a value only reaches the wire on a set, so only a set is checked for it', () => {
  // PARAM_SET is the only message carrying param_value, and the Value row is
  // shown only for a set. Configure a set with an out-of-range value, switch
  // the action to Read one, and the row disappears — if the check did not go
  // with it, the node would stay red over a field no longer on screen, with
  // no way to fix it from the dialog.
  const forAction = (action) => mountValidator('RC1_MIN', undefined, {
    '#node-input-action': action,
  });

  const set = forAction('set');
  set.seed({ [set.keyForTest({})]: RANGE_DEFS });
  assert.equal(set.validateForTest(9000), false, 'a set is checked against the bounds');
  assert.equal(set.validateForTest(1500), true);

  for (const action of ['read', 'request-list']) {
    const other = forAction(action);
    other.seed({ [other.keyForTest({})]: RANGE_DEFS });
    assert.equal(other.validateForTest(9000), true,
      `${action}: a value left over from a set is not sent, so it is not refused`);
  }
});

test('mavlink-param value validator: non-numeric always fails', () => {
  const validate = mountValueValidator(RANGE_DEFS, 'RC1_MIN');
  assert.equal(validate('abc'), false);
});

test('mavlink-param value validator: an unknown parameter is never rejected for being unknown', () => {
  // Lua scripts and custom builds declare parameters no metadata file has;
  // definitions are advisory here, not an allowlist.
  const validate = mountValueValidator(RANGE_DEFS, 'SCR_USER1');
  assert.equal(validate(999999), true);
  assert.equal(validate(-1), true);
  assert.equal(validate('abc'), false, 'but it still has to be a number');
});

test('mavlink-param value validator: with no definitions loaded it is the plain numeric check', () => {
  const validate = mountValueValidator({}, 'RC1_MIN');
  assert.equal(validate(50), true);
  assert.equal(validate('abc'), false);
});

/**
 * Definition sets are keyed, not mirrored. A single script-scope table would be
 * whatever the last opened dialog loaded, so validating a *different* node
 * would range-check against the wrong firmware — RC1_MIN is 800–1500 on PX4 and
 * 800–2200 on ArduPilot, so opening a PX4 node then deploying an ArduPilot one
 * with 2000 would fail on a value that firmware accepts.
 */
function mountKeyedValidator(byKey, editedNode, liveParamId) {
  const context = mountValidator(liveParamId, undefined, { '#node-input-action': 'set' });
  context.seed(byKey);
  // The edited node is the one whose dialog is open (#217 scoping).
  return context.validateForTest.bind({ id: '__dialog-owner__', ...editedNode });
}

const PX4_KEY = 'dialect:development|px4';
const AP_KEY = 'dialect:ardupilotmega|ardupilot';
const BY_KEY = {
  [PX4_KEY]: { RC1_MIN: { min: 800, max: 1500 } },
  [AP_KEY]: { RC1_MIN: { min: 800, max: 2200 } },
};

test('mavlink-param value validator: each node is checked against its own firmware', () => {
  const px4Node = { delivery: 'build', dialect: 'development', firmware: 'px4' };
  const apNode = { delivery: 'build', dialect: 'ardupilotmega', firmware: 'ardupilot' };

  const validatePx4 = mountKeyedValidator(BY_KEY, px4Node, 'RC1_MIN');
  const validateAp = mountKeyedValidator(BY_KEY, apNode, 'RC1_MIN');

  assert.equal(validatePx4(2000), false, 'PX4 tops out at 1500');
  assert.equal(validateAp(2000), true, 'ArduPilot allows 2000 — the reported bug');
  assert.equal(validateAp(2500), false, 'and still enforces its own 2200');
});

test('mavlink-param value validator: a node whose definitions were never loaded skips the check', () => {
  // The safe direction: no entry means no bounds to apply, never someone
  // else's bounds.
  const strangerNode = { delivery: 'build', dialect: 'common', firmware: 'custom' };
  const validate = mountKeyedValidator(BY_KEY, strangerNode, 'RC1_MIN');
  assert.equal(validate(99999), true);
  assert.equal(validate('abc'), false, 'but it is still a number check');
});

test('mavlink-param defs key: the Vehicle Profile escape keys on the profile, not the dialect', () => {
  const k = mountValidator('', () => ({ vehicle: 'v9', dialect: 'ardupilotmega' })).keyForTest;

  // The profile's own metadata joins its key, so editing an undeployed
  // profile's firmware or family cannot be served the previous catalog.
  assert.match(k({ delivery: 'build', dialect: '__vehicle', vehicle: 'v1' }), /^vehicle:v1\|/);
  assert.notEqual(
    k({ delivery: 'build', dialect: '__vehicle', vehicle: 'v1' }),
    k({ delivery: 'build', dialect: '__vehicle', vehicle: 'v2' }),
    'two profiles are two definition sets'
  );
  // Wire tiers resolve the profile through the connection.
  assert.match(k({ delivery: 'send', connection: 'c1' }), /^vehicle:v9\|/);
});

test('mavlink-param value validator: falls back to the saved id when no dialog is open', () => {
  // The branch Node-RED actually uses on deploy and on import. With a dialog
  // open the live field wins; closed, `$('#node-input-paramId')` is an empty
  // set and `.val()` is undefined, so the node's own saved id has to carry it.
  const node = {
    delivery: 'build',
    dialect: 'ardupilotmega',
    firmware: 'ardupilot',
    paramId: 'RC1_MIN',
  };
  const validate = mountKeyedValidator(BY_KEY, node, undefined);

  assert.equal(validate(2000), true, 'ArduPilot bounds, resolved from node.paramId');
  assert.equal(validate(2500), false, 'and they are actually applied, not skipped');
});

/* ---------- editor chrome ---------- */

test('a Firmware select offers blank, and says nothing in it', () => {
  // Two rules meeting. The empty option has to exist: firmware is mandatory
  // only on the Build tier with a concrete dialect, so blank is a legal saved
  // value, and a list without it would coerce every profile-sourced node to
  // the first entry — inventing an ArduPilot the operator never picked, with
  // ArduPilot's bounds and encoding behind it.
  //
  // And it has to stay unlabelled: §2 gives "this field must be set" exactly
  // one mechanism, `validate`, which reds the field and marks the node. A
  // "(select firmware)" caption is the bespoke placeholder option that row
  // rules out — a second way to say what the first already says.
  const dir = path.join(__dirname, '..', '..', 'nodes');
  const withFirmware = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.html'))
    .map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')])
    .filter(([, src]) => /id="node-input-firmware"/.test(src));

  assert.ok(withFirmware.length >= 2, 'more than one node offers a Firmware field');
  for (const [name, src] of withFirmware) {
    const select = /<select id="node-input-firmware">([\s\S]*?)<\/select>/.exec(src);
    assert.ok(select, `${name}: Firmware is a select`);
    assert.match(select[1], /<option value=""><\/option>/,
      `${name}: blank is a legal firmware and needs an option to hold it`);
    assert.doesNotMatch(select[1], /<option value="">[^<]/,
      `${name}: the blank option carries a caption instead of leaving §2 to validate`);
  }
});

test('the Param dialog carries definition detail on hover, not in a row', () => {
  // Description, unit and range are reference: read once when picking the
  // parameter, then in the way for every edit after.
  assert.doesNotMatch(html, /id="row-param-info"/, 'no standing info row');
  assert.doesNotMatch(html, /mav-param-info-text/, 'and no orphaned span for it');
  assert.match(
    html,
    /\$\('#node-input-paramId'\)\.attr\('title'/,
    'the paramId field carries it as hover text'
  );
});

/* ---------- identify by name or index ---------- */

/**
 * The dialog's real `defaults`, by running the editor script rather than
 * reading it.
 *
 * `registerType` is the only thing the script does at load time, so capturing
 * its argument yields the actual descriptors — validators included, closing
 * over the same `$` the dialog uses. Asserting on the source text instead
 * proves the file *says* something; this proves it *does* it, and a validator
 * is exactly the kind of thing that can read right and behave wrong.
 *
 * @param {object} [fields]  live field values, keyed by selector
 * @returns {object} the `defaults` object
 */
function paramDefaults(fields = {}) {
  const start = html.indexOf('<script type="text/javascript">');
  const end = html.indexOf('</script>', start);
  assert.ok(start >= 0 && end > start, 'the editor script block is where it was');

  let captured = null;
  const context = {
    RED: {
      nodes: {
        registerType: (name, def) => { captured = def; },
        getType: () => undefined,
      },
      validators: {
        number: (blankOk) => (v) =>
          (blankOk && (v === '' || v === undefined || v === null)) || Number.isFinite(Number(v)),
      },
      // Seeded live fields = this node's own open dialog (#217 scoping); the
      // closed-dialog assertions below re-bind an id-less `this` via .call.
      editor: { getEditStack: () => [{ id: '__dialog-owner__' }] },
    },
    id: '__dialog-owner__',
    // One element per selector, so `.val()` answers what the test seeded and
    // an unseeded selector answers '' — the same "field is empty" the dialog
    // sees, distinct from the closed-dialog case below.
    $: (selector) => ({ length: 1, val: () => fields[selector] }),
  };
  installEditorHelpers(context);
  vm.runInNewContext(html.slice(start + '<script type="text/javascript">'.length, end), context);

  assert.ok(captured, 'the script registered mavlink-param');
  return captured.defaults;
}

test('every saved property has the input Node-RED saves it from', () => {
  // Node-RED's load/save is `$("#node-input-<prop>").val()` (§2). A property in
  // `defaults` with no element of that id silently never persists — which is
  // how a radio *group* named `node-input-lookup` passed review while the mode
  // it collected was thrown away on every close. Config-node properties are
  // exempt: the platform builds their picker.
  const defaults = paramDefaults();
  const missing = Object.keys(defaults).filter(
    (prop) => !defaults[prop].type && !html.includes(`id="node-input-${prop}"`)
  );
  assert.deepEqual(missing, [], 'properties with nowhere to be saved from');
});

test('the mode radios write through to the field that persists', () => {
  const defaults = paramDefaults();
  assert.equal(defaults.lookup.value, 'name', 'defaults to by-name');

  // The radios may not *be* `node-input-lookup`: a group has no single element
  // carrying that id, so Node-RED's `.val()` read finds nothing and the mode
  // is dropped on close. They carry their own name and write into the hidden
  // field, which is the one thing Node-RED loads and saves.
  assert.match(html, /<input type="hidden" id="node-input-lookup">/, 'a real saved field');
  assert.doesNotMatch(html, /type="radio"[^>]*name="node-input-lookup"/,
    'radios must not impersonate the saved field');
  assert.match(html, /type="radio" name="mav-param-lookup" value="name"/);
  assert.match(html, /type="radio" name="mav-param-lookup" value="index"/);
  assert.match(
    html,
    /\$\('#node-input-lookup'\)\.val\(\s*\$\('input\[name=mav-param-lookup\]:checked'\)\.val\(\)/,
    'picking a radio writes the mode into the saved field'
  );
  assert.match(
    html,
    /\$\('input\[name=mav-param-lookup\]\[value="' \+\s*\(\$\('#node-input-lookup'\)\.val\(\)/,
    'and reopening checks the radio the saved field names'
  );

  // Which rows the mode shows is proven behaviourally in
  // param-defs-editor.test.js — running the real applyActionRows against the
  // whole action x mode matrix, rather than matching the toggle calls here.
  assert.match(
    html,
    /\$\('#node-input-paramIndex'\)\.val\(-1\)/,
    'by name, the hidden index carries the sentinel rather than a stale value'
  );
});

test('the index range check runs only where an index reaches the wire', () => {
  // Three states, one validator. By index on a read the field is real and
  // checked from 0 — -1 is the "use the name" sentinel and contradicts the
  // mode. On a set there is no `param_index` field in PARAM_SET at all, and on
  // a list request no parameter is named, so the row is hidden and carries -1;
  // checking it would red the node over a value the operator cannot see, with
  // no field on screen to fix it in.
  // A Node-RED validator refuses with the message it wants shown, not `false`,
  // so "not true" is the refusal — and the message is part of the contract.
  const refused = (result, why) => {
    assert.notEqual(result, true, why);
    assert.match(String(result), /between 0 and 32767/, `${why}: and says why`);
  };

  const byIndexRead = paramDefaults({
    '#node-input-action': 'read',
    '#node-input-lookup': 'index',
  }).paramIndex.validate;
  assert.equal(byIndexRead(0), true, '0 is the first parameter');
  assert.equal(byIndexRead(32767), true, 'and int16_t is the ceiling');
  refused(byIndexRead(-1), 'the sentinel is not a typed index');
  refused(byIndexRead(-5), 'nor is anything below it');
  refused(byIndexRead(99999), 'nor anything past the ceiling');
  // Blank has its own refusal, because the shared range check passes it as
  // "optional" and here it is the identifier — an empty box would reach the
  // wire as Number('') and read parameter 0 instead.
  assert.match(String(byIndexRead('')), /index is required/,
    'by index, an index is required');

  for (const action of ['set', 'request-list']) {
    const hidden = paramDefaults({
      '#node-input-action': action,
      '#node-input-lookup': 'index',
    }).paramIndex.validate;
    assert.equal(hidden(-1), true, `${action}: the hidden sentinel passes`);
    assert.equal(hidden(-5), true, `${action}: and nothing hidden is refused`);
  }

  // Dialog closed: no live fields, so the saved config answers instead.
  const closed = paramDefaults().paramIndex.validate;
  refused(closed.call({ action: 'read', lookup: 'index' }, -1),
    'a saved by-index read is still checked on deploy');
  assert.equal(closed.call({ action: 'set', lookup: 'index' }, -1), true,
    'a saved set is not, whatever its stale mode says');
});

test('the Index field advertises the same floor the validator enforces', () => {
  assert.match(
    html,
    /id="node-input-paramIndex"[^>]*min="0"/,
    'the spinner may not offer -1 when the validator refuses it'
  );
});
