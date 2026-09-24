'use strict';

/**
 * Build editor: Message is a dialect dropdown; fields reshape by selection (§6).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { loadNodeDefaults } = require('./html-assert');

const html = fs.readFileSync(
  path.join(__dirname, '..', '..', 'nodes', 'mavlink-build.html'),
  'utf8'
);

// Slice between two source markers, loudly: a renamed marker must fail the
// test, not shrink the slice to '' and turn its assertions vacuous.
function sliceBetween(startMarker, endMarker) {
  const start = html.indexOf(startMarker);
  const end = html.indexOf(endMarker);
  assert.notEqual(start, -1, `marker not found: ${startMarker}`);
  assert.ok(end > start, `marker not found or out of order: ${endMarker}`);
  return html.slice(start, end);
}

test('Build band select uses shared BAND_OPTIONS / fillBandSelect', () => {
  assert.match(html, /RED\.mavlink\.fillBandSelect\(/, 'band picker uses shared fillBandSelect');
  assert.doesNotMatch(html, /BAND_OPTIONS\s*=/, 'no local BAND_OPTIONS copy');
});

test('band is ringed to the shared BAND_OPTIONS vocabulary on Build and Out', () => {
  // One list paints the select and feeds the validator, so the ring cannot
  // drift from what the dialog offers (walled garden).
  for (const nodeName of ['mavlink-build', 'mavlink-out']) {
    const { band } = loadNodeDefaults(nodeName);
    for (const member of ['0', '1', '2', '3', '4']) {
      assert.equal(band.validate.call({}, member, {}), true, `${nodeName}: band ${member}`);
    }
    assert.match(String(band.validate.call({}, '', {})), /must be one of/, `${nodeName}: blank reds`);
    assert.match(String(band.validate.call({}, '5', {})), /must be one of/, `${nodeName}: out of range reds`);
  }
});

test('Build dialect + vehicle defaults come from the shared Build-tier helper', () => {
  // dialect/vehicle default descriptors + validators are the shared §6 rule,
  // merged in via buildTierDialectDefaults; the Build node keys it off `tier`.
  // The descriptor shape and validators are proven in
  // mavlink-editor-resource.test.js — here we only assert the delegation.
  assert.match(
    html,
    /\.\.\.RED\.mavlink\.buildTierDialectDefaults\(\{\s*modeField:\s*'tier'\s*\}\)/,
    'Build defaults must merge buildTierDialectDefaults({ modeField: tier })'
  );
});

test('Build registers the shared connection descriptor, not a local one', () => {
  // Executed, not grepped. A node can mention buildTierDialectDefaults and
  // still lose its descriptor — by redeclaring connection after the merge, or
  // merging the arguments the other way round — and source text cannot tell.
  const { connection } = loadNodeDefaults('mavlink-build');

  assert.equal(connection.type, 'mavlink-connection');
  // No `required` key: paired with a validate it would short-circuit the blank
  // to valid before the validator ran (§14).
  assert.equal(Object.prototype.hasOwnProperty.call(connection, 'required'), false);
  // Arity 2 is what makes a returned reason string count as invalid (§14).
  assert.equal(connection.validate.length, 2);
});

test('Build messageName defaults to HEARTBEAT and is a <select>', () => {
  assert.match(html, /messageName:\s*\{\s*value:\s*'HEARTBEAT'/);
  assert.match(html, /<select id="node-input-messageName"/);
  // A search box drives the select by name or id; the select stays the saved
  // property so nothing outside the dialect can reach messageName.
  assert.match(html, /<input type="text" id="mav-build-msg-search"/);
  assert.match(
    html,
    /RED\.mavlink\.mountEnumSearch\(\s*\$\('#mav-build-msg-search'\), \$\('#node-input-messageName'\), \{ valueKey: 'name', numberKey: 'id' \}\s*\)/
  );
  assert.match(html, /messageSearch\.setEntries\(catalog\.messages \|\| \[\]\)/);
  // The embedded MAV_CMD select gets the same treatment, and its box carries
  // no .mav-field-input so the field collector never scrapes it.
  assert.match(html, /<input type="text" id="mav-build-command-search" placeholder="type a name or number">/);
  assert.match(html, /RED\.mavlink\.mountEnumSearch\(cmdSearch, cmdSel, \{ prefix: 'MAV_CMD_' \}\)\.setEntries\(commands\)/);
  assert.ok(
    !html.includes('placeholder="e.g. HEARTBEAT"'),
    'free-form message placeholder must be gone'
  );
});

test('Build reshapes fields from message metadata and handles COMMAND_LONG/INT', () => {
  assert.match(html, /RED\.mavlink\.loadCatalog\(\s*['"]\/mavlink\/build\/messages['"]/);
  assert.match(html, /function refreshFieldForm/);
  assert.match(html, /spec\.enum/);
  assert.match(html, /COMMAND_LONG/);
  assert.match(html, /wireFieldForCommandParam/);
  assert.match(html, /mav-build-command-select/);
  assert.match(html, /isCommandParamSlot/);
  assert.match(html, /data-kind.*array|data-kind', 'array'/);
  assert.match(html, /bitmask/);
  assert.match(html, /int64/);
  assert.match(html, /syncSavedFieldsFromDom/);
  assert.match(html, /collectFieldInputsFromDom/);
  assert.match(html, /clearCommandParamWireFields/);
  assert.match(html, /lastBuildCommandId/);
  assert.ok(
    !/<textarea id="node-input-fields"/.test(html),
    'raw JSON fields textarea must be replaced by dynamic controls'
  );
  assert.match(html, /oneditsave/);
});

test('Build does not render generated constant fields', () => {
  const commandRenderer = sliceBetween('if (COMMAND_MESSAGES[msg.name]) {', 'const cmdSel =');
  assert.match(
    commandRenderer,
    /if \(spec\.constValue !== undefined\) return;/,
    'COMMAND_LONG/INT fields omit generated constants'
  );
  const messageRenderer = sliceBetween('const fields = msg.fields || [];', '// Type a message by name or id');
  assert.match(
    messageRenderer,
    /if \(spec\.constValue !== undefined\) return;/,
    'ordinary message fields omit generated constants'
  );
});

test('Build target_component is a MAV_COMPONENT pulldown, not a bare number (§6)', () => {
  assert.match(
    html,
    /spec\.name === ['"]target_component['"]/,
    'XML leaves target_component without enum= — Build special-cases the name'
  );
  assert.match(
    html,
    /reloadCompIdSelect\(/,
    'must reuse the shared CompID helper — not a local loadEnumsCatalog path'
  );
  assert.doesNotMatch(
    html,
    /loadEnumsCatalog\(\['MAV_COMPONENT'\]/,
    'Build must not hand-roll the MAV_COMPONENT fetch'
  );
});

test('Build message-field enums and bitmasks save wire numbers', () => {
  const collector = sliceBetween('function collectFieldInputsFromDom', 'RED.nodes.registerType');
  const fieldRenderer = sliceBetween('function fieldInput', 'function syncSavedFieldsFromDom');

  assert.match(fieldRenderer, /spec\.display === ['"]bitmask['"]/, 'message field bitmasks follow field metadata');
  assert.match(fieldRenderer, /RED\.mavlink\.isFalseTrueEnum\(entries\)/, 'FALSE/TRUE enums are detected before bitmask rendering');
  assert.match(
    fieldRenderer,
    /if \(falseTrue\) \{\s*return RED\.mavlink\.booleanEnumInput\(/,
    'FALSE/TRUE fields early-return to the shared checkbox (numeric 0/1 saving is pinned in mavlink-editor-resource.test.js)'
  );
  assert.match(fieldRenderer, /\.attr\(['"]multiple['"],\s*['"]multiple['"]\)/, 'message field bitmasks use native multi-select');
  assert.match(fieldRenderer, /\.val\(String\(entry\.value\)\)/, 'options carry the wire value, never the entry name');
  assert.match(fieldRenderer, /multi \? ['"]bitmask-mask['"] : ['"]enum['"]/, 'a bitmask field folds to one mask through the same collector branch as command params');
  assert.match(fieldRenderer, /RED\.mavlink\.selectedBitmaskValues\(saved, entries\)/, 'a saved mask re-selects its bits on open');
  assert.match(fieldRenderer, /sel\.val\(String\(saved\)\)/, 'a saved value selects by value');
  assert.match(collector, /kind === ['"]enum['"]\) \{\s*fields\[name\] = Number\(raw\)/, 'the enum branch saves the option number');
  assert.doesNotMatch(collector, /kind === ['"]bitmask['"]\)/, 'no name-array branch');
});

test('Build COMMAND_LONG/INT command params render through the shared paramControl', () => {
  // The ladder itself — FALSE/TRUE checkbox, enum pulldown, bitmask
  // multi-select, magic boolean, number with XML range, and the #198
  // saved-value sentinel — is RED.mavlink.paramControl, proven executed in
  // mavlink-editor-resource.test.js. Build contributes only its collector
  // attributes and the one-numeric-mask fold.
  const renderer = sliceBetween('function commandParamInput', 'function refreshCommandParams');

  assert.match(renderer, /RED\.mavlink\.paramControl\(spec, enums, \{/, 'the ladder lives in the shared file (14.32)');
  assert.match(renderer, /className:\s*'mav-field-input'/, 'controls carry the class the collector scrapes');
  assert.match(renderer, /attrName:\s*'data-field'/, 'the collector reads data-field');
  assert.match(renderer, /attrValue:\s*key/, 'keyed by the wire field (paramN, or COMMAND_INT x/y/z)');
  assert.match(renderer, /bitmaskKind:\s*'bitmask-mask'/, 'bitmask params fold to one numeric mask on save');
  assert.match(
    renderer,
    /commandId:\s*\$\('#mav-build-command-select'\)\.val\(\)/,
    'the magic-boolean lookup keys off the selected MAV_CMD'
  );
  assert.doesNotMatch(
    renderer,
    /isFalseTrueEnum|booleanEnumInput|selectedBitmaskValues|<select/,
    'no local copy of the ladder (14.32)'
  );
  assert.match(html, /kind === ['"]bitmask-mask['"]/, 'collector stores one numeric mask for command params');
});

test('Build fieldInput keeps a saved enum value the table lacks (#198)', () => {
  // Same gap the command-param ladder had: a saved value the current dialect
  // lacks silently deselected, and open-and-save dropped the field. The
  // message-field enum path stays local, with the shared sentinel in its
  // no-match arm.
  const fieldRenderer = sliceBetween('function fieldInput', 'function syncSavedFieldsFromDom');
  assert.match(
    fieldRenderer,
    /RED\.mavlink\.ensureSavedEnumOption\(sel, String\(saved\)\);\s*\n\s*sel\.val\(String\(saved\)\)/,
    'the shared sentinel runs before the saved value is applied'
  );
});

test('admin catalog fetches go through shared loadCatalog (httpAdminRoot-safe)', () => {
  assert.match(html, /RED\.mavlink\.loadCatalog\(/, 'catalog fetches use shared loadCatalog');
  assert.ok(
    !/\$\.getJSON\(\s*['"]\/mavlink\//.test(html),
    'bare absolute /mavlink getJSON paths must be gone'
  );
});

test('Build\'s registered validator is the shared one, by its behaviour', () => {
  // The old local validator was `if (tier !== 'build') return !!v`, which also
  // disabled Node-RED's config-node reference check — build was the only node
  // that would not report a deleted Connection. Absence of that expression
  // proves nothing; these three outcomes are only possible from the shared
  // descriptor, and the last is the one the local version could not produce.
  const { connection } = loadNodeDefaults('mavlink-build', { live: { valid: true } });

  assert.equal(connection.validate.call({ tier: 'build' }, ''), true, 'blank is correct on Build');
  assert.equal(connection.validate.call({ tier: 'send' }, 'live'), true, 'a live Connection passes');
  assert.match(
    String(connection.validate.call({ tier: 'send' }, 'deleted')),
    /no longer exists/,
    'a dangling reference is reported — the check a local validator suppresses'
  );
});

test('Build dialect select uses the shared helper and includes __vehicle escape option', () => {
  assert.match(html, /RED\.mavlink\.populateDialectSelect\(/, 'dialect select must use shared helper');
  assert.match(html, /__vehicle/, 'dialect select must have __vehicle option value');
  assert.match(html, /from Vehicle Profile/, 'dialect select must label the escape option');
});

test('Build vehicle default no longer has required: true', () => {
  assert.ok(
    !html.includes('required: true'),
    'vehicle must not carry required: true once the dialect picker is added'
  );
});

test('Build visibility delegates the shared four rows to applyBuildTierRowVisibility', () => {
  assert.match(html, /mav-dialect-row/, 'template must have a mav-dialect-row element');
  assert.match(html, /mav-vehicle-row/, 'template must have a mav-vehicle-row element');
  assert.match(html, /updateVisibility/, 'oneditprepare must call updateVisibility');
  assert.match(
    html,
    /RED\.mavlink\.applyBuildTierRowVisibility\(\{/,
    'Build must call the shared visibility helper'
  );
  assert.match(html, /dialectRow:\s*'#mav-dialect-row'/, 'dialect row selector passed');
  assert.match(html, /vehicleRow:\s*'#mav-vehicle-row'/, 'vehicle row selector passed');
  assert.match(html, /connectionRow:\s*'#mav-connection-row'/, 'connection row selector passed');
  assert.doesNotMatch(
    html,
    /\$\('#mav-dialect-row'\)\.(show|hide|toggle)/,
    'no hand-rolled dialect row toggle'
  );
});

test('Build catalog targeting delegates to the shared loader (no local copy)', () => {
  // resolve → cache → getJSON → seq-guard lives in RED.mavlink.loadCatalog
  // (proven in mavlink-editor-resource.test.js). Build passes its tier-derived
  // isBuild flag and must not paste the skeleton.
  assert.match(
    html,
    /RED\.mavlink\.loadCatalog\(\s*['"]\/mavlink\/build\/messages['"][\s\S]*isBuild:\s*buildTierIsBuild\(\)/,
    'Build messages catalog uses shared loadCatalog with tier-derived isBuild'
  );
  assert.match(
    html,
    /RED\.mavlink\.loadCatalog\(\s*['"]\/mavlink\/command\/commands['"][\s\S]*isBuild:\s*buildTierIsBuild\(\)/,
    'Build commands catalog uses shared loadCatalog with tier-derived isBuild'
  );
  assert.match(
    html,
    /\$\('#node-input-tier'\)\.val\(\)[^=]*===\s*'build'/,
    'isBuild is derived from the Build node tier field'
  );
  assert.doesNotMatch(html, /function resolveCatalogTarget/, 'no local catalog resolver copy');
  assert.doesNotMatch(html, /\$\.getJSON\(\s*RED\.mavlink\.adminApiUrl/, 'no hand-rolled catalog getJSON');
  assert.doesNotMatch(html, /ardupilotmega/, 'catalog target resolution must not hardcode ardupilotmega');
  // "Not configured yet" is the required-field validation's job (red field +
  // node marker) — no bespoke pending mechanism in the dialog.
  assert.doesNotMatch(html, /pending/, 'no hand-rolled pending state');
});

test('build command-param pulldowns drop the blank; message fields keep it', () => {
  // Different meanings, so different treatment. An unset *command param*
  // resolves to 0 (the builder fills the slot), so blank duplicated an enum
  // entry. An unset *message field* is left out of the saved fields, so blank
  // there is the only way to leave a field to msg.payload — removing it would
  // change what gets sent, not just what shows.
  const commandParams = sliceBetween('function commandParamInput', 'function refreshCommandParams');
  assert.ok(commandParams.length > 0, 'located the command-param renderer');
  assert.match(commandParams, /RED\.mavlink\.paramControl\(/, 'slice really is the renderer');
  // The no-blank rule is inside the shared builder (executed test in
  // mavlink-editor-resource.test.js); nothing here may re-add one.
  assert.ok(!/\\u2014/.test(commandParams), 'command params have no blank option');

  const messageFields = sliceBetween('function fieldInput', 'function commandParamInput');
  assert.ok(messageFields.length > 0, 'located the message-field renderer');
  assert.match(messageFields, /spec\.display === 'bitmask'/, 'slice really is the message-field renderer');
  assert.match(messageFields, /\\u2014/, 'message fields keep blank = omit the field');
});

test('every palette node carries a bare paletteLabel (#106)', () => {
  // All ten are category "mavlink", and Node-RED renders the category as the
  // group header — so 'mavlink in' read as "mavlink › mavlink in". Bare labels,
  // and every node has one rather than falling back to its raw type name.
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(__dirname, '..', '..', 'nodes');

  const missing = [];
  const prefixed = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.html'))) {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    if (!/category: 'mavlink'/.test(src)) continue;  // config nodes have no palette entry
    const label = /paletteLabel: '([^']*)'/.exec(src);
    if (!label) { missing.push(file); continue; }
    if (/^mavlink[ -]/.test(label[1])) prefixed.push(`${file}: ${label[1]}`);
  }

  assert.deepEqual(missing, [], 'every palette node declares a paletteLabel');
  assert.deepEqual(prefixed, [], 'the category already says "mavlink" — do not repeat it');
});

test('Build validates the fields JSON in the editor, so the runtime need not', () => {
  // The free mechanism: Node-RED reds the field and marks the node. The runtime
  // used to re-ask, badge, and return before registering an input handler.
  const { fields } = loadNodeDefaults('mavlink-build');

  assert.equal(fields.validate.length, 2, 'two args, or a reason string reads as valid (§14)');
  assert.equal(fields.validate.call({}, '{}'), true);
  assert.equal(fields.validate.call({}, '{"type": 6}'), true);
  assert.equal(fields.validate.call({}, ''), true, 'blank is the documented empty');
  assert.match(String(fields.validate.call({}, '{ not valid json')), /not valid JSON/);
  assert.match(String(fields.validate.call({}, '[1,2]')), /JSON object/);
  assert.match(String(fields.validate.call({}, '42')), /JSON object/);
});

test('mavlink-build: a blank message name reds in the editor (§6 status ruling, 2026-08-12)', () => {
  // Config validity is the editor's verdict (§6), so this validator is the
  // only thing between a cleared field and a node whose every input fails with
  // "dialect or message unresolved".
  const { messageName } = loadNodeDefaults('mavlink-build');
  assert.match(String(messageName.validate.call({}, '', {})), /is required/);
  assert.match(String(messageName.validate.call({}, '   ', {})), /is required/, 'whitespace is blank');
  assert.equal(messageName.validate.call({}, 'HEARTBEAT', {}), true);
  assert.equal(messageName.validate.length, 2, 'a reason-returning validator declares (v, opt) — §14');
});

test('mavlink-build: a message the dialect lost reds too, not just a blank one', () => {
  // The reachable path is normal editing, not hand-edited JSON: switch an
  // existing node's dialect or Connection and fillEnumSelect keeps the old name
  // selectable as the `#NAME (not in dialect)` sentinel so it survives
  // open-and-save (#198). Surviving is right; deploying is not — messageMeta
  // resolves null and every trigger fails at mavlink-build.js:147-149.
  const sentinel = { dom: { '#node-input-messageName': { val: 'PLANE_ONLY_MSG',
    selectedText: '#PLANE_ONLY_MSG (not in dialect)' } }, editStack: [{ id: 'b1' }] };
  const { messageName } = loadNodeDefaults('mavlink-build', {}, sentinel);
  assert.match(
    String(messageName.validate.call({ id: 'b1' }, 'PLANE_ONLY_MSG', {})),
    /not in this dialect/
  );

  // A real option in the same open dialog carries its own label, not the
  // sentinel's — the check keys off the label, so it must not red everything.
  const present = { dom: { '#node-input-messageName': { val: 'HEARTBEAT',
    selectedText: 'HEARTBEAT' } }, editStack: [{ id: 'b1' }] };
  assert.equal(
    loadNodeDefaults('mavlink-build', {}, present).messageName.validate.call({ id: 'b1' }, 'HEARTBEAT', {}),
    true
  );

  // Somebody else's dialog is on top: the config-save cascade validates closed
  // nodes, and their select is not the one in the DOM (#217). Reading it would
  // red a node that is fine and cache the verdict.
  const foreign = { dom: { '#node-input-messageName': { val: 'PLANE_ONLY_MSG',
    selectedText: '#PLANE_ONLY_MSG (not in dialect)' } }, editStack: [{ id: 'other' }] };
  assert.equal(
    loadNodeDefaults('mavlink-build', {}, foreign).messageName.validate.call({ id: 'b1' }, 'HEARTBEAT', {}),
    true
  );
});

/**
 * Run the Build editor script over a stub dialog, fire the dialect change so
 * the message catalog loads, and return the `fields` validator that now reads
 * it. The loader hands `catalog` straight back; dialog chrome is a no-op.
 *
 * @param {object} catalog  `{ messages, enums }` as /mavlink/build/messages serves it
 * @returns {Function}
 */
