'use strict';

/**
 * Swarm editor: vehicleType is a MAV_TYPE enum <select> (DESIGN.md §6).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(
  path.join(__dirname, '..', '..', 'nodes', 'mavlink-swarm.html'),
  'utf8'
);

test('vehicleType is a MAV_TYPE select, not a free-form number (§6)', () => {
  assert.match(
    html,
    /<select id="node-input-vehicleType">/,
    'Type filter must be a select dropdown'
  );
  assert.ok(
    !html.includes('type="number" id="node-input-vehicleType"'),
    'the free-form numeric type filter must be gone'
  );
});

test('vehicleType loads MAV_TYPE entries from the build/messages catalog', () => {
  assert.match(
    html,
    /RED\.mavlink\.loadCatalog\(\s*['"]\/mavlink\/build\/messages['"]/,
    'dialect enum catalog uses shared loadCatalog'
  );
  assert.match(html, /enums\.MAV_TYPE/, 'MAV_TYPE table is read from the catalog');
  assert.match(html, /function buildVehicleTypeDropdown/, 'dropdown is rebuilt from catalog entries');
  assert.match(html, /RED\.mavlink\.fillEnumSelect\(/, 'options are built via shared fillEnumSelect');
  assert.match(html, /Any type/, 'empty selection means any vehicle type');
});

test('vehicleType preserves the saved numeric value after async catalog load', () => {
  assert.match(html, /node\.vehicleType/, 'saved vehicleType is re-applied');
  assert.match(html, /var prefer = sel\.val\(\)/, 'in-progress selection wins over saved');
  assert.match(html, /saved:\s*prefer/, 'prefer is passed to fillEnumSelect');
  assert.match(html, /RED\.mavlink\.fillEnumSelect\(/, 'unknown saved values use shared fillEnumSelect sentinel');
  assert.match(
    html,
    /RED\.mavlink\.loadCatalog\(\s*['"]\/mavlink\/build\/messages['"]/,
    'stale catalog responses are guarded inside shared loadCatalog'
  );
});

test('firmware filter is already a small select (ArduPilot/PX4/custom)', () => {
  assert.match(html, /<select id="node-input-firmwareFilter">/);
  assert.match(html, /<option value="ardupilot">ArduPilot<\/option>/);
  assert.match(html, /<option value="px4">PX4<\/option>/);
  assert.match(html, /<option value="custom">Custom<\/option>/);
});

test('commandId is a MAV_CMD <select>, not a free-form number (§6)', () => {
  assert.match(
    html,
    /<select id="node-input-commandId"/,
    'Command id must be a select dropdown'
  );
  assert.ok(
    !html.includes('type="number" id="node-input-commandId"'),
    'the free-form numeric command field must be gone'
  );
});

test('commandId loads MAV_CMD entries from command/commands catalog', () => {
  assert.match(
    html,
    /RED\.mavlink\.loadCatalog\(\s*['"]\/mavlink\/command\/commands['"]/,
    'dialect MAV_CMD catalog uses shared loadCatalog'
  );
  assert.match(html, /function buildCommandDropdown/, 'dropdown is rebuilt from catalog entries');
  assert.match(html, /RED\.mavlink\.fillEnumSelect\(\s*sel,\s*catalog\.commands/, 'options are built via shared fillEnumSelect');
});

test('build+list catalog path has an explicit Dialect picker with Vehicle Profile escape', () => {
  assert.match(html, /dialect:\s*\{\s*value:\s*''/, 'dialect defaults empty until the user chooses one');
  assert.match(html, /vehicle:\s*\{[\s\S]*type:\s*['"]mavlink-vehicle['"]/, 'Vehicle Profile escape is a vehicle config-node reference');
  assert.match(html, /id="row-swarm-dialect"/, 'template must have a dialect row');
  assert.match(html, /id="node-input-dialect"/, 'template must have the dialect select');
  assert.match(html, /id="row-swarm-vehicle"/, 'template must have a Vehicle Profile row');
  assert.match(html, /id="node-input-vehicle"/, 'template must have the Vehicle Profile picker');
  assert.match(html, /RED\.mavlink\.populateDialectSelect\(/, 'shared dialect selector helper is used');
  assert.match(html, /includeVehicleEscape:\s*true/, 'Dialect picker includes the from Vehicle Profile escape');
  assert.match(html, /__vehicle/, 'Vehicle Profile escape value is recognized');
});

test('swarm catalog target delegates to the shared loader with its Build+list isBuild flag', () => {
  // Swarm's Build path is the narrow Build+list case; every other combination
  // reads the connection profile. It passes that as the isBuild override to
  // loadCatalog — matrix behaviour proven in mavlink-editor-resource.test.js.
  assert.match(html, /function swarmIsBuildList/, 'Build+list helper must exist');
  assert.match(
    html,
    /delivery === ['"]build['"] && selectionMode === ['"]list['"]/,
    'Build+list determines when the dialect picker governs the catalog'
  );
  assert.match(
    html,
    /RED\.mavlink\.loadCatalog\(\s*['"]\/mavlink\/build\/messages['"][\s\S]*isBuild:\s*swarmIsBuildList\(\)/,
    'messages catalog gets the Build+list isBuild override'
  );
  assert.match(
    html,
    /RED\.mavlink\.loadCatalog\(\s*['"]\/mavlink\/command\/commands['"][\s\S]*isBuild:\s*swarmIsBuildList\(\)/,
    'commands catalog gets the Build+list isBuild override'
  );
  assert.doesNotMatch(html, /function resolveCatalogTarget/, 'no local catalog resolver copy');
  assert.doesNotMatch(html, /\$\.getJSON\(\s*RED\.mavlink\.adminApiUrl/, 'no hand-rolled catalog getJSON');
  assert.doesNotMatch(html, /ardupilotmega/, 'swarm catalog target resolution must not hardcode ardupilotmega');
});

test('swarm Build visibility delegates shared rows with the Build+list isBuild flag', () => {
  // Same isBuildList override resolveCatalogTarget already takes — the matrix
  // behaviour is proven once in mavlink-editor-resource.test.js.
  const visStart = html.indexOf('function refreshVisibility');
  const visEnd = html.indexOf('function refreshCatalogsAndVisibility');
  assert.notEqual(visStart, -1, 'refreshVisibility must exist');
  assert.notEqual(visEnd, -1, 'refreshCatalogsAndVisibility must follow');
  const vis = html.slice(visStart, visEnd);
  assert.match(vis, /isBuildList\s*=\s*d === ['"]build['"] && sel === ['"]list['"]/,
    'Build+list determines when dialect/vehicle/connection swap');
  assert.match(vis, /RED\.mavlink\.applyBuildTierRowVisibility\(\{/,
    'shared visibility helper is called');
  assert.match(vis, /isBuild:\s*isBuildList/,
    'Build+list is passed as the isBuild override');
  assert.match(vis, /dialectRow:\s*'#row-swarm-dialect'/, 'dialect row selector passed');
  assert.match(vis, /vehicleRow:\s*'#row-swarm-vehicle'/, 'vehicle row selector passed');
  assert.match(vis, /connectionRow:\s*'#row-swarm-connection'/, 'connection row selector passed');
  assert.doesNotMatch(vis, /\$\('#row-swarm-dialect'\)\.toggle/,
    'no hand-rolled dialect row toggle');
});

test('commandId preserves the saved numeric value after async catalog load', () => {
  assert.match(html, /node\.commandId/, 'saved commandId is re-applied');
  assert.match(html, /RED\.mavlink\.fillEnumSelect\(/, 'unknown saved values use shared fillEnumSelect sentinel');
});

test('admin catalog fetches go through shared loadCatalog (httpAdminRoot-safe)', () => {
  assert.match(html, /RED\.mavlink\.loadCatalog\(/, 'catalog fetches use shared loadCatalog');
  assert.ok(
    !/\$\.getJSON\(\s*['"]\/mavlink\//.test(html),
    'bare absolute /mavlink getJSON paths must be gone'
  );
});

test('identity defaults to empty string and refreshIdentitySelect uses gcs+custom filter (§6)', () => {
  assert.match(
    html,
    /identity:\s*\{\s*value:\s*''\s*\}/,
    'identity property defaults to empty string'
  );
  assert.match(
    html,
    /RED\.mavlink\.refreshIdentitySelect\(node,\s*\{\s*rolesAllowed:\s*\[\s*['"]gcs['"]\s*,\s*['"]custom['"]\s*\]\s*\}\)/,
    'shared refreshIdentitySelect is called with gcs+custom filter'
  );
  assert.match(
    html,
    /<select id="node-input-identity"/,
    'Send-as identity field is a plain <select>'
  );
  assert.doesNotMatch(html, /function refreshIdentitySelect/, 'no local identity-refresh copy');
});

test('connection row hidden only for build+list; identity row hidden for build delivery (§6 exception)', () => {
  assert.match(
    html,
    /d === 'build' && sel === 'list'/,
    'build+list condition governs connection-row visibility'
  );
  assert.match(html, /row-swarm-connection/, 'connection row has an id for visibility toggling');
  assert.match(html, /row-swarm-identity/, 'identity row has an id for visibility toggling');
  assert.match(
    html,
    /d !== 'build'/,
    'identity row is hidden when delivery is build (source ids stamped at the wire)'
  );
});

test('identity is re-filled when connection selection changes', () => {
  assert.match(
    html,
    /RED\.mavlink\.refreshIdentitySelect\(node,\s*\{\s*rolesAllowed:/,
    'shared refreshIdentitySelect is used'
  );
  assert.match(
    html,
    /#node-input-connection.*change|change.*#node-input-connection/,
    'connection change event handler is wired'
  );
  const changeHandlerMatch = html.match(
    /#node-input-connection['"]\)\.on\(['"]change['"][^)]*\)\s*\{([\s\S]*?)\}/
  );
  assert.ok(
    changeHandlerMatch && /refreshIdentitySelect/.test(changeHandlerMatch[0]),
    'refreshIdentitySelect is called inside the connection change handler'
  );
});

test('sysids field validates each token as a MAVLink sysid (1..255)', () => {
  assert.match(
    html,
    /sysids:\s*\{[\s\S]*?validate:\s*function/,
    'sysids declares an editor validate function'
  );
  assert.match(html, /n >= 1 && n <= 255/, 'validator bounds each token to 1..255');
});

test('params field validates as JSON in the editor (runtime mergeParams trusts it)', () => {
  const start = html.indexOf("params: { value: '{}', validate: function (v) {");
  assert.ok(start > 0, 'params declares an inline JSON validator');
  let i = html.indexOf('{', html.indexOf('function (v)', start));
  const bodyStart = i + 1;
  let depth = 1;
  while (depth > 0) {
    i += 1;
    if (html[i] === '{') depth += 1;
    if (html[i] === '}') depth -= 1;
  }
  const body = html.slice(bodyStart, i);
  const validate = new Function('v', body);
  assert.equal(validate('{"1":1}'), true, 'valid JSON passes');
  assert.equal(validate(''), true, 'blank passes (defaults to empty params)');
  assert.equal(validate('{oops'), false, 'unparseable JSON is refused at the editor');
});

test('delivery and selectionMode changes reload catalogs and refresh visibility', () => {
  assert.match(
    html,
    /function refreshVisibility/,
    'refreshVisibility function is defined'
  );
  assert.match(html, /function refreshCatalogsAndVisibility/, 'combined reload helper is defined');
  const deliveryHandler = html.match(
    /#node-input-delivery['"]\)\.on\(['"]change['"],\s*refreshCatalogsAndVisibility\)/
  );
  const selectionHandler = html.match(
    /#node-input-selectionMode['"]\)\.on\(['"]change['"],\s*refreshCatalogsAndVisibility\)/
  );
  const dialectHandler = html.match(
    /\$dialect\.on\(['"]change['"],\s*refreshCatalogsAndVisibility\)/
  );
  assert.ok(deliveryHandler, 'delivery change reloads catalogs');
  assert.ok(selectionHandler, 'selectionMode change reloads catalogs');
  assert.ok(dialectHandler, 'dialect change reuses refreshCatalogsAndVisibility');
  const helperStart = html.indexOf('function refreshCatalogsAndVisibility');
  const helper = html.slice(
    helperStart,
    html.indexOf('var $dialect', helperStart)
  );
  assert.match(helper, /refreshVehicleTypeOptions\(\)/, 'MAV_TYPE catalog is reloaded');
  assert.match(helper, /refreshCommandOptions\(\)/, 'MAV_CMD catalog is reloaded');
  assert.match(helper, /refreshVisibility\(\)/, 'visibility is still refreshed');
});

test('carrier defaults to the first valid option with no blank prompt', () => {
  assert.match(html, /id="node-input-carrier"/, 'carrier select must bind to the carrier property');
  assert.match(html, /<option value="int">/, 'COMMAND_INT option offered');
  assert.match(html, /<option value="long">/, 'COMMAND_LONG option offered');
  assert.match(
    html,
    /carrier:\s*\{ value: 'int' \}/,
    'new swarm nodes default to COMMAND_INT'
  );
  assert.doesNotMatch(html, /select carrier/, 'carrier select has no meaningless blank prompt');
});

test('frame row binds to the frame property and follows the INT carrier (§9)', () => {
  assert.match(html, /id="node-input-frame"/, 'frame select must bind to the frame property');
  assert.match(
    html,
    /frame:\s*\{ value: '' \}/,
    'frame is declared in defaults (blank = builder default GLOBAL) so the selection persists'
  );
  assert.match(html, /row-swarm-frame/, 'frame row id must exist');
  assert.match(html, /refreshCarrierRows/, 'carrier/frame visibility is wired');
});
