'use strict';

/**
 * Build editor: Message is a dialect dropdown; fields reshape by selection (§6).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(
  path.join(__dirname, '..', '..', 'nodes', 'mavlink-build.html'),
  'utf8'
);

test('Build vehicle default declares type mavlink-vehicle', () => {
  assert.match(
    html,
    /vehicle:\s*\{\s*value:\s*''\s*,\s*type:\s*'mavlink-vehicle'/,
    'defaults.vehicle.type must be mavlink-vehicle'
  );
});

test('Build connection default declares type mavlink-connection', () => {
  assert.match(
    html,
    /connection:\s*\{\s*value:\s*''\s*,\s*type:\s*'mavlink-connection'/,
    'defaults.connection.type must be mavlink-connection'
  );
});

test('Build messageName defaults to HEARTBEAT and is a <select>', () => {
  assert.match(html, /messageName:\s*\{\s*value:\s*'HEARTBEAT'/);
  assert.match(html, /<select id="node-input-messageName"/);
  assert.ok(
    !html.includes('placeholder="e.g. HEARTBEAT"'),
    'free-form message placeholder must be gone'
  );
});

test('Build reshapes fields from message metadata and handles COMMAND_LONG/INT', () => {
  assert.match(html, /RED\.mavlink\.adminApiUrl\(['"]\/mavlink\/build\/messages['"]\)/);
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

test('Build oneditprepare ensures standard config-node pickers', () => {
  assert.match(html, /ensureConfigNodePicker\(node,\s*'vehicle'/);
  assert.match(html, /ensureConfigNodePicker\(node,\s*'connection'/);
});

test('Build message-field bitmasks use multi-select tokens accepted by the codec', () => {
  const collector = html.slice(
    html.indexOf('function collectFieldInputsFromDom'),
    html.indexOf('RED.nodes.registerType')
  );
  const fieldRenderer = html.slice(
    html.indexOf('function fieldInput'),
    html.indexOf('function syncSavedFieldsFromDom')
  );

  assert.match(fieldRenderer, /spec\.display === ['"]bitmask['"]/, 'message field bitmasks follow field metadata');
  assert.match(fieldRenderer, /\.attr\(['"]multiple['"],\s*['"]multiple['"]\)/, 'message field bitmasks use native multi-select');
  assert.match(fieldRenderer, /\.val\(entry\.name\)/, 'message field bitmasks save enum entry names');
  assert.match(collector, /fields\[name\]\s*=\s*Array\.isArray\(raw\) \? raw/, 'collector keeps selected token array');
});

test('Build COMMAND_LONG/INT command params render bitmasks as numeric multi-select masks', () => {
  const renderer = html.slice(
    html.indexOf('function commandParamInput'),
    html.indexOf('function refreshCommandParams')
  );

  assert.match(renderer, /spec\.bitmask/, 'command param bitmask flag drives rendering');
  assert.match(renderer, /data-kind['"],\s*isBitmask \? ['"]bitmask-mask['"] : ['"]enum['"]/, 'command bitmask params are tagged for numeric mask save');
  assert.match(renderer, /\.attr\(['"]multiple['"],\s*['"]multiple['"]\)/, 'command bitmask params use native multi-select');
  assert.match(renderer, /\.val\(String\(entry\.value\)\)/, 'command bitmask options carry numeric values');
  assert.match(html, /kind === ['"]bitmask-mask['"]/, 'collector stores one numeric mask for command params');
});

test('admin catalog fetches use adminApiUrl (httpAdminRoot-safe)', () => {
  assert.match(html, /RED\.mavlink\.adminApiUrl\(/, 'admin fetches must use adminApiUrl');
  assert.ok(
    !/\$\.getJSON\(\s*['"]\/mavlink\//.test(html),
    'bare absolute /mavlink getJSON paths must be gone'
  );
});

test('Build dialect default is ardupilotmega', () => {
  assert.match(
    html,
    /dialect:\s*\{\s*value:\s*'ardupilotmega'/,
    'defaults.dialect.value must be ardupilotmega'
  );
});

test('Build dialect select includes __vehicle escape option', () => {
  assert.match(html, /__vehicle/, 'dialect select must have __vehicle option value');
  assert.match(html, /from Vehicle Profile/, 'dialect select must label the escape option');
});

test('Build vehicle default no longer has required: true', () => {
  assert.ok(
    !html.includes('required: true'),
    'vehicle must not carry required: true once the dialect picker is added'
  );
});

test('Build visibility logic references the dialect and vehicle rows', () => {
  assert.match(html, /mav-dialect-row/, 'template must have a mav-dialect-row element');
  assert.match(html, /mav-vehicle-row/, 'template must have a mav-vehicle-row element');
  assert.match(html, /updateVisibility/, 'oneditprepare must call updateVisibility');
  assert.match(html, /node-input-dialect/, 'visibility logic must reference the dialect select');
});

test('Build wire-tier catalog query carries the connection profile id (custom dialect support)', () => {
  // The admin route serves custom XML bundles only when given ?vehicle=<id>;
  // a bare ?dialect=<custom-name> 400s. The wire branch must therefore pass
  // the connection profile id, not just the dialect name.
  assert.match(
    html,
    /query:\s*\{\s*vehicle:\s*connNode\.vehicle/,
    'wire branch must include the connection profile id in the catalog query'
  );
  // "Not configured yet" is the required-field validation's job (red field +
  // node marker) — no bespoke pending mechanism in the dialog.
  assert.doesNotMatch(html, /pending/, 'no hand-rolled pending state');
});
