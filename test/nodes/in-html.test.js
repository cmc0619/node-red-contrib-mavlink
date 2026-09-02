'use strict';

/**
 * mavlink-in editor: message filter is a dialect dropdown (DESIGN.md §6).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { installEditorHelpers } = require('../helpers/editor-resource');
const { loadNodeDefaults } = require('./html-assert');

const html = fs.readFileSync(
  path.join(__dirname, '..', '..', 'nodes', 'mavlink-in.html'),
  'utf8'
);

test('message filters are a list of dialect <select> rows, not free-form text (§6)', () => {
  assert.match(html, /<ol id="mav-in-messages">/, 'the filter is an editableList');
  assert.match(html, /addButton:\s*'add message'/, 'rows are added by button');
  assert.match(html, /\$\('<select>'/, 'each row carries a select, not a text input');
  assert.ok(
    !html.includes('placeholder="e.g. HEARTBEAT'),
    'the free-form message placeholder must be gone'
  );
  assert.ok(
    !/id="node-input-message"/.test(html),
    'the single-message field is gone, not left orphaned beside the list'
  );
});

test('message filter loads dialect messages from build/messages catalog', () => {
  assert.match(
    html,
    /RED\.mavlink\.loadCatalog\(\s*['"]\/mavlink\/build\/messages['"]/,
    'dialect message catalog uses shared loadCatalog'
  );
  assert.match(html, /function paintRow/, 'rows are painted from catalog entries');
  assert.match(html, /RED\.mavlink\.fillEnumSelect\(/, 'options are built via shared fillEnumSelect');
  assert.match(html, /valueKey:\s*['"]name['"]/, 'option values are message names');
  assert.match(html, /empty to receive every message/i, 'an empty list means all traffic');
});

test('message filter resolves dialect from the Connection vehicle graph (wire-only, shared helper)', () => {
  // mavlink-in has no Build tier: it always resolves through the shared wire
  // path (isBuild: false), and an empty target yields no catalog — never a
  // silent ardupilotmega. Skeleton proven in mavlink-editor-resource.test.js.
  assert.match(
    html,
    /RED\.mavlink\.loadCatalog\(\s*['"]\/mavlink\/build\/messages['"][\s\S]*isBuild:\s*false/,
    'catalog load uses the shared wire-tier isBuild:false override'
  );
  assert.doesNotMatch(html, /function resolveCatalogTarget/, 'no local catalog resolver copy');
  assert.doesNotMatch(html, /\$\.getJSON\(\s*RED\.mavlink\.adminApiUrl/, 'no hand-rolled catalog getJSON');
  assert.doesNotMatch(html, /dialect\s*=\s*['"]ardupilotmega['"]/, 'no invented default dialect');
});

test('message rows survive an async catalog load', () => {
  // A row can exist before the catalog arrives, and a Connection change
  // reloads it, so every existing row is repainted when one lands rather than
  // only the rows added afterwards.
  assert.match(html, /\(node\.messages \|\| \[\]\)\.forEach/, 'saved rows are restored');
  assert.match(
    html,
    /editableList\('items'\)\.each\(function \(\) \{\s*\n\s*paintRow/,
    'a catalog load repaints every existing row'
  );
  // paintRow captures the row's current value itself, so the fill is told what
  // to select rather than reading the live control a second time.
  assert.match(html, /const want = saved !== undefined \? saved : \$sel\.val\(\)/, 'the live selection is carried across a repaint');
  assert.match(html, /RED\.mavlink\.fillEnumSelect\(/, 'unknown saved values use shared fillEnumSelect sentinel');
});

test('compid filter validates as uint8 0..255 via the shared helper; blank = any', () => {
  // Same rule as the sibling sysid: a compid outside 0..255 can never match a
  // frame, so the editor reds it instead of the node sitting silent. Executed,
  // not just source-pinned — evaluate the real descriptor and call it.
  const match = html.match(/compid:\s*(\{[^}]*\})/);
  assert.ok(match, 'compid descriptor not found');
  const context = { RED: { mavlink: {} }, $: () => ({ length: 0, val: () => undefined }) };
  installEditorHelpers(context);
  const descriptor = vm.runInNewContext(`(${match[1]})`, context);
  const validate = (v) => descriptor.validate.call({}, v, {});

  assert.equal(validate(''), true, 'blank means any component');
  assert.equal(validate(0), true, 'MAV_COMP_ID_ALL');
  assert.equal(validate(255), true, 'the uint8 ceiling');
  assert.match(String(validate(256)), /between 0 and 255/, 'out of range reds the node');
  assert.match(String(validate(-1)), /between 0 and 255/);
});

test('messages red-rings anything but a list of non-blank names (walled garden)', () => {
  // The runtime subscribes straight off this array, so the editor guarantees
  // the shape oneditsave produces.
  const { messages } = loadNodeDefaults('mavlink-in');
  assert.equal(messages.validate.length, 2, 'two args, or a reason string reads as valid (§14)');
  assert.equal(messages.validate.call({}, [], {}), true, 'empty list = match all');
  assert.equal(messages.validate.call({}, ['HEARTBEAT', 'ATTITUDE'], {}), true);
  assert.match(String(messages.validate.call({}, 'HEARTBEAT', {})), /list/, 'a bare string reds');
  assert.match(String(messages.validate.call({}, ['HEARTBEAT', ''], {})), /blank/, 'a blank row reds');
  // Non-string entries match no decoded name, so the node would listen while
  // silently discarding every frame (Codex) — the ring reds them instead.
  assert.match(String(messages.validate.call({}, [1], {})), /string/, 'a numeric row reds');
  assert.match(String(messages.validate.call({}, [{}], {})), /string/, 'an object row reds');
});

test('changedFields red-rings tokens that can never name a decoded field — only when changed-only is on', () => {
  // Under changed-only an unmatchable token suppresses the stream after one
  // delivery, so the shape is caught at deploy. With changed-only off the
  // field is hidden and unused, so a stale value must not red the node
  // (hidden-widget rule).
  const { changedFields } = loadNodeDefaults('mavlink-in');
  assert.equal(changedFields.validate.length, 2);
  const on = { changedOnly: true };
  assert.equal(changedFields.validate.call(on, '', {}), true, 'blank = all fields except timestamps');
  assert.equal(changedFields.validate.call(on, 'custom_mode, base_mode', {}), true);
  assert.match(String(changedFields.validate.call(on, 'custom_mode,', {})), /field names/, 'a stray comma reds');
  assert.match(String(changedFields.validate.call(on, 'custom mode', {})), /field names/, 'a space mid-name reds');
  assert.equal(
    changedFields.validate.call({ changedOnly: false }, 'custom_mode,', {}),
    true,
    'a stale token must not red a control changed-only hides'
  );
});

test('fieldName red-rings anything but a single field name; blank = any', () => {
  const { fieldName } = loadNodeDefaults('mavlink-in');
  assert.equal(fieldName.validate.length, 2);
  assert.equal(fieldName.validate.call({}, '', {}), true, 'blank disables the predicate');
  assert.equal(fieldName.validate.call({}, 'base_mode', {}), true);
  assert.match(String(fieldName.validate.call({}, 'base_mode, custom_mode', {})), /single field name/);
});

test('admin catalog fetches go through shared loadCatalog (httpAdminRoot-safe)', () => {
  assert.match(html, /RED\.mavlink\.loadCatalog\(/, 'catalog fetches use shared loadCatalog');
  assert.ok(
    !/\$\.getJSON\(\s*['"]\/mavlink\//.test(html),
    'bare absolute /mavlink getJSON paths must be gone'
  );
});
