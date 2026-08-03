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

test('In / Fan-out message and command selects use shared fillEnumSelect', () => {
  const inn = readHtml('mavlink-in');
  assert.match(inn, /RED\.mavlink\.fillEnumSelect\(sel,/);
  assert.match(inn, /titleNamespace:\s*'mavMsgTip'/);
  assert.doesNotMatch(inn, /function syncMessageTitle/);

  const fanout = readHtml('mavlink-fanout');
  assert.match(fanout, /RED\.mavlink\.fillEnumSelect\(sel,/);
  assert.match(fanout, /titleNamespace:\s*'mavCmdTip'/);
  assert.match(fanout, /titleNamespace:\s*'mavTypeTip'/);
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
  assert.match(html, /#node-input-paramId'\)\.attr\('title', def\.description\)/);
  assert.match(html, /#node-input-value'\)\.attr\('title', def\.description\)/);
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

test('Payload editor loads field tips from /mavlink/payload/field-tips', () => {
  const html = readHtml('mavlink-payload');
  assert.match(html, /\/mavlink\/payload\/field-tips/);
  assert.match(html, /refreshPayloadFieldTips/);
  assert.match(html, /RED\.mavlink\.applyFieldMeta/);
  // Sequence is a tip target — description comes from the dialect join, not HTML.
  assert.match(html, /['"]sequence['"]/);
  assert.match(html, /node-input-sequence/);
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

test('Payload TIP_FIELDS excludes enum selects driven by fillEnumSelect', () => {
  const html = readHtml('mavlink-payload');
  const tipBlock = html.match(/var TIP_FIELDS = \[([\s\S]*?)\];/);
  assert.ok(tipBlock, 'TIP_FIELDS declaration');
  assert.ok(!/['"]modeValue['"]/.test(tipBlock[1]), 'modeValue stays on fillEnumSelect');
  assert.ok(!/['"]actionValue['"]/.test(tipBlock[1]), 'actionValue stays on fillEnumSelect');
  assert.match(tipBlock[1], /['"]sequence['"]/);
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
  // jQuery stub: no rendered inputs on the (placeholder) form.
  const $stub = () => ({ each() {} });
  const save = new Function('$', body);

  // Premature Done: the form never rendered → the saved params must survive.
  const unrendered = { _mavParamsRendered: false, params: '{"5":47.1,"6":-122.5}' };
  save.call(unrendered, $stub);
  assert.equal(unrendered.params, '{"5":47.1,"6":-122.5}', 'premature save keeps stored params');

  // A rendered zero-param form legitimately saves {}.
  const rendered = { _mavParamsRendered: true, params: '{"5":47.1}' };
  save.call(rendered, $stub);
  assert.equal(rendered.params, '{}', 'a rendered empty form saves {}');
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
