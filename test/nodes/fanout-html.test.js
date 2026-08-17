'use strict';

/**
 * Fan-out editor: replicator controls only — no embedded action editor (§10).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadNodeDefaults } = require('./html-assert');

const html = fs.readFileSync(
  path.join(__dirname, '..', '..', 'nodes', 'mavlink-fanout.html'),
  'utf8'
);

test('fan-out is a replicator: the embedded action editor is gone (§10)', () => {
  // Message construction lives in the action nodes' Build tiers; none of the
  // per-action config may survive here.
  for (const gone of [
    'node-input-actionType',
    'node-input-commandId',
    'node-input-preset',
    'node-input-params',
    'node-input-carrier',
    'node-input-frame',
    'node-input-moveMode',
    'node-input-moveFrame',
    'node-input-north',
    'node-input-lat',
    'node-input-vNorth',
    'node-input-aNorth',
    'node-input-topic',
    'node-input-verb',
    'node-input-paramId',
    'node-input-paramType',
  ]) {
    assert.ok(!html.includes(gone), `${gone} must be gone from the replicator editor`);
  }
  // No Build+list dialect picker either: with no catalogs to serve, the
  // dialect/vehicle rows have no reason to exist.
  assert.ok(!html.includes('node-input-dialect'), 'dialect picker is gone');
  assert.ok(!html.includes('row-fanout-vehicle'), 'vehicle row is gone');
  assert.match(html, /Build-tier|built/i, 'help text names the built-message contract');
});

test('vehicleType is a MAV_TYPE select loaded from the shared catalog (§6)', () => {
  assert.match(
    html,
    /<select id="node-input-vehicleType">/,
    'Type filter must be a select dropdown'
  );
  assert.match(
    html,
    /RED\.mavlink\.loadCatalog\(\s*['"]\/mavlink\/build\/messages['"]/,
    'dialect enum catalog uses shared loadCatalog'
  );
  assert.match(html, /enums\.MAV_TYPE/, 'MAV_TYPE table is read from the catalog');
  assert.match(html, /RED\.mavlink\.fillEnumSelect\(/, 'options are built via shared fillEnumSelect');
  assert.match(html, /Any type/, 'empty selection means any vehicle type');
  assert.match(html, /saved:\s*node\.vehicleType/, 'the saved MAV_TYPE is offered');
  assert.match(html, /preferLive:\s*true/, 'in-progress selection wins over saved');
});

test('firmware filter is a small select (ArduPilot/PX4/custom)', () => {
  assert.match(html, /<select id="node-input-firmwareFilter">/);
  assert.match(html, /<option value="ardupilot">ArduPilot<\/option>/);
  assert.match(html, /<option value="px4">PX4<\/option>/);
  assert.match(html, /<option value="custom">Custom<\/option>/);
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
    'Identity field is a plain <select>'
  );
  assert.doesNotMatch(html, /function refreshIdentitySelect/, 'no local identity-refresh copy');
});

test('identity is re-filled when connection selection changes', () => {
  const changeHandlerMatch = html.match(
    /#node-input-connection['"]\)\.on\(['"]change['"][^)]*\)\s*\{([\s\S]*?)\}/
  );
  assert.ok(
    changeHandlerMatch && /refreshIdentitySelect/.test(changeHandlerMatch[0]),
    'refreshIdentitySelect is called inside the connection change handler'
  );
});

test('members table replaces the sysids CSV: editableList rows saved through oneditsave (#163)', () => {
  assert.ok(!html.includes('node-input-sysids'), 'the sysids CSV field is gone — pre-1.0 rename, no alias');
  assert.match(html, /\$members\.editableList\(/, 'rows use the stock editableList widget');
  assert.match(html, /oneditsave:/, 'a custom widget must save through oneditsave');
});

test('members validator: per-row reasons, offsets-vs-position-patch conflict reds (#163)', () => {
  const defaults = loadNodeDefaults('mavlink-fanout');
  // Cross-realm value (vm context), so shape checks rather than deepEqual.
  assert.equal(Array.isArray(defaults.members.value), true, 'members defaults to a row array');
  assert.equal(defaults.members.value.length, 0, 'the default row list is empty');
  const validate = defaults.members.validate;
  const onList = (v) => validate.call({ selectionMode: 'list' }, v, {});

  assert.equal(validate.call({ selectionMode: 'all' }, [], {}), true,
    'members is not required outside list selection');
  assert.match(String(onList([])), /at least one member row/,
    'empty table reds with a reason when list selection is live');
  assert.equal(onList([{ sysid: 1 }, { sysid: 2, north: 5, up: -2, patch: { param1: 3 } }]), true,
    'rows with metre offsets and a non-position patch pass');
  assert.match(String(onList([{ sysid: 0 }])), /sysid must be an integer 1-255/);
  assert.match(String(onList([{ sysid: 1, north: '5' }])), /finite number of metres/,
    'a non-number offset reds (oneditsave stores numbers)');
  assert.match(String(onList([{ sysid: 1, patch: 'not json' }])), /JSON object/,
    'unparseable patch text is kept and reds rather than being dropped');
  // A row carrying both a metre offset and a raw patch of a position field
  // would make the runtime pick a winner — the editor reds it instead.
  assert.match(String(onList([{ sysid: 1, up: 3, patch: { param7: 50 } }])), /conflict/);
  assert.match(String(onList([{ sysid: 1, north: 1, patch: { lat_int: 5 } }])), /conflict/);
  assert.equal(onList([{ sysid: 1, patch: { param7: 50 } }]), true,
    'a position-field patch without offsets is legitimate');
});

test('selectionMode and executionMode red on membership, then on the Build pairing rules', () => {
  // §5's editor half: the runtime dispatches these tokens with affirmative
  // cases only, so a hand-edited stray must red at deploy — the audit's
  // `{mode: "lits"}` shape, on the config surface the editor owns.
  const defaults = loadNodeDefaults('mavlink-fanout');
  const sel = defaults.selectionMode.validate;
  const exec = defaults.executionMode.validate;

  for (const mode of ['all', 'list', 'filter']) {
    assert.equal(sel.call({ delivery: 'send' }, mode, {}), true, mode);
  }
  assert.match(String(sel.call({ delivery: 'send' }, 'lits', {})), /must be one of/);
  assert.match(String(sel.call({ delivery: 'build' }, 'nonsense', {})), /must be one of/,
    'membership reds before the Build rule is consulted');
  // The Build pairing rule still holds behind the membership check.
  assert.equal(sel.call({ delivery: 'build' }, 'list', {}), true);
  assert.match(String(sel.call({ delivery: 'build' }, 'all', {})), /explicit sysid list on Build/);

  assert.equal(exec.call({ delivery: 'send' }, 'sequential', {}), true);
  assert.equal(exec.call({ delivery: 'send' }, 'broadcast', {}), true);
  assert.match(String(exec.call({ delivery: 'send' }, 'parallel', {})), /must be one of/);
  assert.match(String(exec.call({ delivery: 'build' }, 'broadcast', {})), /All.*selection/);
  assert.equal(exec.call({ delivery: 'build' }, 'sequential', {}), true);
});

test('intervalMs and maxRetries: blank stays absent, present values carry range red rings', () => {
  // Blank rides through numberOption as absence so lib/fanout's own defaults
  // fire (blank ≠ 0 ≠ absent, Gitar #287); a present value is what the editor
  // owns — min="0" is not enforced on save.
  const defaults = loadNodeDefaults('mavlink-fanout');
  const interval = defaults.intervalMs.validate;
  const retries = defaults.maxRetries.validate;

  assert.equal(interval.call({}, '', {}), true, 'blank interval means the lib default');
  assert.equal(interval.call({}, 0, {}), true, '0 is a legitimate no-pause interval');
  assert.equal(interval.call({}, 250, {}), true);
  assert.match(String(interval.call({}, -100, {})), />= 0/, 'negative pacing reds');
  assert.match(String(interval.call({}, 'abc', {})), />= 0/);

  assert.equal(retries.call({}, '', {}), true, 'blank retries means the lib default');
  assert.equal(retries.call({}, 0, {}), true);
  assert.equal(retries.call({}, 3, {}), true);
  assert.match(String(retries.call({}, -1, {})), />= 0/);
  assert.match(String(retries.call({}, 1.5, {})), /whole number/, 'a fractional retry count reds');
});

test('concurrency is a bounded integer with a strictly-sequential default of 1', () => {
  assert.match(html, /concurrency:\s*\{[\s\S]*?value:\s*1/, 'concurrency defaults to 1');
  assert.match(html, /Number\.isInteger\(n\) && n >= 1/, 'validator requires an integer ≥ 1');
  assert.match(html, /id="node-input-concurrency"/, 'concurrency field exists in the template');
});

test('rows reshape by selection, execution, and delivery (§6)', () => {
  assert.match(html, /function refreshVisibility/, 'refreshVisibility drives the reshape');
  assert.match(
    html,
    /\$\('#row-fanout-members, #tip-fanout-members'\)\.toggle\(sel === 'list'\)/,
    'members table and its tip only for list selection'
  );
  assert.match(html, /\$\('#row-fanout-typeFilter'\)\.toggle\(sel === 'filter'\)/, 'type filter only for filter selection');
  assert.match(html, /\$\('#row-fanout-interval'\)\.toggle\(exec === 'sequential'\)/, 'interval only for sequential');
  assert.match(
    html,
    /\$\('#row-fanout-concurrency'\)\.toggle\(exec === 'sequential' && d === 'confirm'\)/,
    'concurrency only where confirm waits can overlap'
  );
  assert.match(html, /\$\('#row-fanout-timeout'\)\.toggle\(d === 'confirm'\)/, 'timeout only for confirm tier');
  assert.match(html, /\$\('#row-fanout-retries'\)\.toggle\(d === 'confirm'\)/, 'retries only for confirm tier');
  assert.match(
    html,
    /\$\('#row-fanout-identity'\)\.toggle\(d !== 'build'\)/,
    'identity row is hidden when delivery is build (source ids stamped at the wire)'
  );
  for (const handler of ['delivery', 'selectionMode', 'executionMode']) {
    assert.match(
      html,
      new RegExp(`#node-input-${handler}['"]\\)\\.on\\(['"]change['"],\\s*refreshVisibility\\)`),
      `${handler} change refreshes visibility`
    );
  }
});

test('delivery offers build, send, and send-and-confirm', () => {
  assert.match(html, /<option value="build">Build<\/option>/);
  assert.match(html, /<option value="send">Send<\/option>/);
  assert.match(html, /<option value="confirm">Send and confirm<\/option>/);
});

test('help documents the broadcast position gate and the setpoint stream lock (#245)', () => {
  assert.match(html, /broadcast position setpoint/i, 'the broadcast position gate is documented');
  assert.match(html, /msg\.confirmed/, 'the confirm escape is named');
  assert.match(html, /stream lock/i, 'the single-owner stream lock is documented');
  assert.match(html, /velocity\/acceleration-only/i, 'the velocity exemption is documented');
});

test('help documents targets patches as wire units and the mavlink-out handoff', () => {
  assert.match(html, /wire units/i, 'raw-surface unit rule is stated');
  assert.match(html, /mavlink-out/, 'Build handoff to mavlink-out is documented');
  assert.match(html, /\{message, targets/, 'wrapper shape is documented');
  assert.match(html, /offsets in <b>metres<\/b>/, 'member offsets are documented as metres');
  assert.match(html, /message's <i>own<\/i> position/, 'offsets apply against the message\'s own position');
  assert.match(html, /overrides the configured members entirely/, 'payload.targets precedence is documented');
});
