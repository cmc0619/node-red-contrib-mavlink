'use strict';

/**
 * DESIGN.md §6 — descriptions ride as tooltips, sourced from the dialect
 * registry / admin catalogs. No baked description strings in editor HTML.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', 'nodes');

function readHtml(name) {
  return fs.readFileSync(path.join(ROOT, `${name}.html`), 'utf8');
}

// Shared RED.mavlink.* helpers now live in the stock resource file (DESIGN.md §6).
const resourceScript = fs.readFileSync(
  path.join(__dirname, '..', '..', 'resources', 'mavlink-editor.js'),
  'utf8'
);

test('fillEnumSelect applies entry.description as option title', () => {
  assert.match(resourceScript, /if \(entry\.description\) \$opt\.attr\('title', entry\.description\)/);
});

test('Build message and MAV_CMD selects title via shared fillEnumSelect', () => {
  const html = readHtml('mavlink-build');
  assert.match(html, /RED\.mavlink\.fillEnumSelect\(sel,/);
  assert.match(html, /RED\.mavlink\.fillEnumSelect\(cmdSel,/);
  assert.match(html, /titleNamespace:\s*'mavmsgTip'/);
  assert.match(html, /titleNamespace:\s*'mavcmd'/);
  assert.match(html, /change\.mavmsgForm/, 'field-form rebuild uses a distinct change namespace');
  // Field controls already use spec.description (pre-existing).
  assert.match(html, /\.attr\('title',\s*(?:multi \? RED\.mavlink\.bitmaskTitle\(spec\.description\) : \(spec\.description \|\| ''\))/);
  assert.doesNotMatch(html, /\(missing\)/, 'Build uses the shared not-in-dialect sentinel wording');
});

test('Command Advanced MAV_CMD select and enum options use catalog descriptions', () => {
  const html = readHtml('mavlink-command');
  assert.match(html, /RED\.mavlink\.fillEnumSelect\(sel,\s*catalog\.commands/);
  assert.match(html, /titleNamespace:\s*'mavCmdTip'/);
  assert.match(html, /RED\.mavlink\.bindSelectTitleSync\(sel,\s*\{\s*namespace:\s*'mavPresetTip'/);
  assert.match(html, /if \(entry\.description\) \$opt\.attr\('title', entry\.description\)/);
  assert.match(html, /catalogParamByIndex/);
  // Preset rows merge the whole catalog param spec (description included) and
  // render through advancedParamInput, which titles inputs from it.
  assert.match(html, /Object\.assign\(\{\}, catalogParamByIndex/);
  assert.match(html, /spec\.description \|\| ''/);
});

test('In / Fan-out enum selects use shared fillEnumSelect', () => {
  const inn = readHtml('mavlink-in');
  // One select per message row (#211), so the fill takes the row's select.
  assert.match(inn, /RED\.mavlink\.fillEnumSelect\(\$sel,/);
  assert.match(inn, /titleNamespace:\s*'mavMsgTip'/);
  assert.doesNotMatch(inn, /function syncMessageTitle/);

  // The replicator keeps one enum select — the MAV_TYPE member filter.
  const fanout = readHtml('mavlink-fanout');
  assert.match(fanout, /RED\.mavlink\.fillEnumSelect\(sel,/);
  assert.match(fanout, /titleNamespace:\s*'mavTypeTip'/);
  assert.doesNotMatch(fanout, /titleNamespace:\s*'mavCmdTip'/, 'no command select in the replicator');
  assert.doesNotMatch(fanout, /function syncCmdTitle|function syncTypeTitle/);
});

test('select title-sync and missing-option sentinel live once in the resource', () => {
  assert.match(resourceScript, /RED\.mavlink\.bindSelectTitleSync\s*=/);
  assert.match(resourceScript, /RED\.mavlink\.ensureSavedEnumOption\s*=/);
  assert.match(resourceScript, /#.*\(not in dialect\)/);
  // Namespace is concatenated (`'change.' + ns`); default ns is mavEnumTip.
  assert.match(resourceScript, /off\('change\.' \+ ns\)\.on\('change\.' \+ ns/);
  assert.match(resourceScript, /namespace \|\| 'mavEnumTip'/);
});

test('queue band picker and companion target visibility live once in the resource', () => {
  assert.match(resourceScript, /RED\.mavlink\.BAND_OPTIONS\s*=/);
  assert.match(resourceScript, /RED\.mavlink\.fillBandSelect\s*=/);
  assert.match(resourceScript, /RED\.mavlink\.applyCompanionTargetVisibility\s*=/);
  assert.match(resourceScript, /hideCompidWhenCompanion/);
  const out = readHtml('mavlink-out');
  assert.match(out, /RED\.mavlink\.fillBandSelect\(/);
  assert.doesNotMatch(out, /BAND_OPTIONS\s*=/);
});

test('Param node titles come from loaded param defs, not baked HTML', () => {
  const html = readHtml('mavlink-param');
  // Composed from the loaded definition — description, then unit and range —
  // because the dialog carries this on hover rather than in a standing row.
  assert.match(html, /#node-input-paramId'\)\.attr\('title', hover\)/);
  assert.match(html, /hover = parts\.length \? parts\.join/, 'the definition detail composes it');
  assert.match(html, /parts\.push\(def\.description\)/, 'sourced from the definition');
  // …and the catalog that answered leads it, so "which definitions are these?"
  // is answerable before a parameter has been picked.
  assert.match(html, /_defsCatalog \+ '\\n' \+ hover/, 'the catalog line leads the hover');
  // The value field goes through the shared helper, which sets the title on the
  // input *and* its label and maintains the units hint — one mechanism, not a
  // hand-set attribute plus a private units span.
  assert.match(html, /RED\.mavlink\.applyFieldMeta\('node-input-value'/);
  assert.doesNotMatch(
    html,
    /#node-input-value'\)\.attr\('title'/,
    'the value title must not also be set by hand'
  );
  assert.ok(
    !/<input[^>]*id="node-input-paramId"[^>]*title="/.test(html),
    'paramId must not bake a static title into the template'
  );
});

test('Payload template has no baked MAVLink description titles', () => {
  const html = readHtml('mavlink-payload');
  const template = html.split('data-template-name="mavlink-payload"')[1] || '';
  const titles = [...template.matchAll(/\btitle="([^"]*)"/g)].map((m) => m[1]);
  for (const tip of titles) {
    assert.ok(
      !/Capture sequence|IMAGE_START|GIMBAL_MANAGER|metres north|NED frame/i.test(tip),
      `unexpected baked protocol tooltip: ${tip}`
    );
  }
});

test('Payload template does not bake protocol unit suffixes on value fields', () => {
  const html = readHtml('mavlink-payload');
  const template = html.split('data-template-name="mavlink-payload"')[1] || '';
  // Dialect units are applied via applyFieldUnits; keep only Node-RED config units
  // like ACK timeout "ms" if present outside tip fields.
  assert.ok(
    !/node-input-interval"[^>]*>\s*s\b/.test(template),
    'interval must not bake trailing "s"'
  );
  assert.ok(
    !/node-input-distance"[^>]*>\s*m\b/.test(template),
    'distance must not bake trailing "m"'
  );
  assert.ok(
    !/node-input-pitch"[^>]*>\s*deg\b/.test(template),
    'pitch must not bake trailing "deg"'
  );
});

test('Payload editor generates its form from /mavlink/payload/field-tips', () => {
  const html = readHtml('mavlink-payload');
  assert.match(html, /\/mavlink\/payload\/field-tips/);
  assert.match(html, /function renderFields/, 'rows are painted from the response');
  assert.match(html, /meta\.label \|\| humanize\(key\)/, 'labels come from the dialect');
  assert.match(html, /meta\.units/, 'units come from the dialect');
  assert.match(html, /meta\.default/, 'defaults come from the recipe, via the route');
  // The verb's parameters have no markup of their own — that is the point.
  assert.ok(!/node-input-sequence/.test(html), 'no static row per recipe slot');
  assert.ok(!/id="row-payload-lat"/.test(html));
});

test('shared applyFieldTitle / applyFieldUnits / applyFieldMeta helpers live on RED.mavlink', () => {
  assert.match(resourceScript, /RED\.mavlink\.applyFieldTitle\s*=\s*function/);
  assert.match(resourceScript, /RED\.mavlink\.applyFieldUnits\s*=\s*function/);
  assert.match(resourceScript, /RED\.mavlink\.applyFieldMeta\s*=\s*function/);
});

test('Payload catalogQuery reuses shared currentCatalogQuery', () => {
  const html = readHtml('mavlink-payload');
  assert.match(html, /RED\.mavlink\.currentCatalogQuery/);
  assert.match(resourceScript, /RED\.mavlink\.currentCatalogQuery\s*=\s*currentEnumQuery/);
  assert.match(resourceScript, /RED\.mavlink\.vehicleIdFrom\s*=\s*function/);
});

test('Payload editor keeps no field or enum table of its own (§6)', () => {
  const html = readHtml('mavlink-payload');
  // Every one of these was a parallel copy of something the dialect already
  // knows. The route is the single source now; re-adding any of them puts the
  // editor back in the business of restating the protocol.
  for (const gone of [
    'TIP_FIELDS',
    'FALLBACK_ENUMS',
    'MODE_ENUMS',
    'RELEASE_ACTION_ENUMS',
    'PAYLOAD_ENUM_NAMES',
    'RECIPE_ROWS',
  ]) {
    assert.ok(!html.includes(gone), `${gone} must not come back`);
  }
  assert.ok(!/GRIPPER_ACTIONS_|WINCH_ACTIONS_|PARACHUTE_ACTION_/.test(html),
    'no baked enum entry names');
});

test('Command params cannot be wiped by a premature Done (Codex #36)', () => {
  const html = readHtml('mavlink-command');
  // Catalog-driven rendering: while the catalog is loading only a placeholder
  // shows, and oneditsave refuses to
  // scrape a form that never rendered — saved params survive.
  assert.match(html, /_mavParamsRendered = false/, 'render pass starts unrendered');
  assert.match(html, /_mavParamsRendered = true/, 'real renders mark the form scrapable');
  assert.match(html, /RED\.mavlink\.loadCatalog\(/, 'catalog loads go through the shared helper');

  // Execute the actual oneditsave body, not just its source text: extract it
  // from the registration and run it against a node object (widget
  // persistence, per guidelines).
  const start = html.indexOf('oneditsave: function () {');
  assert.ok(start > 0, 'oneditsave handler exists');
  let i = html.indexOf('{', start);
  const bodyStart = i + 1;
  let depth = 1;
  while (i < html.length && depth > 0) {
    const c = html[++i];
    if (c === '{') depth += 1;
    else if (c === '}') depth -= 1;
  }
  const body = html.slice(bodyStart, i);
  // jQuery stub: no rendered inputs on the (placeholder) form. `written`
  // records what the save put into the hidden field.
  let written;
  const $stub = (selector) => ({
    each() {},
    val(value) { written[selector] = value; return this; },
  });
  // The scrape itself is shared with the params validator and tested there
  // (command-html.test.js); what is under test here is the guard in front of
  // it, so it is injected as a stub that reports an empty form.
  let scraped = 0;
  const scrapeStub = () => { scraped += 1; return {}; };
  const save = new Function('$', 'scrapeParamInputs', body);

  // Premature Done: the form never rendered → the hidden field is left alone,
  // so Node-RED's edit pane copies the dialog-open params straight back.
  written = {};
  save.call({ _mavParamsRendered: false }, $stub, scrapeStub);
  assert.deepEqual(written, {}, 'premature save writes nothing');
  assert.equal(scraped, 0, 'and the form is never even read');

  // A rendered zero-param form legitimately saves {}.
  written = {};
  save.call({ _mavParamsRendered: true }, $stub, scrapeStub);
  // The scrape must land in the hidden input: Node-RED runs oneditsave and
  // then overwrites node.params from `#node-input-params`, so a save that
  // only assigns `this.params` is discarded.
  assert.equal(written['#node-input-params'], '{}', 'a rendered empty form saves {} to the hidden field');
});

test('Command catalog state keeps only its request sequence', () => {
  const html = readHtml('mavlink-command');
  assert.match(
    html,
    /RED\.mavlink\.loadCatalog\(\s*['"]\/mavlink\/command\/commands['"]/,
    'commands catalog uses the shared loader'
  );
  assert.match(html, /_cmdCatalog\s*=\s*\{\s*seq:\s*0\s*\}/);
  assert.doesNotMatch(html, /\bbyKey\b|\binflight\b/);
});

test('Command reapplies preset option tips when Connection / Vehicle changes', () => {
  const html = readHtml('mavlink-command');
  assert.match(html, /function applyPresetOptionTips/);
  assert.match(html, /function refreshPresetTipsAndParams/);
  // One catalog load paints tips then refreshParamFields with the latest data.
  assert.match(
    html,
    /loadCommandsCatalog\(function \(catalog\) \{[\s\S]*applyPresetOptionTips\(null, catalog\);[\s\S]*refreshParamFields\(\);/
  );
  assert.match(
    html,
    /#node-input-connection'\)\.on\('change'[\s\S]*refreshPresetTipsAndParams\(\)/
  );
});