function fieldsValidatorWithCatalog(catalog) {
  const start = html.indexOf('<script type="text/javascript">');
  const script = html.slice(html.indexOf('>', start) + 1, html.indexOf('</script>', start));
  const handlers = {};
  function $(sel) {
    const el = { length: 0 };
    for (const k of ['empty', 'append', 'appendTo', 'off', 'val', 'text', 'find', 'attr']) el[k] = () => el;
    el.on = (ev, fn) => { handlers[`${sel} ${ev}`] = fn; return el; };
    return el;
  }
  const registered = {};
  const noop = () => {};
  vm.runInNewContext(script, {
    RED: {
      mavlink: {
        BAND_OPTIONS: [],
        oneOf: () => () => true,
        validateAtLeast: () => () => true,
        buildTierDialectDefaults: () => ({}),
        isBlank: (v) => v === undefined || v === null || String(v).trim() === '',
        liveOr: (_node, _sel, saved) => saved,
        fillBandSelect: noop,
        applyBuildTierRowVisibility: noop,
        populateDialectSelect: noop,
        fillEnumSelect: noop,
        mountEnumSearch: () => ({ setEntries: noop }),
        loadCatalog: (_endpoint, _state, cb) => cb(catalog),
      },
      nodes: { registerType(name, def) { registered[name] = def; } },
    },
    $,
  });
  const def = registered['mavlink-build'];
  def.oneditprepare.call({ fields: '{}', tier: 'build', band: '2', dialect: 'common', messageName: 'PROBE' });
  handlers['#node-input-dialect change']();
  return def.defaults.fields.validate;
}

