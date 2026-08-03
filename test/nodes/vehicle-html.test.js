'use strict';

/**
 * Vehicle Profile editor: dialect + dated revision pulldowns (seed + catalog).
 * Static assertions against the editor HTML.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(
  path.join(__dirname, '..', '..', 'nodes', 'mavlink-vehicle.html'),
  'utf8'
);

test('dialect and dialectRevision are the persisted library picks', () => {
  assert.match(html, /dialect:\s*\{\s*value:\s*'ardupilotmega'/);
  assert.match(html, /dialectRevision:\s*\{\s*value:\s*'seed'/);
  assert.match(html, /id="node-config-input-dialect"/);
  assert.match(html, /id="node-config-input-dialectRevision"/);
});

test('dialect and revision are the only dialect inputs the editor offers', () => {
  assert.ok(!/dialectSource/.test(html));
  assert.ok(!/customDialectPath/.test(html));
  assert.ok(!/oneditsave/.test(html));
  assert.ok(!/id="mav-catalog-pick"/.test(html));
  assert.ok(!/not yet implemented/i.test(html));
  assert.ok(!/future upload mechanism/i.test(html));
});

test('seed refresh workflow passes dispatch ref via env (no shell interpolation)', () => {
  const yml = fs.readFileSync(
    path.join(__dirname, '..', '..', '.github', 'workflows', 'refresh-mavlink-seed.yml'),
    'utf8'
  );
  assert.match(yml, /MAVLINK_REF:\s*\$\{\{\s*inputs\.ref/);
  assert.match(yml, /--ref "\$MAVLINK_REF"/);
  assert.ok(
    !/--ref "\$\{\{/.test(yml),
    'must not interpolate inputs.ref directly into the run script'
  );
});

test('seed refresh workflow pins third-party actions by commit SHA', () => {
  const yml = fs.readFileSync(
    path.join(__dirname, '..', '..', '.github', 'workflows', 'refresh-mavlink-seed.yml'),
    'utf8'
  );
  assert.match(yml, /uses:\s*actions\/checkout@[0-9a-f]{40}/);
  assert.match(yml, /uses:\s*actions\/setup-node@[0-9a-f]{40}/);
  assert.match(yml, /uses:\s*peter-evans\/create-pull-request@[0-9a-f]{40}/);
  assert.ok(!/uses:\s*actions\/checkout@v\d/.test(yml));
  assert.ok(!/uses:\s*actions\/setup-node@v\d/.test(yml));
  assert.ok(!/uses:\s*peter-evans\/create-pull-request@v\d/.test(yml));
});

test('paramDefsUrl is persisted and shown as an input', () => {
  assert.match(html, /paramDefsUrl:\s*\{\s*value:\s*''\s*\}/);
  assert.match(html, /<input type="text" id="node-config-input-paramDefsUrl"/);
});

test('parameter definitions use an explicit profile-keyed Update workflow', () => {
  assert.match(html, /id="mav-param-defs-update"[^>]*>Update<\/button>/);
  assert.match(html, /id="mav-param-defs-status"/);
  assert.match(html, /mavlinkAdminUrl\(['"]\/mavlink\/param\/defs\/update['"]\)/);
  assert.match(html, /method:\s*'POST'/);
  assert.match(html, /vehicle:\s*node\.id/);
  assert.match(html, /const url = \$\('#node-config-input-paramDefsUrl'\)\.val\(\)\.trim\(\)/);
  assert.match(html, /url:\s*url/);
  assert.match(html, /used only by Update/i);
  assert.match(html, /without downloaded definitions/i);
});

test('the XML-catalog admin endpoints are wired under mavlink/xml-catalog', () => {
  assert.match(html, /mavlinkAdminUrl\(['"]\/mavlink\/xml-catalog['"]\)/, 'list endpoint');
  assert.match(html, /mavlinkAdminUrl\(['"]\/mavlink\/xml-catalog\/update['"]\)/, 'update endpoint');
  assert.match(html, /mavlinkAdminUrl\(['"]\/mavlink\/xml-catalog\/compare['"]\)/, 'compare endpoint');
});

test('catalog actions update and compare are present', () => {
  assert.match(html, /id="mav-catalog-update"/);
  assert.match(html, /id="mav-catalog-compare"/);
  assert.match(html, /Compare with seed/);
});

test('update posts JSON to the update endpoint', () => {
  assert.match(html, /method:\s*'POST'/);
  assert.match(html, /contentType:\s*'application\/json'/);
});

test('admin catalog fetches use adminApiUrl (httpAdminRoot-safe)', () => {
  assert.match(html, /function mavlinkAdminUrl/, 'vehicle guards adminApiUrl availability');
  assert.match(html, /RED\.mavlink\.adminApiUrl/, 'vehicle delegates to shared adminApiUrl helper');
  assert.ok(
    !/\$\.getJSON\(\s*['"]mavlink\//.test(html),
    'bare relative mavlink getJSON paths must be gone'
  );
  assert.ok(
    !/url:\s*['"]mavlink\//.test(html),
    'bare relative mavlink ajax url paths must be gone'
  );
});

test('the component-dialect picker is a plain multi-select synced to a hidden field', () => {
  assert.match(html, /additionalDialects:\s*\{\s*value:\s*''/);
  assert.match(html, /id="mav-component-dialects"[^>]*multiple="multiple"/);
  assert.match(html, /id="node-config-input-additionalDialects"/);
  // No editableList and no oneditsave: the hidden input is an ordinary
  // node-config-input-* field, so Node-RED serializes it.
  assert.ok(!/editableList/.test(html));
  assert.ok(!/oneditsave/.test(html));
});

test('the picker hides dialects the primary already includes', () => {
  // ardupilotmega pulls in uAvionix/icarous/loweheiser/cubepilot/csAirLink;
  // storm32 pulls in ardupilotmega. Offering those would offer nothing new.
  assert.match(html, /chain\.indexOf\(d\.entry\)/);
  assert.match(html, /populateComponents/);
});

test('dialect, version and components sit above Advanced, not inside it', () => {
  // The dialect is what the vehicle speaks — as core as Firmware, which has
  // always been top-level. Advanced keeps the maintenance actions only.
  const advanced = html.slice(html.indexOf('class="mav-advanced"'));
  assert.ok(!/id="node-config-input-dialect"/.test(advanced), 'Dialect is not advanced');
  assert.ok(!/id="node-config-input-dialectRevision"/.test(advanced), 'Version is not advanced');
  assert.ok(!/id="mav-component-dialects"/.test(advanced), 'Components is not advanced');
  assert.match(advanced, /id="mav-catalog-update"/, 'catalog actions stay advanced');
  assert.match(advanced, /id="node-config-input-paramDefsUrl"/, 'param defs stays advanced');
});

test('CompID options load after the dialect select is populated', () => {
  // MAV_COMPONENT is fetched for the dialect this profile selects, so the
  // query needs #node-config-input-dialect already filled. Loading it before
  // loadLibrary() resolves sends an empty query and the list collapses to the
  // saved value alone — the operator can then pick nothing else.
  const prepare = html.slice(html.indexOf('oneditprepare'));
  const loadCall = prepare.indexOf('loadEnumsCatalog');
  const inCallback = prepare.indexOf('populateDialects(node.dialect);\n          reloadCompIds();');
  assert.ok(inCallback !== -1, 'CompID reload runs inside the loadLibrary callback');
  assert.ok(loadCall !== -1);
  assert.match(prepare, /\$dialect\.on\('change'[\s\S]{0,200}reloadCompIds\(\)/);
  assert.match(prepare, /\$revision\.on\('change', reloadCompIds\)/);
});
