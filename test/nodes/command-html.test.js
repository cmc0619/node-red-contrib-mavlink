'use strict';

/**
 * Guard for the mavlink-command editor's advanced-command field binding
 * (DESIGN.md §6; review finding). Node-RED binds a config property `foo` to the
 * DOM element with id `node-input-foo`. The advanced command property is
 * `advancedCommand`, so the input must be `node-input-advancedCommand`; the
 * earlier `node-input-advanced-command` id never persisted the value.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { assertChangeHandlerContains, loadNodeDefaults } = require('./html-assert');

const html = fs.readFileSync(
  path.join(__dirname, '..', '..', 'nodes', 'mavlink-command.html'),
  'utf8'
);

test('advanced command input binds to the advancedCommand property', () => {
  assert.match(html, /id="node-input-advancedCommand"/, 'input id must match the property');
  assert.ok(
    !html.includes('node-input-advanced-command'),
    'the unbound kebab-case id must be gone'
  );
});

test('advanced command is a MAV_CMD <select>, not a free-form number (§6/§9)', () => {
  assert.match(
    html,
    /<select id="node-input-advancedCommand"/,
    'Advanced mode must use a select dropdown'
  );
  assert.ok(
    !html.includes('type="number" id="node-input-advancedCommand"'),
    'the free-form numeric id field must be gone'
  );
  assert.match(
    html,
    /RED\.mavlink\.loadCatalog\(\s*['"]\/mavlink\/command\/commands['"]/,
    'dialect MAV_CMD list uses shared loadCatalog'
  );
  assert.match(html, /function buildAdvancedDropdown/, 'async load re-applies the saved command');
});

test('advanced mode enumerates params from dialect metadata, not Param 1–7 (§6)', () => {
  assert.match(html, /function advancedParamInput/, 'metadata-driven param renderer exists');
  assert.match(html, /spec\.enum/, 'enum-backed params become dropdowns');
  assert.match(html, /!p\.hidden/, 'reserved/Empty params are filtered out');
  // The forbidden raw grid must not be the Advanced path anymore.
  const advancedBlock = html.slice(
    html.indexOf("if (mode === 'advanced')"),
    html.indexOf("const presetId = $('#node-input-preset')")
  );
  assert.ok(
    !/Param \$\{i\}/.test(advancedBlock) && !/for \(let i = 1; i <= 7/.test(advancedBlock),
    'Advanced path must not build a Param 1–7 grid'
  );
  assert.match(advancedBlock, /catalog\.commands/, 'params come from the loaded catalog');
  assert.match(
    html,
    /\$\('#node-input-advancedCommand'\)\.on\('change'/,
    'changing MAV_CMD refreshes the param form'
  );
});

test('advanced catalog load ignores stale responses and keeps the in-progress selection', () => {
  // Stale-response protection lives in RED.mavlink.loadCatalog.
  assert.match(
    html,
    /RED\.mavlink\.loadCatalog\(\s*['"]\/mavlink\/command\/commands['"]/,
    'commands catalog uses the shared loader'
  );
  assert.match(html, /_cmdCatalog\s*=\s*\{\s*seq:\s*0\s*\}/,
    'commands render state has only a request sequence');
  assert.match(html, /saved:\s*node\.advancedCommand/, 'the saved MAV_CMD is offered');
  assert.match(html, /preferLive:\s*true/,
    'and an in-progress selection outranks it, so an async refill cannot snap it back');
});

test('Advanced mode populates commands before loading their parameter fields', () => {
  assert.match(
    html,
    /function refreshAdvancedCommands\(\) \{[\s\S]*loadCommandsCatalog\(function \(catalog\) \{[\s\S]*buildAdvancedDropdown\(catalog\);[\s\S]*refreshParamFields\(\);/
  );
});

test('initial preset load paints option tips before triggering the parameter refresh', () => {
  const builder = html.slice(
    html.indexOf('function buildPresetDropdown(groups)'),
    html.indexOf('/**\n       * Dialect-sourced titles')
  );
  assert.match(
    builder,
    /loadCommandsCatalog\(function \(catalog\) \{[\s\S]*applyPresetOptionTips\(sel, catalog\);[\s\S]*sel\.trigger\('change'\);/
  );
});

test('preset dropdown re-applies the saved selection and fires change after the async load', () => {
  // The preset list loads asynchronously; the builder must re-select the saved
  // preset and trigger a change so the exposed param fields render on first
  // open rather than staying stale until the user re-picks the preset.
  const builder = html.slice(
    html.indexOf('function buildPresetDropdown'),
    html.indexOf('loadPresets(buildPresetDropdown)')
  );
  assert.match(builder, /sel\.val\(node\.preset/, 'the saved preset is re-applied');
  assert.match(builder, /sel\.trigger\(['"]change['"]\)/, 'a change event is fired after building');
});

test('advanced bitmask command params render as multi-select controls', () => {
  const renderer = html.slice(
    html.indexOf('function advancedParamInput'),
    html.indexOf('function refreshParamFields')
  );

  assert.match(renderer, /spec\.bitmask/, 'param-level bitmask flag drives rendering');
  assert.match(renderer, /RED\.mavlink\.isFalseTrueEnum\(entries\)/, 'FALSE/TRUE command params are detected before bitmask rendering');
  assert.match(renderer, /data-kind['"],\s*falseTrue \? ['"]enum['"] : \(isBitmask \? ['"]bitmask['"] : ['"]enum['"]\)/, 'FALSE/TRUE bitmask params are tagged as enum selects');
  assert.match(renderer, /\.attr\(['"]multiple['"],\s*['"]multiple['"]\)/, 'bitmask enum params use native multi-select');
  assert.match(renderer, /RED\.mavlink\.booleanEntryLabel\(entry\)/, 'FALSE/TRUE command param options use boolean labels');
  assert.match(renderer, /RED\.mavlink\.bitmaskTitle/, 'multi-select title comes from the shared helper');
});

test('a saved enum value the table lacks survives open-and-save (Codex #198)', () => {
  const renderer = html.slice(
    html.indexOf('function advancedParamInput'),
    html.indexOf('function refreshParamFields')
  );
  // Without the sentinel, .val(saved) on an absent option deselects, oneditsave
  // reads null, and the param resolves to 0 on the wire — a silent mode change.
  assert.match(
    renderer,
    /RED\.mavlink\.ensureSavedEnumOption\(sel, String\(saved\)\);\s*\n\s*sel\.val\(String\(saved\)\)/,
    'the shared sentinel runs before the saved value is applied'
  );
});

test('advanced bitmask command params save one numeric mask value', () => {
  // The scrape is shared with the params validator, so it is read here rather
  // than inside `oneditsave` — one function, one set of typed reads, and no
  // way for Done to write a value the validator never judged.
  const saver = html.slice(
    html.indexOf('function scrapeParamInputs'),
    html.indexOf('function paramValues')
  );

  assert.match(saver, /kind\s*===\s*['"]bitmask['"]/, 'save path detects bitmask controls');
  // The fold itself — multi-select normalisation and the BigInt OR — lives in
  // the shared helper and is tested there (mavlink-editor-resource.test.js).
  assert.match(saver, /RED\.mavlink\.bitmaskFromSelection\(raw\)/, 'the fold comes from the shared helper');
  assert.match(saver, /mask !== null/, 'nothing selected omits the param rather than saving 0');
  assert.match(saver, /params\[idx\]\s*=\s*mask/, 'params JSON stores a number, not an array');
});

test('PRESET_PARAMS is curation-only — the dialect catalog is the data source', () => {
  const table = html.slice(
    html.indexOf('const PRESET_PARAMS = {'),
    html.indexOf('const HAS_COMPLETION')
  );

  // The XML declares enums, units, bitmask-ness, and descriptions; the static
  // table must not duplicate them (they drift — it once said MAV_MODE where
  // the XML says MAV_MODE_FLAG).
  assert.ok(!/enumName:/.test(table), 'no static enum pointers — catalog param.enum drives selects');
  assert.ok(!/fallbackOptions/.test(table), 'no hardcoded enum entry tables');
  assert.ok(!/bitmask:\s*true/.test(table), 'bitmask-ness comes from the XML enum, not curation');
  const units = [...table.matchAll(/units:\s*'([^']*)'/g)].map((m) => m[1]);
  assert.ok(units.length > 0 && units.every((u) => u === 'deg'),
    'the only curated units are lat/lon deg — the XML leaves those unitless (carrier-dependent)');
  // Curation that XML cannot know stays.
  assert.match(table, /request_message:[\s\S]*messages:\s*true/, 'message-picker flags are curation');
  // Blank-means-what guidance is the clearest case: the XML declares the
  // param, but only the preset row knows what leaving it empty transmits.
  assert.match(table, /label:\s*'Speed \(blank = no change\)'/, 'operator-guidance labels are curation');
  // Guidance that only made sense on a number box goes when the control does:
  // Force and Use Current render as checkboxes now, and the XML already calls
  // them 'Force' and 'Use Current'.
  assert.ok(!/21196/.test(table), 'no type-this-number hint next to a checkbox');
  assert.ok(!/Use current \(1 = yes\)/.test(table));
});

test('preset rows render through the Advanced catalog path', () => {
  const presetBlock = html.slice(
    html.indexOf("const presetId = $('#node-input-preset')"),
    html.indexOf('// ── Safety preset notice')
  );
  const renderer = html.slice(
    html.indexOf('function presetParamInput'),
    html.indexOf('function refreshParamFields')
  );

  assert.ok(!/loadEnumsCatalog/.test(html), 'no separate preset enum fetch — enums ride the commands catalog');
  assert.match(html, /RED\.mavlink\.loadCatalog\(\s*['"]\/mavlink\/build\/messages['"]/, 'message ids load via shared loadCatalog');
  assert.match(presetBlock, /catalogParamByIndex\(catalog, commandId, spec\.index\)/, 'each row merges the catalog param spec');
  assert.match(presetBlock, /Object\.assign\(\{\}, catalogParamByIndex/, 'curation keys override, omitted keys inherit');
  assert.match(presetBlock, /presetParamInput\(merged, catalog\.enums \|\| \{\}, commandId\)/, 'rows render with catalog enums');
  // The command id is threaded in, not re-read from the DOM: Preset resolves
  // it from the preset, Advanced from #node-input-advancedCommand, and the
  // magic-boolean lookup needs whichever one applies.
  assert.match(renderer, /return advancedParamInput\(spec, enums \|\| \{\}, commandId\);/, 'one input builder for preset and Advanced');
  assert.match(renderer, /spec\.messages/, 'message-backed preset params keep their picker');
});

test('Command CompID reloads when catalog source changes', () => {
  assert.match(html, /RED\.mavlink\.reloadTargetCompId\(node, \{\s*field:\s*'targetComponent'\s*\}\)/, 'CompID reload uses shared helper with Command field name');
  assertChangeHandlerContains(
    html,
    "$('#node-input-connection')",
    'RED.mavlink.reloadTargetCompId(node, { field: \'targetComponent\' })',
    'Connection change refreshes MAV_COMPONENT for the new dialect'
  );
  assertChangeHandlerContains(
    html,
    "$('#node-input-delivery')",
    'RED.mavlink.reloadTargetCompId(node, { field: \'targetComponent\' })',
    'Delivery tier change refreshes CompID catalog'
  );
  assertChangeHandlerContains(
    html,
    "$('#node-input-vehicle')",
    'RED.mavlink.reloadTargetCompId(node, { field: \'targetComponent\' })',
    'Build Vehicle Profile change refreshes CompID catalog'
  );
  assertChangeHandlerContains(
    html,
    '$dialect',
    'RED.mavlink.reloadTargetCompId(node, { field: \'targetComponent\' })',
    'Dialect change refreshes CompID catalog'
  );
});

test('mavlink-command target sysid/compid use "(profile default)" wording', () => {
  assert.match(
    html,
    /placeholder="[^"]*profile default[^"]*"/,
    'sysid placeholder says profile default'
  );
  assert.match(
    html,
    /RED\.mavlink\.reloadTargetCompId\(node,\s*\{\s*field:\s*'targetComponent'\s*\}\)/,
    'compid uses shared reloadTargetCompId (default emptyLabel is profile default)'
  );
  assert.ok(
    !html.includes('(connection default)'),
    '(connection default) wording must be gone'
  );
  assert.ok(
    !/emptyLabel:\s*'\(default\)'/.test(html),
    '(default) compid wording must be gone'
  );
});

test('admin catalog fetches use adminApiUrl (httpAdminRoot-safe)', () => {
  // Dialect catalogs go through loadCatalog (adminApiUrl inside the helper);
  // presets still call adminApiUrl directly.
  assert.match(html, /RED\.mavlink\.loadCatalog\(/, 'dialect catalogs use shared loadCatalog');
  assert.match(html, /RED\.mavlink\.adminApiUrl\(/, 'remaining admin fetches use adminApiUrl');
  assert.ok(
    !/\$\.getJSON\(\s*['"]\/mavlink\//.test(html),
    'bare absolute /mavlink getJSON paths must be gone'
  );
});

test('identity default is declared (vehicle comes from the shared helper)', () => {
  assert.match(
    html,
    /identity:\s*\{\s*value:\s*''\s*\}/,
    'identity default must exist'
  );
  // The vehicle (mavlink-vehicle) descriptor is contributed by
  // buildTierDialectDefaults() — see the delegation test above.
});

test('command Build dialect + vehicle defaults come from the shared Build-tier helper', () => {
  // dialect/vehicle default descriptors + validators are the shared §6 rule,
  // merged via buildTierDialectDefaults (delivery mode, no firmware). Validator
  // behaviour is proven in mavlink-editor-resource.test.js.
  assert.match(
    html,
    /Object\.assign\([\s\S]*RED\.mavlink\.buildTierDialectDefaults\(\)\s*\)/,
    'Command defaults must merge buildTierDialectDefaults()'
  );
  assert.doesNotMatch(html, /if \(tier === ['"]build['"]\) return !!v/, 'no pasted dialect validator');
});

test('command Build dialect select uses shared helper and includes __vehicle escape option', () => {
  // Option value/label (`__vehicle` / "from Vehicle Profile…") are injected by
  // populateDialectSelect — proven in mavlink-editor-resource.test.js. Command
  // pins the call site, not a pasted copy of the option.
  assert.match(html, /RED\.mavlink\.populateDialectSelect\(/, 'dialect select must use shared helper');
  assert.match(html, /row-cmd-dialect/, 'template must have a dialect row');
  assert.match(html, /id="node-input-dialect"/, 'template must have the dialect select');
});

test('command Build visibility delegates shared rows to applyBuildTierRowVisibility', () => {
  const vis = html.slice(
    html.indexOf('function refreshVisibility'),
    html.indexOf("$('#node-input-identity').on")
  );

  assert.match(vis, /RED\.mavlink\.applyBuildTierRowVisibility\(\{/, 'shared visibility helper called');
  assert.match(vis, /#node-input-dialect/, 'Build visibility reads the dialect select');
  assert.match(vis, /dialectRow:\s*'#row-cmd-dialect'/, 'dialect row selector passed');
  assert.match(vis, /vehicleRow:\s*'#row-cmd-vehicle'/, 'vehicle row selector passed');
  assert.match(vis, /connectionRow:\s*'#row-cmd-connection'/, 'connection row selector passed');
  assert.doesNotMatch(
    vis,
    /#row-cmd-dialect['"]\)\s*\[/,
    'no hand-rolled dialect show/hide'
  );
});

test('command catalog targeting delegates to the shared loader (no local copy)', () => {
  // resolve → cache → getJSON → race guard lives in RED.mavlink.loadCatalog
  // (proven in mavlink-editor-resource.test.js). Command must call it, not paste.
  assert.match(
    html,
    /RED\.mavlink\.loadCatalog\(\s*['"]\/mavlink\/command\/commands['"]/,
    'commands catalog uses shared loadCatalog'
  );
  assert.match(
    html,
    /RED\.mavlink\.loadCatalog\(\s*['"]\/mavlink\/build\/messages['"]/,
    'messages catalog uses shared loadCatalog'
  );
  assert.doesNotMatch(html, /function resolveCatalogTarget/, 'no local catalog resolver copy');
  assert.doesNotMatch(html, /\$\.getJSON\(\s*RED\.mavlink\.adminApiUrl\(\s*['"]\/mavlink\/(build\/messages|command\/commands)/,
    'no hand-rolled dialect-catalog getJSON');
  assert.doesNotMatch(html, /ardupilotmega/, 'catalog target resolution must not hardcode ardupilotmega');
});

test('refreshIdentitySelect is called to populate the identity select', () => {
  assert.match(
    html,
    /RED\.mavlink\.refreshIdentitySelect\(node\)/,
    'shared refreshIdentitySelect must be called'
  );
  assert.match(
    html,
    /\$\('#node-input-identity'\)/,
    'identity select must be referenced as #node-input-identity'
  );
  assert.doesNotMatch(html, /function refreshIdentitySelect/, 'no local identity-refresh copy');
});

test('refreshVisibility handles delivery and identity change events', () => {
  assert.match(html, /function refreshVisibility/, 'refreshVisibility function must exist');
  assert.match(
    html,
    /\$\('#node-input-delivery'\)\.on\('change'[\s\S]*refreshVisibility|refreshVisibility[\s\S]*\$\('#node-input-delivery'\)\.on\('change'/,
    'delivery change must trigger refreshVisibility'
  );
  assert.match(
    html,
    /\$\('#node-input-identity'\)\.on\('change',\s*refreshVisibility\)/,
    'identity change must trigger refreshVisibility'
  );
});

test('build tier hides connection row; wire tiers show it', () => {
  const vis = html.slice(
    html.indexOf('function refreshVisibility'),
    html.indexOf('$\'#node-input-identity\'.on') !== -1
      ? html.indexOf('$\'#node-input-identity\'.on')
      : html.indexOf("$('#node-input-identity').on")
  );
  assert.match(
    html,
    /row-cmd-vehicle/,
    'row-cmd-vehicle id must exist in template'
  );
  assert.match(
    html,
    /row-cmd-connection/,
    'row-cmd-connection id must exist in template'
  );
  assert.match(
    vis,
    /connectionRow:\s*'#row-cmd-connection'/,
    'connection row is handed to the shared visibility helper'
  );
  assert.match(
    vis,
    /vehicleRow:\s*'#row-cmd-vehicle'/,
    'vehicle row is handed to the shared visibility helper'
  );
  // Command-owned wire rows (identity/timeout/…) stay local and still hide on Build.
  assert.match(
    vis,
    /#row-cmd-identity['"]\)\s*\[\s*isBuild\s*\?\s*'hide'\s*:\s*'show'\s*\]/,
    'identity row remains a command-owned Build hide'
  );
});

test('companion identity hides target sysid/compid rows', () => {
  assert.match(
    html,
    /row-cmd-target/,
    'row-cmd-target id must exist'
  );
  assert.match(
    html,
    /RED\.mavlink\.applyCompanionTargetVisibility\(/,
    'shared companion target visibility helper is used'
  );
  assert.match(
    html,
    /combinedTargetRow:\s*['"]#row-cmd-target['"]/,
    'command passes its combined target row'
  );
});

test('command help documents status fields at message root, not under payload', () => {
  const help = html.slice(
    html.indexOf('data-help-name="mavlink-command"'),
    html.lastIndexOf('</script>')
  );
  const statusBlock = help.slice(help.indexOf('<li>Status'), help.indexOf('<h3>Delivery'));
  assert.match(statusBlock, /<dt>result\b/, 'status help lists msg.result');
  assert.match(statusBlock, /<dt>resultCode\b/);
  assert.ok(
    !/<dt>payload\b/.test(statusBlock),
    'status help must not nest fields under payload'
  );
});

test('sendAs defaults to the first valid option with no blank prompt', () => {
  assert.match(html, /id="node-input-sendAs"/, 'send-as select must bind to the sendAs property');
  assert.doesNotMatch(html, /id="node-input-carrier"/, 'retired carrier control must not be rendered');
  assert.match(
    html,
    /sendAs:\s*\{ value: 'int' \}/,
    'new command nodes default to COMMAND_INT'
  );
  assert.doesNotMatch(html, /select carrier/i, 'send-as select has no meaningless blank prompt');
  assert.match(
    html,
    /<option value="int">/,
    'COMMAND_INT option offered'
  );
  assert.match(
    html,
    /<option value="long">/,
    'COMMAND_LONG option offered'
  );
});

test('frame row binds to the frame property and follows the INT carrier', () => {
  assert.match(html, /id="node-input-frame"/, 'frame select must bind to the frame property');
  assert.match(html, /row-cmd-frame/, 'frame row id must exist');
  assert.match(
    html,
    /\$\('#node-input-sendAs'\)\.on\('change', refreshFrameRow\);/,
    'send-as change re-evaluates the frame row'
  );
});

test('frame dropdown: blank names the wire default (relative alt); frame 0 reachable (#247)', () => {
  // Blank wires the carrier module's DEFAULT_FRAME — GLOBAL_RELATIVE_ALT (3),
  // §14 — so the label must say relative alt, and AMSL (frame 0) must be its
  // own option rather than a claim the default never honoured.
  const { DEFAULT_FRAME, MAV_FRAME } = require('../../lib/command/carrier');
  assert.equal(DEFAULT_FRAME, MAV_FRAME.GLOBAL_RELATIVE_ALT, 'the blank label below pins to this default');
  assert.match(html, /<option value="">Global, relative alt \(default\)<\/option>/);
  assert.match(html, /<option value="0">Global, absolute alt \(AMSL\)<\/option>/);
  assert.ok(
    !html.includes('Global, absolute alt (default)'),
    'the old label promised AMSL while blank wired 3'
  );
});

test('preset positional params are labelled degrees, not degE7 (§9 canonical units)', () => {
  assert.ok(
    !/units: 'degE7'/.test(html),
    'no preset param may advertise degE7 — operator input is always degrees'
  );
});

test('command param enum pulldowns carry no blank option', () => {
  // An unset param resolves to 0, and where 0 means something the dialect
  // enumerates it — so blank was a second spelling of an entry that exists, or
  // (ACCELCAL_VEHICLE_POS) a value the enum never defined. See
  // test/metadata/enum-param-blank.test.js for the numbers.
  const renderer = html.slice(
    html.indexOf('function advancedParamInput'),
    html.indexOf('function presetParamInput')
  );
  assert.ok(!/\\u2014/.test(renderer), 'no em-dash placeholder option');
  assert.ok(
    !/sel\.append\(\$\('<option><\/option>'\)\.val\(''\)/.test(renderer),
    'no empty-valued option'
  );
  assert.match(renderer, /isBitmask\) \{\s*sel\.attr\('multiple'/, 'bitmask branch keeps its multi-select');
});

test('mavlink-command: Advanced mode requires a command (§6 status ruling, 2026-08-12)', () => {
  // Advanced mode's command is the whole message; blank resolves to null and
  // would build MAV_CMD(null). The runtime's deploy badge for that is gone, so
  // the editor owns it — and only in Advanced, since preset mode never reads
  // the field.
  const { advancedCommand } = loadNodeDefaults('mavlink-command');
  assert.match(
    String(advancedCommand.validate.call({ mode: 'advanced' }, '', {})),
    /required in Advanced mode/
  );
  assert.equal(advancedCommand.validate.call({ mode: 'advanced' }, '31', {}), true);
  assert.equal(
    advancedCommand.validate.call({ mode: 'preset' }, '', {}),
    true,
    'preset mode never reads it, so a blank must not red'
  );
  assert.equal(advancedCommand.validate.length, 2, 'a reason-returning validator declares (v, opt) — §14');
});

test('mavlink-command: preset coordinates are checked here, and nowhere else', () => {
  // The runtime's blankLocationRefusal is gone (AGENTS.md, input trust), and
  // before this validator the params blob had no check at all — so this is the
  // whole of what stops a Set Home telling the vehicle its home is 0,0, or an
  // Orbit centred on null island.
  const { params } = loadNodeDefaults('mavlink-command');
  const cfg = (over) => Object.assign({ id: 'c1', mode: 'preset' }, over);
  const verdict = (over, blob) => params.validate.call(cfg(over), JSON.stringify(blob), {});

  assert.equal(params.validate.length, 2, 'a reason-returning validator declares (v, opt) — §14');

  // Presence, on Set Home — the only listed preset that requires a location.
  assert.match(String(verdict({ preset: 'set_home' }, {})), /needs a latitude and longitude/, 'blank');
  assert.match(String(verdict({ preset: 'set_home' }, { 5: 47.4 })), /needs a latitude and longitude/, 'half');
  assert.equal(verdict({ preset: 'set_home' }, { 5: 47.4, 6: 8.5 }), true, 'complete');

  // Orbit is NOT one of them, and this is the case that proves the rule is
  // read from the command rather than assumed: DO_ORBIT documents param5/6
  // NaN as "use current vehicle position", so a blank centre means "orbit
  // where I am" and must not red. examples/10-sunday-stroll.json ships
  // exactly that, and could not fly while orbit carried requireLocation.
  // The carrier is the one thing a blank orbit centre still depends on — NaN
  // needs COMMAND_LONG, checked by its own test below.
  assert.equal(verdict({ preset: 'orbit', sendAs: 'long' }, {}), true, 'a blank orbit centre is "here"');
  assert.equal(verdict({ preset: 'orbit' }, { 5: 47.4, 6: 8.5 }), true, 'a placed orbit is fine too');
  // Set Home's param1 = 1 is "use current position" — the vehicle ignores the
  // coordinates, so blank is correct rather than dangerous.
  assert.equal(verdict({ preset: 'set_home' }, { 1: 1 }), true);
  assert.match(String(verdict({ preset: 'set_home' }, { 1: 0 })), /needs a latitude and longitude/,
    'a blank flag is 0, which is still "no"');

  // Range is keyed on the coordinate being *present*, not on the preset
  // requiring one: takeoff and land expose lat/lon where blank means "here",
  // and 200° there is still garbage that scales into a real place (#263).
  for (const preset of ['takeoff', 'land']) {
    assert.equal(verdict({ preset }, {}), true, `${preset} blank means "here"`);
    assert.match(String(verdict({ preset }, { 5: 200, 6: 8 })), /within ±90°/, `${preset} lat`);
    assert.match(String(verdict({ preset }, { 5: 47, 6: 181 })), /within ±180°/, `${preset} lon`);
  }

  // Local frames carry metres, so the degree bounds must not fire — but only
  // COMMAND_INT has a frame at all, and an unknown one stays on the degree
  // path so a missing frame cannot buy a bypass.
  const far = { 5: 123.4, 6: 456.7 };
  assert.equal(verdict({ preset: 'set_home', sendAs: 'int', frame: '1' }, far), true, 'LOCAL_NED metres');
  assert.match(String(verdict({ preset: 'set_home', sendAs: 'int', frame: '0' }, far)), /within ±90°/,
    'GLOBAL is degrees');
  assert.match(String(verdict({ preset: 'set_home', sendAs: 'long', frame: '1' }, far)), /within ±90°/,
    'the LONG carrier has no frame — degrees apply whatever the stale field says');

  // A preset the dropdown does not offer is not this node's surface to police
  // — `reposition` reaches here through no path at all now that Move owns the
  // goto, so it gets no rule rather than an unreachable one.
  assert.equal(verdict({ preset: 'reposition' }, {}), true, 'an unoffered preset carries no rule');

  // Gates: Advanced never reads the preset rules, and an unreadable blob reds
  // rather than falling open.
  assert.equal(verdict({ mode: 'advanced', preset: 'orbit' }, {}), true);
  assert.equal(verdict({ preset: 'arm' }, {}), true, 'presets without coordinates are untouched');
  assert.match(String(params.validate.call(cfg({ preset: 'arm' }), '{oops', {})), /valid JSON/);
});

test('mavlink-command: the editor\'s location rules match the library\'s, exactly', () => {
  // PRESET_LOCATION is a second copy of lib/command/presets.js's
  // requireLocation, and it exists because a Node-RED validator is synchronous
  // while the preset catalog is fetched. Two copies of one rule only stay
  // honest if something compares them, so: executed, in both directions, so
  // neither a new location preset nor a deleted one can land on one side alone.
  //
  // The library side is filtered to the *offered* presets. A row the dropdown
  // does not carry cannot be configured, so a rule for it would be a rule
  // nothing can reach — `reposition` is the case, kept in PRESETS only as the
  // DO_REPOSITION metadata mavlink-formation builds from. Filtering here is
  // what makes `listed: false` mean one thing in both files.
  const { PRESETS } = require('../../lib/command');
  const offered = PRESETS.filter((p) => p.listed !== false);
  const map = /const PRESET_LOCATION = \{[\s\S]*?\n {2}\};/.exec(html);
  assert.ok(map, 'PRESET_LOCATION must be extractable');

  const fromLibrary = offered
    .filter((p) => p.requireLocation)
    .map((p) => p.id)
    .sort();
  // Line-anchored, not indentation- or nesting-counted: an entry's value is
  // the rest of its line, so `set_home`'s three nested braces read the same as
  // a one-brace entry, and a reformat cannot quietly stop matching.
  const fromEditor = [...map[0].matchAll(/^\s+(\w+):\s*\{/gm)].map((m) => m[1]).sort();
  assert.deepEqual(fromEditor, fromLibrary, 'the same presets require a location on both sides');
  assert.ok(
    PRESETS.some((p) => p.listed === false && p.requireLocation),
    'the offered-filter is load-bearing — an unoffered requireLocation row exists to exclude'
  );

  for (const preset of offered.filter((p) => p.requireLocation)) {
    const entry = new RegExp(`^\\s+${preset.id}:\\s*(.+)$`, 'm').exec(map[0]);
    assert.ok(entry, `${preset.id} entry must be extractable`);
    // `true` vs the conditional `{ unless: … }` form must agree — the
    // difference is Set Home's "use current position" escape.
    assert.equal(
      /require:\s*true/.test(entry[1]),
      preset.requireLocation === true,
      `${preset.id}: the conditional-vs-always form must agree`
    );
  }

  // The altitude rule is gone from the editor because `reposition` was the
  // only row that declared it and nothing offers that preset. This is the
  // tripwire for putting it back: an offered preset with requireAltitude
  // would need a validator branch that no longer exists, and would otherwise
  // deploy clean while sending a blank altitude as ground level.
  assert.equal(
    offered.filter((p) => p.requireAltitude).length, 0,
    'an offered preset needs an altitude — restore the altitude branch in the params validator'
  );
  assert.doesNotMatch(map[0], /altitude:/, 'and PRESET_LOCATION carries no rule the validator ignores');
});

test('mavlink-command: NAN_CENTRE_PRESETS matches the library\'s NaN param5/6 sentinels', () => {
  // Second mirrored rule, same deal as PRESET_LOCATION: the editor cannot wait
  // on the async catalog, so it carries its own copy and this compares them.
  // A preset that starts encoding a blank centre as NaN — or stops — must land
  // on both sides or fail here.
  const { PRESETS } = require('../../lib/command');
  const set = /const NAN_CENTRE_PRESETS = new Set\(\[([^\]]*)\]\);/.exec(html);
  assert.ok(set, 'NAN_CENTRE_PRESETS must be extractable');
  const fromEditor = [...set[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();

  const fromLibrary = PRESETS
    .filter((p) => {
      const blank = p.blankParams || {};
      return Number.isNaN(blank[5]) || Number.isNaN(blank[6]);
    })
    .map((p) => p.id)
    .sort();

  assert.deepEqual(fromEditor, fromLibrary, 'the same presets carry a NaN centre on both sides');
  assert.ok(fromLibrary.length, 'the rule is not vacuous — at least one preset uses the sentinel');
});

test('mavlink-command: the params validator reads the live form the way Done writes it', () => {
  // The validator and `oneditsave` share one scrape (`scrapeParamInputs`)
  // because they must agree: a validator that judged different values than
  // Done writes either reds a config the operator cannot fix, or passes one
  // that cannot be sent.
  //
  // The controls are not all text boxes. A checkbox built by
  // `booleanEnumInput` carries no value attribute, so `.val()` is the literal
  // string "on" whether ticked or not, and `Number("on")` is NaN — which read
  // Set Home's ticked "use current position" as 0 and demanded coordinates the
  // vehicle was about to ignore. A multi-select's `.val()` is an array, NaN by
  // the same route. `data-kind` is what distinguishes them (CodeRabbit, #286).
  const live = (items) => loadNodeDefaults('mavlink-command', {}, {
    dom: { '#node-input-params': { val: '{}' }, '.param-input': { items } },
    editStack: [{ id: 'c1' }],
  }).params;
  const node = { id: 'c1', mode: 'preset', preset: 'set_home', _mavParamsRendered: true };

  // Ticked "use current position": the escape the coordinates hang on.
  assert.equal(
    live([{ val: 'on', checked: true, attrs: { 'data-idx': '1', 'data-kind': 'boolean', 'data-true': '1' } }])
      .validate.call(node, '{}', {}),
    true,
    'a ticked boolean reads as its data-true, not NaN'
  );
  // Unticked reads 0 — same "on" from `.val()`, opposite answer.
  assert.match(
    String(live([{ val: 'on', checked: false, attrs: { 'data-idx': '1', 'data-kind': 'boolean', 'data-true': '1' } }])
      .validate.call(node, '{}', {})),
    /needs a latitude and longitude/,
    'an unticked boolean is 0, which is still "no"'
  );
  // A number field still reads as a number, and the live form beats the blob.
  assert.equal(
    live([
      { val: '47.4', attrs: { 'data-idx': '5' } },
      { val: '8.5', attrs: { 'data-idx': '6' } },
    ]).validate.call(node, '{}', {}),
    true,
    'live coordinates pass even though the saved blob is empty'
  );
});

test('mavlink-command: a form that rendered nothing falls back to the saved params', () => {
  // `_mavParamsRendered` is the same authority `oneditsave` scrapes behind,
  // and for the same reason: a dialog can be open over a form that rendered no
  // controls — the catalog is still loading, or the preset fetch failed and
  // the select has no options at all. Scraping zero fields there reads as
  // "every param is blank" and reds a node whose saved params are perfectly
  // intact (Codex, #286).
  const saved = JSON.stringify({ 5: 47.4, 6: 8.5 });
  const open = (over, items = []) => loadNodeDefaults('mavlink-command', {}, {
    dom: { '#node-input-params': { val: saved }, '.param-input': { items } },
    editStack: [{ id: 'c1' }],
  }).params.validate.call(
    Object.assign({ id: 'c1', mode: 'preset', preset: 'set_home' }, over), saved, {}
  );

  // Set Home does declare param rows, so "no controls, flag off" is not a
  // contradiction — `refreshParamFields` clears the flag at the top and only
  // sets it inside `loadCommandsCatalog`'s callback. Everything between is a
  // "Loading command parameters…" placeholder with zero `.param-input`, which
  // is the Codex #36 window this guard exists for.
  assert.equal(open({ _mavParamsRendered: false }), true, 'nothing rendered: judge the saved blob');
  assert.equal(open({}), true, 'the flag absent entirely is the same case');
  assert.match(String(open({ _mavParamsRendered: true })), /needs a latitude and longitude/,
    'a form marked rendered but holding nothing still reds — the flag is the whole difference');
  // And the ordinary reachable shape: real controls, blank coordinates, an
  // unticked "use current position". Reds for the reason an operator can act
  // on rather than through the empty-scrape accident (CodeRabbit, #286).
  assert.match(String(open({ _mavParamsRendered: true }, [
    { val: 'on', checked: false, attrs: { 'data-idx': '1', 'data-kind': 'boolean', 'data-true': '1' } },
    { val: '', attrs: { 'data-idx': '5' } },
    { val: '', attrs: { 'data-idx': '6' } },
  ])), /needs a latitude and longitude/, 'a rendered form with blank coordinates reds');
});

test('mavlink-command: a NaN centre cannot ride COMMAND_INT', () => {
  // DO_ORBIT documents NaN in param5/6 as "orbit where I am", and int32 has no
  // NaN — `longToIntFields` refuses the pair at build. Both halves are editor
  // fields, so the operator meets it at deploy rather than on the first
  // message (Codex, #286).
  const { params } = loadNodeDefaults('mavlink-command');
  const verdict = (over, blob) => params.validate.call(
    Object.assign({ id: 'c1', mode: 'preset', preset: 'orbit' }, over), JSON.stringify(blob), {}
  );

  assert.match(String(verdict({}, {})), /COMMAND_INT cannot carry/,
    'int is the default carrier, so a blank centre reds out of the box');
  assert.match(String(verdict({ sendAs: 'int' }, { 5: 47.4 })), /COMMAND_INT cannot carry/, 'half a centre too');
  assert.equal(verdict({ sendAs: 'long' }, {}), true, 'the LONG carrier can express NaN');
  assert.equal(verdict({ sendAs: 'int' }, { 5: 47.4, 6: 8.5 }), true, 'a placed centre is finite');
  // The rule is keyed on the preset, not on blankness in general: takeoff
  // leaves param5/6 out of blankParams, so its blank coordinates are 0-fills,
  // not sentinels, and int carries them.
  assert.equal(verdict({ preset: 'takeoff', sendAs: 'int' }, {}), true);
});

test('mavlink-command: PRESET_PARAMS covers exactly the presets the dropdown offers', () => {
  // Third mirrored rule, and the one that had already drifted: it carried
  // curation rows for `yaw` and `rotate`, presets deleted from the library
  // entirely when Move took the motion intents. Dead rows are cheap to ignore
  // until something reads the table as authoritative — which the `preset`
  // validator below now does, so the equality has to be executed.
  const { PRESETS } = require('../../lib/command');
  const table = /const PRESET_PARAMS = \{[\s\S]*?\n {2}\};/.exec(html);
  assert.ok(table, 'PRESET_PARAMS must be extractable');

  const fromEditor = [...table[0].matchAll(/^\s{4}(\w+):/gm)].map((m) => m[1]).sort();
  const offered = PRESETS.filter((p) => p.listed !== false).map((p) => p.id).sort();
  assert.deepEqual(fromEditor, offered, 'every offered preset has a row, and no row outlives its preset');
});

test('mavlink-command: an unknown preset reds instead of sending MAV_CMD(null)', () => {
  // The dropdown cannot produce one; a hand-edited flow can. The runtime
  // trusts what it is handed and sends `command: null`, reporting success —
  // so this is the only layer that can tell a typo from a command.
  const { preset } = loadNodeDefaults('mavlink-command');
  const verdict = (over) => preset.validate.call(
    Object.assign({ id: 'c1', mode: 'preset' }, over), over.preset, {}
  );

  assert.equal(preset.validate.length, 2, 'a reason-returning validator declares (v, opt) — §14');
  assert.match(String(verdict({ preset: 'bogus' })), /not a preset this palette offers/);
  assert.equal(verdict({ preset: 'arm' }), true, 'a real preset passes');
  assert.equal(verdict({ preset: 'set_home' }), true);
  // Deleted presets are unknown like any other typo — Move owns motion now.
  for (const dead of ['yaw', 'rotate', 'reposition']) {
    assert.match(String(verdict({ preset: dead })), /not a preset this palette offers/,
      `${dead} is not a Command preset any more`);
  }
  // Advanced mode never reads the field, so it must not red there.
  assert.equal(verdict({ mode: 'advanced', preset: 'bogus' }), true);
});
