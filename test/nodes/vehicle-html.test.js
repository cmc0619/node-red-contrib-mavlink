'use strict';

/**
 * Vehicle Profile editor: dialect + dated revision pulldowns (seed + catalog).
 * Static assertions against the editor HTML.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { assertChangeHandlerContains, loadNodeDefaults } = require('./html-assert');

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

test('a Firmware change that swaps the dialect runs the dialect change handler (revisions, components, CompIDs)', () => {
  assertChangeHandlerContains(html, '$firmware', "$dialect.val(want).trigger('change')");
  assertChangeHandlerContains(html, '$dialect', 'populateComponents()');
  assertChangeHandlerContains(html, '$dialect', 'reloadCompIds()');
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

test('seed refresh workflow pins actions by commit SHA', () => {
  const yml = fs.readFileSync(
    path.join(__dirname, '..', '..', '.github', 'workflows', 'refresh-mavlink-seed.yml'),
    'utf8'
  );
  assert.match(yml, /uses:\s*actions\/checkout@[0-9a-f]{40}/);
  assert.match(yml, /uses:\s*actions\/setup-node@[0-9a-f]{40}/);
  assert.ok(!/uses:\s*actions\/checkout@v\d/.test(yml));
  assert.ok(!/uses:\s*actions\/setup-node@v\d/.test(yml));
});

test('seed refresh is button-only and commits straight to the branch, behind the suite', () => {
  // Owner ruling (2026-08-22): no weekly cron — the seed reaches users at
  // release time, so refresh is a release-checklist button press. The commit
  // is direct (Actions cannot open PRs on this repo) and must sit AFTER the
  // test run, so a seed that breaks a pinned enum/command fact never lands.
  const yml = fs.readFileSync(
    path.join(__dirname, '..', '..', '.github', 'workflows', 'refresh-mavlink-seed.yml'),
    'utf8'
  );
  assert.ok(!/schedule:|cron:/.test(yml), 'no scheduled refresh');
  assert.match(yml, /workflow_dispatch:/, 'the button stays');
  assert.ok(!/create-pull-request/.test(yml), 'no PR-creating action');
  assert.ok(!/pull-requests:\s*write/.test(yml), 'no PR permission either');
  const testStep = yml.indexOf('run: npm test');
  const pushStep = yml.indexOf('git push');
  assert.ok(testStep !== -1 && pushStep !== -1 && testStep < pushStep,
    'the suite gates the push');
});

test('the param defs URL is a dialog input the Update button reads', () => {
  assert.match(html, /<input type="text" id="node-config-input-paramDefsUrl"/);
});

test('parameter definitions use an explicit profile-keyed Update workflow', () => {
  assert.match(html, /id="mav-param-defs-update"[^>]*>Update<\/button>/);
  assert.match(html, /id="mav-param-defs-status"/);
  assert.match(html, /['"]mavlink\/param\/defs\/update['"]/);
  assert.match(html, /method:\s*'POST'/);
  assert.match(html, /vehicle:\s*node\.id/);
  assert.match(html, /const url = \$\('#node-config-input-paramDefsUrl'\)\.val\(\)\.trim\(\)/);
  assert.match(html, /JSON\.stringify\(\{ vehicle: node\.id, url \}\)/);
  assert.match(html, /used only by Update/i);
  assert.match(html, /pre-filled when firmware/i);
  // No known URL → hide the row (Custom firmware; ArduPilot + unknown family).
  assert.match(html, /id="mav-param-defs-section"/);
  assert.match(html, /\$\('#mav-param-defs-section'\)\.toggle\(url !== ''\)/);
});

test('the XML-catalog admin endpoints are wired under mavlink/xml-catalog', () => {
  assert.match(html, /['"]mavlink\/xml-catalog['"]/, 'list endpoint');
  assert.match(html, /['"]mavlink\/xml-catalog\/update['"]/, 'update endpoint');
});

test('the catalog update action is present', () => {
  assert.match(html, /id="mav-catalog-update"/);
});

test('update posts JSON to the update endpoint', () => {
  assert.match(html, /method:\s*'POST'/);
  assert.match(html, /contentType:\s*'application\/json'/);
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

test('additionalDialects red-rings a token missing either half of dialect@revision', () => {
  const { additionalDialects } = loadNodeDefaults('mavlink-vehicle');
  assert.equal(additionalDialects.validate.length, 2, 'two args, or a reason string reads as valid (§14)');
  assert.equal(additionalDialects.validate.call({}, '', {}), true, 'blank = no component dialects');
  assert.equal(additionalDialects.validate.call({}, 'storm32@seed', {}), true);
  assert.equal(additionalDialects.validate.call({}, 'storm32@seed,icarous@2026-01-01', {}), true);
  assert.match(String(additionalDialects.validate.call({}, 'storm32', {})), /dialect@revision/);
  assert.match(String(additionalDialects.validate.call({}, 'storm32@', {})), /dialect@revision/);
  assert.match(String(additionalDialects.validate.call({}, '@seed', {})), /dialect@revision/);
  // dialectPicks splits on lastIndexOf('@'), so a second @ would silently
  // mis-split the dialect name — exactly one @ per token.
  assert.match(String(additionalDialects.validate.call({}, 'storm32@seed@extra', {})), /dialect@revision/);
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

test('firmware and vehicle family red on membership (walled-garden sweep)', () => {
  // Both feed lookup tables keyed by exactly these members; a stray token
  // looks nothing up, silently, so the dialog is where it reds.
  const defaults = loadNodeDefaults('mavlink-vehicle');

  // `required` rides beside the ring (owner ruling, #372): Node-RED answers
  // blank through the generic missing-required path before the validator
  // runs; the direct validator call below still shows the ring covers blank.
  assert.equal(defaults.firmware.required, true);
  assert.equal(defaults.vehicleFamily.required, true);

  for (const v of ['ardupilot', 'px4']) {
    assert.equal(defaults.firmware.validate.call({}, v, {}), true, v);
  }
  assert.match(String(defaults.firmware.validate.call({}, 'betaflight', {})), /must be one of/);
  assert.match(String(defaults.firmware.validate.call({}, '', {})), /must be one of/, 'blank firmware reds');

  for (const v of ['unknown', 'copter', 'plane', 'rover', 'boat', 'sub', 'blimp', 'antenna-tracker']) {
    assert.equal(defaults.vehicleFamily.validate.call({}, v, {}), true, v);
  }
  assert.match(String(defaults.vehicleFamily.validate.call({}, 'submarine', {})), /must be one of/);
});

/**
 * Run the dialog's real populateRevisions (and dialectRow) over a fake
 * select: the library, the saved node, and the live dialect are the inputs.
 */
