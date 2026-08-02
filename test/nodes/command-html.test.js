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
const { assertChangeHandlerContains } = require('./html-assert');

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
  assert.match(html, /_cmdCatalog\s*=\s*\{\s*value:\s*null,\s*seq:\s*0\s*\}/,
    'commands render state has a current value and request sequence');
  assert.match(html, /const prefer = sel\.val\(\)/, 'in-progress select value is read');
  assert.match(html, /saved:\s*prefer/, 'current-or-saved prefer is passed to fillEnumSelect');
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

test('advanced bitmask command params save one numeric mask value', () => {
  const saver = html.slice(
    html.indexOf('oneditsave: function'),
    html.indexOf('oneditcancel: function')
  );

  assert.match(saver, /data-kind['"]\)\s*===\s*['"]bitmask['"]/, 'save path detects bitmask controls');
  assert.match(saver, /Array\.isArray\(raw\)/, 'save path handles multi-select value arrays');
  assert.match(saver, /mask\s*=\s*mask\s*\|/, 'selected entries are ORed into one mask');
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
  assert.match(table, /label:\s*'Force \(0 or 21196\)'/, 'operator-guidance labels are curation');
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
  assert.match(presetBlock, /presetParamInput\(merged, catalog\.enums \|\| \{\}\)/, 'rows render with catalog enums');
  assert.match(renderer, /return advancedParamInput\(spec, enums \|\| \{\}\);/, 'one input builder for preset and Advanced');
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
  assert.match(html, /includeVehicleEscape:\s*true/, 'dialect select must request Vehicle Profile escape');
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

test('carrier defaults to the first valid option with no blank prompt', () => {
  assert.match(html, /id="node-input-carrier"/, 'carrier select must bind to the carrier property');
  assert.match(
    html,
    /carrier:\s*\{ value: 'int' \}/,
    'new command nodes default to COMMAND_INT'
  );
  assert.doesNotMatch(html, /select carrier/, 'carrier select has no meaningless blank prompt');
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
    /\$\('#node-input-carrier'\)\.on\('change', refreshFrameRow\);/,
    'carrier change re-evaluates the frame row'
  );
});

test('preset positional params are labelled degrees, not degE7 (§9 canonical units)', () => {
  assert.ok(
    !/units: 'degE7'/.test(html),
    'no preset param may advertise degE7 — operator input is always degrees'
  );
});
