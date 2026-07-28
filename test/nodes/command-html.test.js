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
  assert.match(html, /RED\.mavlink\.adminApiUrl\(['"]\/mavlink\/command\/commands['"]\)/, 'dialect MAV_CMD list is loaded from admin API');
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
  assert.match(html, /_catalogRequestSeq/, 'request sequence token exists');
  assert.match(html, /seq !== _catalogRequestSeq/, 'stale responses are dropped');
  assert.match(html, /const current = sel\.val\(\)/, 'in-progress select value is read');
  assert.match(html, /const prefer = current \|\| saved/, 'current selection wins over saved');
  assert.match(
    html,
    /query:\s*\{\s*vehicle:\s*vehicleId,\s*dialect:\s*dialect\s*\}/,
    'Vehicle id is preferred; dialect accompanies it for undeployed bundled profiles'
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
  assert.match(renderer, /data-kind['"],\s*isBitmask \? ['"]bitmask['"] : ['"]enum['"]/, 'bitmask controls are tagged');
  assert.match(renderer, /\.attr\(['"]multiple['"],\s*['"]multiple['"]\)/, 'bitmask enum params use native multi-select');
  assert.match(html, /Ctrl\/Cmd-click/, 'multi-select title/help explains how to select multiple flags');
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

test('preset params declare enum-backed and message-backed selects', () => {
  const table = html.slice(
    html.indexOf('const PRESET_PARAMS = {'),
    html.indexOf('const HAS_COMPLETION')
  );

  assert.match(table, /set_mode:[\s\S]*enumName:\s*'MAV_MODE'/, 'set_mode base_mode uses MAV_MODE');
  assert.match(table, /change_speed:[\s\S]*enumName:\s*'SPEED_TYPE'/, 'change_speed param1 uses SPEED_TYPE');
  assert.match(table, /orbit:[\s\S]*enumName:\s*'ORBIT_YAW_BEHAVIOUR'/, 'orbit yaw behavior uses enum when present');
  assert.match(table, /reposition:[\s\S]*enumName:\s*'MAV_DO_REPOSITION_FLAGS'[\s\S]*bitmask:\s*true/, 'reposition flags use bitmask enum');
  assert.match(table, /request_message:[\s\S]*messages:\s*true/, 'request_message message id uses message catalog');
  assert.match(table, /set_message_interval:[\s\S]*messages:\s*true/, 'set_message_interval message id uses message catalog');
  assert.match(table, /stop_message_interval:[\s\S]*messages:\s*true/, 'stop_message_interval message id uses message catalog');
  assert.match(table, /reboot_autopilot:[\s\S]*enumName:\s*'REBOOT_SHUTDOWN_ACTION'/, 'reboot actions use reboot enum');
});

test('preset renderer loads enum and message catalogs for selects', () => {
  const presetBlock = html.slice(
    html.indexOf("const presetId = $('#node-input-preset')"),
    html.indexOf('// ── Safety preset notice')
  );

  assert.match(html, /RED\.mavlink\.loadEnumsCatalog/, 'preset enums use shared enum helper');
  assert.match(html, /RED\.mavlink\.adminApiUrl\(['"]\/mavlink\/build\/messages['"]\)/, 'message ids load from the shared messages API');
  assert.match(html, /function presetParamInput/, 'preset branch has a shared input renderer');
  assert.match(presetBlock, /presetParamInput\(spec\)/, 'preset branch calls the shared input renderer');
  assert.match(html, /spec\.messages/, 'message-backed preset params become selects');
  assert.match(html, /spec\.enumName/, 'enum-backed preset params become selects');
  assert.match(html, /data-kind['"],\s*isBitmask \? ['"]bitmask['"] : ['"]enum['"]/, 'preset bitmask controls are tagged');
});

test('Command CompID reloads when Connection changes', () => {
  assert.match(html, /function reloadTargetCompId/, 'CompID load is a reusable helper');
  assert.match(
    html,
    /\$\('#node-input-connection'\)\.on\('change'[\s\S]*reloadTargetCompId\(\)/,
    'Connection change refreshes MAV_COMPONENT for the new dialect'
  );
});

test('admin catalog fetches use adminApiUrl (httpAdminRoot-safe)', () => {
  assert.match(html, /RED\.mavlink\.adminApiUrl\(/, 'admin fetches must use adminApiUrl');
  assert.ok(
    !/\$\.getJSON\(\s*['"]\/mavlink\//.test(html),
    'bare absolute /mavlink getJSON paths must be gone'
  );
});