const PROBE_CATALOG = {
  enums: {},
  messages: [{
    name: 'PROBE',
    fields: [
      { name: 'u8', type: 'uint8_t', arrayLength: null },
      { name: 'u16', type: 'uint16_t', arrayLength: null },
      { name: 'i32', type: 'int32_t', arrayLength: null },
      { name: 'f', type: 'float', arrayLength: null },
      { name: 'big', type: 'uint64_t', arrayLength: null },
      { name: 'sbig', type: 'int64_t', arrayLength: null },
      { name: 'label', type: 'char', arrayLength: 4 },
      { name: 'arr', type: 'uint16_t', arrayLength: 3 },
      { name: 'farr', type: 'float', arrayLength: 2 },
    ],
  }],
};

test('Build fields: each value must fit its wire type once the dialect is loaded (A3)', () => {
  const validate = fieldsValidatorWithCatalog(PROBE_CATALOG);
  const node = { messageName: 'PROBE' };
  const check = (fields) => validate.call(node, JSON.stringify(fields), {});

  assert.equal(check({
    u8: 255, u16: 0, i32: -2147483648, f: 1.5,
    big: '18446744073709551615', sbig: '-9223372036854775808',
    label: 'a.b!', arr: [1, 2], farr: [0.5, -1],
  }), true, 'whole integers, finite floats, 64-bit decimal strings');

  // Buffer truncates a fraction silently: 1.5 in a uint16 would go out as 1.
  assert.equal(check({ u16: 1.5 }), 'u16 must be a whole number');
  assert.equal(check({ i32: 47.4 }), 'i32 must be a whole number', 'degrees typed into a degE7 field');
  // Out of range is Buffer's own refusal at send, not a ring.
  assert.equal(check({ u8: 300 }), true);

  // A junk array token is kept as a string by the collector; Buffer writes it
  // as 0 into an integer array and NaN into a float array.
  assert.equal(check({ arr: [1, '2x', 3] }), 'arr[1] must be a whole number');
  assert.equal(check({ arr: [1, 2.5] }), 'arr[1] must be a whole number');
  assert.equal(check({ farr: [1, '2x'] }), 'farr[1] must be a finite number');
  assert.equal(check({ farr: [1, 'NaN'] }), true, 'a typed NaN is the float "not used" value');
  assert.equal(check({ f: 'abc' }), 'f must be a finite number');

  // 64-bit fields save a decimal string the runtime reads as a BigInt.
  assert.equal(check({ big: '12abc' }), 'big must be a whole number');

  // Length is still checked before type.
  assert.equal(check({ arr: [1, 2, 3, 4] }), 'arr has 4 entries — 3 fit');
});

