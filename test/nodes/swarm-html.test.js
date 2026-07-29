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
  assert.match(html, /RED\.mavlink\.adminApiUrl\(['"]\/mavlink\/build\/messages['"]\)/, 'dialect enum catalog is loaded from admin API');
  assert.match(html, /enums\.MAV_TYPE/, 'MAV_TYPE table is read from the catalog');
  assert.match(html, /function buildVehicleTypeDropdown/, 'dropdown is rebuilt from catalog entries');
  assert.match(html, /entry\.label/, 'option labels come from the catalog (value in parentheses)');
  assert.match(html, /Any type/, 'empty selection means any vehicle type');
});

test('vehicleType preserves the saved numeric value after async catalog load', () => {
  assert.match(html, /node\.vehicleType/, 'saved vehicleType is re-applied');
  assert.match(html, /const prefer = current \|\| saved|var prefer = current \|\| saved/, 'in-progress selection wins over saved');
  assert.match(html, /not in dialect/, 'unknown saved values remain selectable');
  assert.match(html, /_msgRequestSeq/, 'stale catalog responses are ignored');
  // Cache hits must bump the seq before returning so in-flight requests cannot overwrite.
  assert.match(
    html,
    /var seq = \+\+_msgRequestSeq;\s*if \(_msgCatalogByKey\[target\.key\]\)/,
    'cached catalog path invalidates pending requests'
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
  assert.match(html, /RED\.mavlink\.adminApiUrl\(['"]\/mavlink\/command\/commands['"]\)/, 'dialect MAV_CMD catalog is loaded from admin API');
  assert.match(html, /function buildCommandDropdown/, 'dropdown is rebuilt from catalog entries');
  assert.match(html, /entry\.label/, 'option labels come from the catalog (MAV_CMD_… (n))');
  assert.match(html, /entry\.value/, 'option values are numeric command ids');
  assert.match(html, /_cmdRequestSeq/, 'stale command catalog responses are ignored');
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

test('swarm catalog target uses Build+list dialect selection without inventing ardupilotmega', () => {
  const resolver = html.slice(
    html.indexOf('function resolveCatalogTarget'),
    html.indexOf('function loadMessagesCatalog')
  );
  const messagesLoader = html.slice(
    html.indexOf('function loadMessagesCatalog'),
    html.indexOf('function buildVehicleTypeDropdown')
  );
  const commandsLoader = html.slice(
    html.indexOf('function loadCommandsCatalog'),
    html.indexOf('function buildCommandDropdown')
  );

  assert.match(resolver, /isBuildList/, 'Build+list branch determines when no connection governs catalogs');
  assert.match(resolver, /if \(!dialectVal\) return emptyCatalogTarget\(\)/, 'empty Build+list dialect must produce no catalog target');
  assert.match(resolver, /dialectVal !== ['"]__vehicle['"]/, 'concrete dialects use the selected dialect directly');
  assert.match(resolver, /query:\s*\{\s*vehicle:\s*vehicleId,\s*dialect:\s*vehicleDialect\s*\}/, 'Vehicle Profile escape queries by profile id and dialect');
  assert.doesNotMatch(resolver, /ardupilotmega/, 'swarm catalog target resolution must not hardcode ardupilotmega');
  assert.match(messagesLoader, /if \(!target\.query\)/, 'message catalog loader must not fetch an invented dialect for empty targets');
  assert.match(commandsLoader, /if \(!target\.query\)/, 'command catalog loader must not fetch an invented dialect for empty targets');
});

test('swarm connection-governed catalogs keep using the connection profile', () => {
  const resolver = html.slice(
    html.indexOf('function resolveCatalogTarget'),
    html.indexOf('function loadMessagesCatalog')
  );

  assert.match(resolver, /#node-input-connection/, 'connection-governed branch reads the connection picker');
  assert.match(resolver, /connNode\.vehicle/, 'connection-governed branch follows the selected connection profile');
  assert.match(resolver, /key:\s*'vehicle:' \+ connNode\.vehicle/, 'catalog cache is keyed by connection profile id');
  assert.match(resolver, /query:\s*\{\s*vehicle:\s*connNode\.vehicle,\s*dialect:\s*connDialect\s*\}/, 'catalog query carries the connection profile id for custom dialects');
});

test('commandId preserves the saved numeric value after async catalog load', () => {
  assert.match(html, /node\.commandId/, 'saved commandId is re-applied');
  assert.match(html, /not in dialect/, 'unknown saved values remain selectable');
});

test('admin catalog fetches use adminApiUrl (httpAdminRoot-safe)', () => {
  assert.match(html, /RED\.mavlink\.adminApiUrl\(/, 'admin fetches must use adminApiUrl');
  assert.ok(
    !/\$\.getJSON\(\s*['"]\/mavlink\//.test(html),
    'bare absolute /mavlink getJSON paths must be gone'
  );
});

test('identity defaults to empty string and fillIdentitySelect is called with gcs+custom filter (§6)', () => {
  assert.match(
    html,
    /identity:\s*\{\s*value:\s*''\s*\}/,
    'identity property defaults to empty string'
  );
  assert.match(
    html,
    /RED\.mavlink\.fillIdentitySelect\(/,
    'fillIdentitySelect is called to populate the Send-as dropdown'
  );
  assert.match(
    html,
    /rolesAllowed.*\[.*['"]gcs['"].*,.*['"]custom['"]/,
    "rolesAllowed filters to ['gcs','custom'] (gcs-paradigm by nature, §6)"
  );
  assert.match(
    html,
    /<select id="node-input-identity"/,
    'Send-as identity field is a plain <select>'
  );
  assert.match(
    html,
    /node\.identity/,
    'saved identity is passed to fillIdentitySelect as the saved option'
  );
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
    /refreshIdentitySelect/,
    'refreshIdentitySelect helper is defined'
  );
  assert.match(
    html,
    /#node-input-connection.*change|change.*#node-input-connection/,
    'connection change event handler is wired'
  );
  // The connection change handler must call refreshIdentitySelect.
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
  assert.ok(deliveryHandler, 'delivery change reloads catalogs');
  assert.ok(selectionHandler, 'selectionMode change reloads catalogs');
  const helperStart = html.indexOf('function refreshCatalogsAndVisibility');
  const helper = html.slice(
    helperStart,
    html.indexOf('var $dialect', helperStart)
  );
  assert.match(helper, /refreshVehicleTypeOptions\(\)/, 'MAV_TYPE catalog is reloaded');
  assert.match(helper, /refreshCommandOptions\(\)/, 'MAV_CMD catalog is reloaded');
  assert.match(helper, /refreshVisibility\(\)/, 'visibility is still refreshed');
});
