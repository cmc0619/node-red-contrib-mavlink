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

test('Build dialect + vehicle defaults come from the shared Build-tier helper', () => {
  // dialect/vehicle default descriptors + validators are the shared §6 rule,
  // merged in via buildTierDialectDefaults; the Build node keys it off `tier`.
  // The descriptor shape and validators are proven in
  // mavlink-editor-resource.test.js — here we only assert the delegation.
  assert.match(
    html,
    /Object\.assign\([\s\S]*RED\.mavlink\.buildTierDialectDefaults\(\{\s*modeField:\s*'tier'\s*\}\)\s*\)/,
    'Build defaults must merge buildTierDialectDefaults({ modeField: tier })'
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
  assert.match(fieldRenderer, /RED\.mavlink\.isFalseTrueEnum\(entries\)/, 'FALSE/TRUE enums are detected before bitmask rendering');
  assert.match(fieldRenderer, /falseTrue \? ['"]enum['"] : \(multi \? ['"]bitmask['"] : ['"]enum['"]\)/, 'FALSE/TRUE bitmasks are tagged as enum selects');
  assert.match(fieldRenderer, /\.attr\(['"]multiple['"],\s*['"]multiple['"]\)/, 'message field bitmasks use native multi-select');
  assert.match(fieldRenderer, /\.val\(entry\.name\)/, 'message field bitmasks save enum entry names');
  assert.match(fieldRenderer, /\.val\(String\(entry\.value\)\)/, 'FALSE/TRUE options save numeric 0/1 values');
  assert.match(collector, /fields\[name\]\s*=\s*Array\.isArray\(raw\) \? raw/, 'collector keeps selected token array');
  assert.match(collector, /kind === ['"]enum['"]/, 'FALSE/TRUE enum select is collected through numeric enum save');
});

test('Build COMMAND_LONG/INT command params render bitmasks as numeric multi-select masks', () => {
  const renderer = html.slice(
    html.indexOf('function commandParamInput'),
    html.indexOf('function refreshCommandParams')
  );

  assert.match(renderer, /spec\.bitmask/, 'command param bitmask flag drives rendering');
  assert.match(renderer, /RED\.mavlink\.isFalseTrueEnum\(entries\)/, 'FALSE/TRUE command params are detected before bitmask rendering');
  assert.match(renderer, /data-kind['"],\s*falseTrue \? ['"]enum['"] : \(isBitmask \? ['"]bitmask-mask['"] : ['"]enum['"]\)/, 'FALSE/TRUE command bitmask params are tagged as enum selects');
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

test('Build connection stays required on wire tiers only (local validator)', () => {
  // Connection is the inverse of the shared dialect rule — required on wire
  // tiers, hidden on Build — so it keeps its own validator in the node.
  assert.match(html, /if \(tier !== ['"]build['"]\) return !!v/, 'Connection is required on wire tiers');
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

test('Build catalog targeting delegates to the shared resolver (no local copy)', () => {
  // The catalog source matrix — including the wire branch that carries the
  // connection profile id for custom XML dialects — lives in the shared
  // resource helper (proven in mavlink-editor-resource.test.js). The Build node
  // must call it, keyed off its `tier` field, not paste its own copy.
  assert.match(
    html,
    /RED\.mavlink\.resolveCatalogTarget\(\{\s*isBuild:\s*buildTierIsBuild\(\)\s*\}\)/,
    'Build node calls the shared resolver with its tier-derived isBuild flag'
  );
  assert.match(
    html,
    /\$\('#node-input-tier'\)\.val\(\)[^=]*===\s*'build'/,
    'isBuild is derived from the Build node tier field'
  );
  assert.doesNotMatch(html, /function resolveCatalogTarget/, 'no local catalog resolver copy');
  assert.doesNotMatch(html, /function emptyCatalogTarget/, 'no local empty-target helper copy');
  assert.doesNotMatch(html, /ardupilotmega/, 'catalog target resolution must not hardcode ardupilotmega');
  assert.match(html, /if \(!target\.query\)/, 'empty catalog target must not fetch an invented dialect');
  // "Not configured yet" is the required-field validation's job (red field +
  // node marker) — no bespoke pending mechanism in the dialog.
  assert.doesNotMatch(html, /pending/, 'no hand-rolled pending state');
});