test('Build fields: type checks wait for the dialect, like the length check', () => {
  // Closed dialog: no catalog is in hand, so there is nothing to measure against.
  const { fields } = loadNodeDefaults('mavlink-build');
  assert.equal(fields.validate.call({ messageName: 'PROBE' }, '{"u16": 1.5}', {}), true);
  // A message the catalog does not carry resolves no field types.
  const validate = fieldsValidatorWithCatalog(PROBE_CATALOG);
  assert.equal(validate.call({ messageName: 'OTHER' }, '{"u16": 1.5}', {}), true);
});

test('COMMAND_INT carries only param7 into z; x/y int32 start blank', () => {
  // COMMAND_INT x/y are raw int32 (degE7 in global frames) and this node sends
  // raw fields, so carrying param5/6 degrees would put 47 on the wire for 47.39.
  const renderer = sliceBetween('function commandParamInput', 'function refreshCommandParams');
  assert.match(renderer, /msgName === 'COMMAND_INT' && spec\.index === 7\)/);
  assert.match(renderer, /saved = savedFields\.param7;/);
  assert.doesNotMatch(renderer, /spec\.index >= 5/);
  assert.doesNotMatch(renderer, /INT build scales/);
});

test('repeatMs: a whole number of milliseconds, 0 = off', () => {
  const { repeatMs } = loadNodeDefaults('mavlink-build');
  const validate = (v) => repeatMs.validate.call({}, v, {});
  assert.equal(validate(0), true, 'off');
  assert.equal(validate(1000), true);
  assert.match(String(validate(0.5)), /whole number/, 'a fraction would run the timer at 1 ms');
});