function revisionsPicker(library, node, liveDialect) {
  const src = (name) => {
    const start = html.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `${name} not found`);
    let depth = 0;
    for (let i = html.indexOf('{', start); i < html.length; i++) {
      if (html[i] === '{') depth++;
      if (html[i] === '}' && --depth === 0) return html.slice(start, i + 1);
    }
    throw new Error(`${name} is unterminated`);
  };
  let options = [];
  let value = null;
  const $revision = {
    empty() { options = []; return this; },
    find(sel) {
      const v = /^option\[value="(.*)"\]$/.exec(sel)[1];
      return { length: options.some((o) => o.value === v) ? 1 : 0 };
    },
    val(v) { if (v === undefined) return value; value = v; return this; },
  };
  const $ = () => {
    const o = { value: undefined, label: '' };
    const w = {
      val(v) { o.value = v; return w; },
      text(t) { o.label = t; return w; },
      attr() { return w; },
      appendTo() { options.push(o); return w; },
    };
    return w;
  };
  const $dialect = { val: () => liveDialect };
  const populate = new Function('$', '$revision', '$dialect', 'library', 'node',
    `${src('dialectRow')}\n${src('populateRevisions')}\nreturn populateRevisions;`
  )($, $revision, $dialect, library, node);
  return { populate, options: () => options, value: () => value };
}

test('a saved dialect revision the library lacks survives open-and-save', () => {
  const library = [{ name: 'common', versions: [{ id: 'seed', label: 'Seed (shipped)' }] }];
  const node = { dialect: 'common', dialectRevision: 'rev-2025' };

  const open = revisionsPicker(library, node, 'common');
  open.populate(node.dialectRevision);
  assert.equal(open.value(), 'rev-2025', 'the saved snapshot is still what Done saves');
  assert.ok(open.options().some((o) => o.label === 'rev-2025 (not in library)'), 'and it says why');

  const changed = revisionsPicker(library, node, 'ardupilotmega');
  changed.populate('seed');
  assert.equal(changed.value(), 'seed', 'a dialect change still starts from the seed');
  assert.ok(!changed.options().some((o) => /not in library/.test(o.label)));
});
