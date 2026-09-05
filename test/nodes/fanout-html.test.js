'use strict';

/**
 * Fan-out editor: replicator controls only — no embedded action editor (§10).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadNodeDefaults, loadNodeType } = require('./html-assert');

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
    /RED\.mavlink\.loadEnumsCatalog\(\['MAV_TYPE'\]/,
    'MAV_TYPE loads via the name-filtered enums fetch, not the full message catalog'
  );
  assert.doesNotMatch(
    html,
    /\/mavlink\/build\/messages/,
    'the full Build message catalog must not be fetched for one enum table'
  );
  assert.match(html, /enums\.MAV_TYPE/, 'MAV_TYPE table is read from the catalog');
  assert.match(
    html,
    /RED\.mavlink\.loadEnumsCatalog\(\['MAV_TYPE'\][\s\S]*?enumLoadToken, \{ isBuild: false \}\)/,
    'the MAV_TYPE call itself carries isBuild: false — resolution stays wire-side, Fan-out has no dialect row'
  );
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

test('admin catalog fetches go through the shared loaders (httpAdminRoot-safe)', () => {
  assert.match(html, /RED\.mavlink\.loadEnumsCatalog\(/, 'catalog fetches use the shared enums loader');
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
  // One spelling of the filter: the select fill and the row's visibility test
  // must ask the same question, so both read the hoisted constant.
  assert.match(
    html,
    /const IDENTITY_ROLES = \[\s*['"]gcs['"]\s*,\s*['"]custom['"]\s*\];/,
    'the gcs+custom filter is named once'
  );
  assert.match(
    html,
    /RED\.mavlink\.refreshIdentitySelect\(node,\s*\{\s*rolesAllowed:\s*IDENTITY_ROLES\s*\}\)/,
    'shared refreshIdentitySelect is called with that filter'
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
    /#node-input-connection['"]\)\.on\(['"]change['"][^{]*\{([\s\S]*?)\}/
  );
  assert.ok(
    changeHandlerMatch && /refreshIdentitySelect/.test(changeHandlerMatch[0]),
    'refreshIdentitySelect is called inside the connection change handler'
  );
});

test('members table replaces the sysids CSV: editableList rows saved through oneditsave (#163)', () => {
  assert.ok(!html.includes('node-input-sysids'), 'the sysids CSV field is gone — pre-1.0 rename, no alias');
  assert.match(html, /\$members\.editableList\(/, 'rows use the stock editableList widget');
  assert.match(html, /oneditsave\(\)/, 'a custom widget must save through oneditsave');
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

test('members validation reads the open editable-list value', () => {
  // Node-RED validates before oneditsave. A bad current row therefore has to
  // reach the descriptor through its bound control instead of hiding behind
  // the prior saved member list.
  const defaults = loadNodeDefaults('mavlink-fanout', {}, {
    dom: {
      '#node-input-selectionMode': { val: 'list' },
      '#node-input-members': { val: ['{"sysid":0}'] },
    },
    editStack: [{ id: 'fanout-1' }],
  });
  assert.match(
    String(defaults.members.validate.call(
      { id: 'fanout-1', selectionMode: 'list', members: [{ sysid: 1 }] },
      [{ sysid: 1 }],
      {}
    )),
    /sysid must be an integer 1-255/,
    'the current invalid row owns the red ring'
  );
});

test('oneditsave removes the members mirror so the properties pane finds nothing to copy', () => {
  // Node-RED's save order is oneditsave first, then the properties pane
  // copies every surviving #node-input-* field's val() over the node
  // property. The mirror's val() is the rows as JSON strings, so a mirror
  // that outlived oneditsave would replace the object array oneditsave just
  // stored. This runs the save and checks the mirror is gone; the pane
  // itself is Node-RED's code and is not replayed here — its skip of a
  // property whose input matches nothing is read from editor-client 5.0.4
  // (panes/properties.js apply: `input.val()` on an empty match is
  // undefined, and `newValue != null` bails).
  const dom = {
    '#mav-fanout-members': {
      rows: [{
        '.mav-fanout-member-sysid': '7',
        '.mav-fanout-member-north': '',
        '.mav-fanout-member-east': '',
        '.mav-fanout-member-up': '',
        '.mav-fanout-member-patch': '',
      }],
    },
    '#node-input-members': { val: ['{"sysid":7}'] },
  };
  const def = loadNodeType('mavlink-fanout', {}, { dom });
  const node = {};
  def.oneditsave.call(node);
  // Field-by-field: the rows are built inside the editor script's realm, so
  // a deep-equal would fail on the foreign Object prototype, not the data.
  assert.equal(node.members.length, 1, 'one live row saves as one member');
  assert.equal(node.members[0].sysid, 7, 'saved members are the live rows as objects');
  assert.ok(!('#node-input-members' in dom),
    'the mirror is gone, which is what the pane collection that runs next depends on');
});

test('addItem syncs the mirror so an untouched new row cannot dodge validation', () => {
  // A freshly added row has fired no field handler, so without a sync inside
  // addItem the validator judges the pre-add mirror while oneditsave reads
  // the live rows — an untouched blank row would save as sysid 0, a
  // broadcast member the red ring never saw.
  const start = html.indexOf('addItem(container, _index, member) {');
  assert.ok(start >= 0, 'members editableList must define addItem');
  let i = html.indexOf('{', start) + 1;
  let depth = 1;
  while (i < html.length && depth > 0) {
    const c = html[i++];
    if (c === '{') depth += 1;
    else if (c === '}') depth -= 1;
  }
  assert.ok(html.slice(start, i).includes('syncMembers();'),
    'addItem must sync the mirror before the new row can reach oneditsave unvalidated');
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

test('intervalMs and maxRetries: blank reds, present values carry range red rings', () => {
  // The editor owns the default (`value:`); a blank has no runtime reading
  // and cannot be saved — min="0" is not enforced on save, so the ring is.
  const defaults = loadNodeDefaults('mavlink-fanout');
  const interval = defaults.intervalMs.validate;
  const retries = defaults.maxRetries.validate;
  // The shared ack fields ring on Send & confirm, the tier whose rows show.
  const confirm = { delivery: 'confirm' };

  assert.match(String(interval.call({}, '', {})), />= 0/, 'blank interval reds');
  assert.equal(interval.call({}, 0, {}), true, '0 is a legitimate no-pause interval');
  assert.equal(interval.call({}, 250, {}), true);
  assert.match(String(interval.call({}, -100, {})), />= 0/, 'negative pacing reds');
  assert.match(String(interval.call({}, 'abc', {})), />= 0/);

  assert.match(String(retries.call(confirm, '', {})), />= 0/, 'blank retries reds');
  assert.equal(retries.call(confirm, 0, {}), true);
  assert.equal(retries.call(confirm, 3, {}), true);
  assert.match(String(retries.call(confirm, -1, {})), />= 0/);
  assert.match(String(retries.call(confirm, 1.5, {})), /whole number/, 'a fractional retry count reds');
  assert.equal(retries.call({ delivery: 'send' }, 1.5, {}), true, 'a hidden row never reds');
});

test('concurrency is a bounded integer with a strictly-sequential default of 1', () => {
  assert.match(html, /concurrency:\s*\{[\s\S]*?value:\s*1/, 'concurrency defaults to 1');
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
    /\$\('#row-fanout-identity'\)\.toggle\(\s*d !== 'build'\s*&& RED\.mavlink\.hasIdentityChoice\([\s\S]*?IDENTITY_ROLES\)\s*\)/,
    'identity row hides on Build, and on any Connection offering under two eligible identities'
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

test('help documents the setpoint stream lock (#245)', () => {
  assert.match(html, /stream lock/i, 'the single-owner stream lock is documented');
  assert.doesNotMatch(html, /msg\.confirmed/, 'the confirm escape is gone');
});

test('help documents targets patches as wire units and the mavlink-out handoff', () => {
  assert.match(html, /wire units/i, 'raw-surface unit rule is stated');
  assert.match(html, /mavlink-out/, 'Build handoff to mavlink-out is documented');
  assert.match(html, /\{message, targets/, 'wrapper shape is documented');
  assert.match(html, /offsets in <b>metres<\/b>/, 'member offsets are documented as metres');
  assert.match(html, /message's <i>own<\/i> position/, 'offsets apply against the message\'s own position');
  assert.match(html, /overrides the configured members entirely/, 'payload.targets precedence is documented');
});

test('fan-out filter vocabularies carry rings; blank stays "Any" (walled-garden sweep)', () => {
  const defaults = loadNodeDefaults('mavlink-fanout');

  assert.equal(defaults.vehicleType.validate.call({}, '', {}), true, 'blank type is Any');
  assert.equal(defaults.vehicleType.validate.call({}, '2', {}), true, 'a MAV_TYPE numeric value');
  assert.match(String(defaults.vehicleType.validate.call({}, 'quad', {})), /between 0 and 255/,
    'the select saves numbers — a stray token matches no vehicle, silently');

  for (const v of ['', 'ardupilot', 'px4', 'custom']) {
    assert.equal(defaults.firmwareFilter.validate.call({}, v, {}), true, v || 'blank');
  }
  assert.match(String(defaults.firmwareFilter.validate.call({}, 'betaflight', {})), /must be one of/);

  for (const v of ['', 'true', 'false']) {
    assert.equal(defaults.armedFilter.validate.call({}, v, {}), true, v || 'blank');
  }
  assert.match(String(defaults.armedFilter.validate.call({}, 'yes', {})), /must be one of/);
});

test('fan-out numeric validators declare two args and render reasons (§14.24)', () => {
  const defaults = loadNodeDefaults('mavlink-fanout');
  assert.equal(defaults.concurrency.validate.length, 2);
  assert.match(String(defaults.concurrency.validate.call({}, 0, {})), />= 1/);
  assert.equal(defaults.timeoutMs.validate.length, 2);
  assert.match(String(defaults.timeoutMs.validate.call({ delivery: 'confirm' }, 0, {})), />= 1/);
});
