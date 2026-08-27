'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(
  path.join(__dirname, '..', '..', 'nodes', 'mavlink-local-identity.html'),
  'utf8'
);
// Shared RED.mavlink.* helpers now live in the stock resource file; the Local
// Identity HTML loads it via <script src> and keeps only LI-specific code.
// Load the resource first so the LI script sees the helpers, exactly as the
// editor does (DESIGN.md §6).
const resourceScript = fs.readFileSync(
  path.join(__dirname, '..', '..', 'resources', 'mavlink-editor.js'),
  'utf8'
);
const script = html.match(/<script type="text\/javascript">([\s\S]*?)<\/script>/)[1];

class FakeOption {
  constructor() {
    this.value = '';
    this.label = '';
    this.attrs = {};
  }

  val(value) {
    if (value === undefined) return this.value;
    this.value = String(value);
    return this;
  }

  text(value) {
    if (value === undefined) return this.label;
    this.label = String(value);
    return this;
  }

  attr(name, value) {
    if (value === undefined) return this.attrs[name];
    this.attrs[name] = String(value);
    return this;
  }

  removeAttr(name) {
    delete this.attrs[name];
    return this;
  }
}

class FakeSelect {
  constructor(value, enforceOptions = false) {
    this.length = 1;
    this.options = [];
    this.selected = value || '';
    this.enforceOptions = enforceOptions;
    this.attrs = {};
    this.dataStore = {};
    this.triggered = [];
  }

  empty() {
    this.options = [];
    this.selected = '';
    return this;
  }

  append(option) {
    this.options.push(option);
    return this;
  }

  val(value) {
    if (value === undefined) return this.selected;
    const next = String(value);
    if (this.enforceOptions && !this.options.some((option) => option.value === next)) {
      this.selected = null;
    } else {
      this.selected = next;
    }
    return this;
  }

  attr(name, value) {
    if (value === undefined) return this.attrs[name];
    this.attrs[name] = String(value);
    return this;
  }

  removeAttr(name) {
    delete this.attrs[name];
    return this;
  }

  data(name, value) {
    if (value === undefined) return this.dataStore[name];
    this.dataStore[name] = value;
    return this;
  }

  off() {
    return this;
  }

  on() {
    return this;
  }

  // Row-visibility no-ops, so a test can drive oneditprepare end to end
  // rather than regex-matching its source.
  hide() {
    return this;
  }

  show() {
    return this;
  }

  toggle() {
    return this;
  }

  closest() {
    return this;
  }

  trigger(eventName) {
    this.triggered.push(eventName);
    return this;
  }

  find(selector) {
    if (selector === 'option') {
      return { length: this.options.length };
    }
    if (selector === 'option:selected') {
      const selected = this.options.find((option) => option.value === this.selected);
      return selected || {
        length: 0,
        attr() { return undefined; },
      };
    }
    const value = selector.match(/option\[value="([^"]*)"\]/)[1];
    return { length: this.options.some((option) => option.value === value) ? 1 : 0 };
  }
}

function loadHelpers(initialValues = {}, nodeLookup = {}) {
  const elements = new Map();
  let identityDefinition = null;

  function $(selector) {
    if (selector === '<option></option>' || selector === '<option>') {
      return new FakeOption();
    }
    if (!elements.has(selector)) {
      const enforceOptions = selector === '#node-config-input-sourceComponentId';
      const element = new FakeSelect(undefined, enforceOptions);
      if (initialValues[selector] !== undefined) {
        if (enforceOptions) {
          element.append(new FakeOption().val(initialValues[selector]));
        }
        element.val(initialValues[selector]);
      }
      elements.set(selector, element);
    }
    return elements.get(selector);
  }
  $.getJSON = function (url, query, cb) {
    if (typeof query === 'function') {
      cb = query;
      query = undefined;
    }
    $.lastRequest = { url, query };
    const data = $.responses[url] || { dialect: 'common', enums: { MAV_TYPE: [] } };
    if (cb) cb(data);
    return {
      fail() { return this; },
      done(doneCb) {
        doneCb(data);
        return this;
      },
    };
  };
  $.responses = {
    '/mavlink/dialects': { dialects: ['ardupilotmega', 'common'] },
    '/mavlink/enums': {
      dialect: 'common',
      enums: {
        MAV_COMPONENT: [
          { name: 'MAV_COMP_ID_AUTOPILOT1', value: 1, label: 'AUTOPILOT1 (1)' },
          { name: 'MAV_COMP_ID_MISSIONPLANNER', value: 190, label: 'MISSIONPLANNER (190)' },
        ],
      },
    },
  };

  const context = {
    RED: {
      settings: { httpAdminRoot: '/' },
      mavlink: {},
      nodes: {
        node(id) {
          return nodeLookup[id] || null;
        },
        registerType(type, definition) {
          if (type === 'mavlink-local-identity') {
            identityDefinition = definition;
          }
        },
      },
    },
    $,
  };
  const sandbox = vm.createContext(context);
  vm.runInContext(resourceScript, sandbox);
  vm.runInContext(script, sandbox);
  context.identityDefinition = identityDefinition;
  return context;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test('enumOptionLabel mirrors the server-side NAME (value) format', () => {
  const context = loadHelpers();

  assert.equal(
    context.RED.mavlink.enumOptionLabel({
      name: 'MAV_TYPE_GCS',
      value: 6,
      description: 'Ground control station.',
    }),
    'MAV_TYPE_GCS (6)'
  );
});

test('isFalseTrueEnum mirrors metadata false/true enum detection', () => {
  const context = loadHelpers();

  assert.equal(context.RED.mavlink.isFalseTrueEnum([
    { name: 'MAV_BOOL_FALSE', value: 0 },
    { name: 'MAV_BOOL_TRUE', value: 1 },
  ]), true);
  assert.equal(context.RED.mavlink.isFalseTrueEnum([
    { name: 'MAV_DO_REPOSITION_FLAGS_CHANGE_MODE', value: 1 },
    { name: 'MAV_DO_REPOSITION_FLAGS_RELATIVE_YAW', value: 2 },
  ]), false);
  assert.equal(context.RED.mavlink.isFalseTrueEnum(['FALSE', 'TRUE']), false);
  assert.equal(context.RED.mavlink.isFalseTrueEnum([]), false);
  assert.equal(context.RED.mavlink.isFalseTrueEnum([
    { name: 'GIMBAL_AXIS_CALIBRATION_REQUIRED_UNKNOWN', value: 0 },
    { name: 'GIMBAL_AXIS_CALIBRATION_REQUIRED_TRUE', value: 1 },
    { name: 'GIMBAL_AXIS_CALIBRATION_REQUIRED_FALSE', value: 2 },
  ]), false);
  assert.equal(context.RED.mavlink.isFalseTrueEnum([
    { name: 'FALSE', value: null },
    { name: 'TRUE', value: 1 },
  ]), false);
});

test('populateDialectSelect loads dialects, appends vehicle escape, and keeps empty unsaved selection', () => {
  // No `includeVehicleEscape` and no `onReady`: the escape is unconditional
  // (all six callers asked for it) and the callback had no caller at all, so
  // both options went with #221. Asserting on them here was the only thing
  // keeping them alive.
  const context = loadHelpers();
  const select = new FakeSelect();

  context.RED.mavlink.populateDialectSelect(select, {});

  assert.deepEqual(plain(context.$.lastRequest), {
    url: '/mavlink/dialects',
  });
  assert.deepEqual(
    select.options.map((option) => ({ value: option.value, label: option.label })),
    [
      { value: '', label: '\u2014' },
      { value: 'ardupilotmega', label: 'ardupilotmega' },
      { value: 'common', label: 'common' },
      { value: '__vehicle', label: 'from Vehicle Profile\u2026' },
    ]
  );
  assert.equal(select.selected, '');
  assert.deepEqual(select.triggered, ['change']);
});

test('reloadCompIdSelect uses initialSaved on first fill and preserves blank later', () => {
  const context = loadHelpers({
    '#node-input-delivery': 'build',
    '#node-input-dialect': 'development',
  });
  const select = new FakeSelect();

  context.RED.mavlink.reloadCompIdSelect(select, { initialSaved: 190 });
  assert.equal(select.val(), '190');
  assert.ok(select.options.some((option) => option.value === '190'));

  // User clears to "(profile default)".
  select.val('');
  context.RED.mavlink.reloadCompIdSelect(select, { initialSaved: 190 });
  assert.equal(select.val(), '', 'blank live selection is not replaced by initialSaved');
});

test('reloadCompIdSelect ignores stale catalog responses', () => {
  const context = loadHelpers({
    '#node-input-delivery': 'build',
    '#node-input-dialect': 'development',
  });
  const select = new FakeSelect();
  const callbacks = [];

  context.$.getJSON = function (url, query, cb) {
    if (typeof query === 'function') {
      cb = query;
      query = undefined;
    }
    callbacks.push({ url, query, cb });
    return { fail() { return this; } };
  };

  context.RED.mavlink.reloadCompIdSelect(select, { initialSaved: 1 });
  context.RED.mavlink.reloadCompIdSelect(select, { initialSaved: 1 });
  assert.equal(callbacks.length, 2);

  // Older response arrives last — must not overwrite the newer fill.
  callbacks[1].cb({
    dialect: 'common',
    enums: { MAV_COMPONENT: [{ name: 'MAV_COMP_ID_AUTOPILOT1', value: 1, label: 'AUTOPILOT1 (1)' }] },
  });
  assert.equal(select.val(), '1');
  const afterSecond = select.options.length;

  callbacks[0].cb({
    dialect: 'stale',
    enums: {
      MAV_COMPONENT: [
        { name: 'MAV_COMP_ID_MISSIONPLANNER', value: 190, label: 'MISSIONPLANNER (190)' },
      ],
    },
  });
  assert.equal(select.options.length, afterSecond, 'stale response did not refill the select');
  assert.equal(select.val(), '1');
});

test('populateDialectSelect pins saved dialect before the dialects GET returns', () => {
  const context = loadHelpers();
  const select = new FakeSelect();
  let sawPin = false;

  const originalGetJSON = context.$.getJSON;
  context.$.getJSON = function (url, query, cb) {
    if (typeof query === 'function') {
      cb = query;
      query = undefined;
    }
    // Before the async catalog callback, Build-tier enum fetches must already
    // see the saved dialect on the select (not an empty value).
    assert.equal(select.val(), 'development', 'saved dialect is pinned before dialects return');
    assert.equal(select.options.length, 1);
    sawPin = true;
    return originalGetJSON.call(this, url, query, cb);
  };

  context.RED.mavlink.populateDialectSelect(select, { saved: 'development' });

  assert.equal(sawPin, true);
  assert.equal(select.selected, 'development');
  assert.ok(select.options.some((option) => option.value === 'ardupilotmega'));
  assert.ok(select.options.some((option) => option.value === '__vehicle'));
});

test('populateDialectSelect re-selects saved dialect without defaulting unsaved dialogs', () => {
  const context = loadHelpers();
  const select = new FakeSelect();

  context.RED.mavlink.populateDialectSelect(select, { saved: 'common' });

  assert.equal(select.selected, 'common');
  assert.deepEqual(select.triggered, ['change']);
});

test('loadEnumsCatalog calls the shared enum route with a catalog source and comma names list', () => {
  const context = loadHelpers({
    '#node-input-delivery': 'build',
    '#node-input-dialect': 'common',
  });
  let payload = null;

  context.RED.mavlink.loadEnumsCatalog(['MAV_TYPE', 'MAV_COMPONENT'], (catalog) => {
    payload = catalog;
  });

  assert.deepEqual(plain(context.$.lastRequest), {
    url: '/mavlink/enums',
    query: { dialect: 'common', names: 'MAV_TYPE,MAV_COMPONENT' },
  });
  assert.equal(payload.dialect, 'common');
});

test('currentCatalogQuery on Build uses concrete dialect only and ignores stale vehicle', () => {
  const context = loadHelpers({
    '#node-input-delivery': 'build',
    '#node-input-dialect': 'common',
    '#node-input-vehicle': 'vehicle-1',
  }, {
    'vehicle-1': { dialect: 'ardupilotmega' },
  });

  assert.deepEqual(plain(context.RED.mavlink.currentCatalogQuery(['MAV_TYPE'])), {
    dialect: 'common',
    names: 'MAV_TYPE',
  });
});

test('currentCatalogQuery on Build with empty dialect does not invent ardupilotmega', () => {
  const context = loadHelpers({
    '#node-input-delivery': 'build',
    '#node-input-dialect': '',
    '#node-input-vehicle': 'vehicle-1',
  }, {
    'vehicle-1': { dialect: 'ardupilotmega' },
  });

  assert.deepEqual(plain(context.RED.mavlink.currentCatalogQuery()), {});
});

test('currentCatalogQuery on Build vehicle escape includes selected vehicle dialect when known', () => {
  const context = loadHelpers({
    '#node-input-delivery': 'build',
    '#node-input-dialect': '__vehicle',
    '#node-input-vehicle': 'vehicle-1',
  }, {
    'vehicle-1': { dialect: 'common' },
  });

  assert.deepEqual(plain(context.RED.mavlink.currentCatalogQuery()), {
    vehicle: 'vehicle-1',
    dialect: 'common',
  });
});

test('currentCatalogQuery on Build vehicle escape leaves query empty without a vehicle', () => {
  const context = loadHelpers({
    '#node-input-delivery': 'build',
    '#node-input-dialect': '__vehicle',
    '#node-input-vehicle': '',
  });

  assert.deepEqual(plain(context.RED.mavlink.currentCatalogQuery()), {});
});

test('currentCatalogQuery on wire tiers keeps the connection profile behavior', () => {
  const context = loadHelpers({
    '#node-input-delivery': 'send',
    '#node-input-connection': 'connection-1',
    '#node-input-dialect': 'development',
    '#node-input-vehicle': 'stale-vehicle',
  }, {
    'connection-1': { vehicle: { id: 'vehicle-1' } },
    'vehicle-1': { dialect: 'ardupilotmega' },
    'stale-vehicle': { dialect: 'common' },
  });

  assert.deepEqual(plain(context.RED.mavlink.currentCatalogQuery()), {
    vehicle: 'vehicle-1',
    dialect: 'ardupilotmega',
  });
});

test('currentCatalogQuery on wire tiers ignores stale own vehicle and dialect without a connection profile', () => {
  const context = loadHelpers({
    '#node-input-delivery': 'send',
    '#node-input-connection': '',
    '#node-input-dialect': 'development',
    '#node-input-vehicle': 'stale-vehicle',
  }, {
    'stale-vehicle': { dialect: 'common' },
  });

  assert.deepEqual(plain(context.RED.mavlink.currentCatalogQuery(['MAV_TYPE'])), {});
});

test('currentCatalogQuery uses config-node dialect for Vehicle Profile dialogs', () => {
  const context = loadHelpers({
    '#node-config-input-dialect': 'ardupilotmega',
  });

  assert.deepEqual(plain(context.RED.mavlink.currentCatalogQuery(['MAV_COMPONENT'])), {
    dialect: 'ardupilotmega',
    names: 'MAV_COMPONENT',
  });
});

test('loadEnumsCatalog accepts an explicit dialect override for Local Identity', () => {
  const context = loadHelpers();
  let payload = null;

  context.RED.mavlink.loadEnumsCatalog(['MAV_TYPE'], (catalog) => {
    payload = catalog;
  }, { cancelled: false }, { dialect: 'common' });

  assert.deepEqual(plain(context.$.lastRequest), {
    url: '/mavlink/enums',
    query: { dialect: 'common', names: 'MAV_TYPE' },
  });
  assert.equal(payload.dialect, 'common');
});

test('fillEnumSelect writes numeric string values and re-selects saved entries', () => {
  const context = loadHelpers();
  const select = new FakeSelect();

  context.RED.mavlink.fillEnumSelect(
    select,
    [
      { name: 'MAV_TYPE_GENERIC', value: 0, label: 'MAV_TYPE_GENERIC (0)' },
      { name: 'MAV_TYPE_GCS', value: 6, label: 'MAV_TYPE_GCS (6)' },
    ],
    { allowEmpty: true, emptyLabel: 'Any type', saved: 6 }
  );

  assert.deepEqual(
    select.options.map((option) => ({ value: option.value, label: option.label })),
    [
      { value: '', label: 'Any type' },
      { value: '0', label: 'MAV_TYPE_GENERIC (0)' },
      { value: '6', label: 'MAV_TYPE_GCS (6)' },
    ]
  );
  assert.equal(select.selected, '6');
  assert.deepEqual(select.triggered, ['change']);
});

test('fillEnumSelect seeds a saved CompID before dialect labels arrive', () => {
  const context = loadHelpers();
  const select = new FakeSelect();

  context.RED.mavlink.fillCompIdSelect(select, [], { saved: 190 });

  assert.equal(select.selected, '190');
  assert.equal(select.options.length, 1);
  assert.equal(select.options[0].value, '190');
  assert.match(select.options[0].label, /not in dialect/);
  assert.deepEqual(select.triggered, ['change']);
});

test('fillCompIdSelect allows an empty filter option', () => {
  const context = loadHelpers();
  const select = new FakeSelect();

  context.RED.mavlink.fillCompIdSelect(
    select,
    [{ name: 'MAV_COMP_ID_AUTOPILOT1', value: 1, label: 'MAV_COMP_ID_AUTOPILOT1 (1)' }],
    { allowEmpty: true, emptyLabel: 'Any component', saved: '' }
  );

  assert.deepEqual(
    select.options.map((option) => ({ value: option.value, label: option.label })),
    [
      { value: '', label: 'Any component' },
      { value: '1', label: 'MAV_COMP_ID_AUTOPILOT1 (1)' },
    ]
  );
  assert.equal(select.selected, '');
});

test('identity oneditprepare loads MAV_TYPE by enum name, not numeric value', () => {
  assert.match(
    html,
    /fillEnumSelect\(\$hbType[\s\S]*valueKey:\s*'name'/
  );
  assert.match(html, /saved:\s*\$hbType\.val\(\)\s*\|\|\s*node\.heartbeatType/);
  assert.match(html, /saved:\s*\$hbAp\.val\(\)\s*\|\|\s*node\.heartbeatAutopilot/);
  assert.match(html, /saved:\s*\$compid\.val\(\)\s*\|\|\s*node\.sourceComponentId/);
});

test('companion keeps its CompID row — only SysID is derived', () => {
  // SysID genuinely comes from the vehicle, so that row hides. CompID is a
  // choice of four onboard-computer slots, so it stays (§14.135: a control
  // with something to decide is not noise).
  assert.match(
    html,
    /\$sysid\.closest\('\.form-row'\)\.toggle\(!isCompanion\)/,
    'the derived SysID row still hides for companion'
  );
  assert.doesNotMatch(
    html,
    /\$compid\.closest\('\.form-row'\)\.toggle\(!isCompanion\)/,
    'the CompID row must no longer hide for companion'
  );
  assert.doesNotMatch(
    html,
    /CompID<\/b> is fixed at/,
    'the note must stop claiming CompID is fixed'
  );
});

test('oneditsave clears only the derived SysID — the CompID is the operator\'s', () => {
  // The runtime reads sourceComponentId in every role now, so blanking it on
  // save would reach the wire as component 0 (Number('') === 0) and the
  // operator's chosen onboard slot would never persist.
  const save = html.slice(html.indexOf('oneditsave: function'));
  const body = save.slice(0, save.indexOf('oneditcancel'));
  assert.match(
    body,
    /\$\('#node-config-input-sourceSystemId'\)\.val\(''\)/,
    'the derived SysID is still cleared'
  );
  assert.doesNotMatch(
    body,
    /node-config-input-sourceComponentId/,
    'the CompID must survive the save'
  );
});

test('a companion saved behind the hidden row is seeded back to its own slot', () => {
  // The upgrade path. While the CompID row was hidden the dialog saved the
  // field's untouched default (190) and the runtime discarded it for a pinned
  // 191. Now that the runtime reads what was saved, opening the dialog must
  // seed the role's slot back, or a companion silently becomes component 190.
  assert.doesNotMatch(
    html,
    /seededCompId|ROLE_PRESETS\.gcs\.compid/,
    'no open-time CompID seeding — 190 is a legal companion slot, and inferring '
      + '"never chosen" from the value is the shim pre-1.0 forbids'
  );
});

test('the role floats its own components to the top of the CompID select', () => {
  // The Payload topic hint, applied to roles: suggested, never filtered, so
  // every component stays reachable in all three roles.
  assert.match(
    html,
    /compIdSuggest:\s*'ONBOARD_COMPUTER'/,
    'companion suggests the four onboard-computer slots'
  );
  assert.match(html, /compIdSuggest:\s*'MISSIONPLANNER'/, 'gcs suggests 190');
  assert.match(html, /custom:[^\n]*compIdSuggest:\s*''/, 'custom names none — flat list');
  assert.match(
    html,
    /suggest:\s*preset\(\$role\.val\(\)\)\.compIdSuggest/,
    'the fill passes the current role\'s hint'
  );
  // One place owns the fill, and it fetches MAV_COMPONENT itself so a role
  // change repaints from a fresh catalog rather than a held copy.
  assert.match(html, /function refillCompIds\(desired\)/, 'a single repaint owns the select');
  assert.match(
    html,
    /function refillCompIds\(desired\)[\s\S]*?RED\.mavlink\.loadEnumsCatalog\(\['MAV_COMPONENT'\]/,
    'the fill owns its own fetch'
  );
  // No sequence counter: enumLoadToken already drops responses that land
  // after the dialog closed, and ordering two fetches inside one open dialog
  // would need the role select changed twice inside a localhost round trip.
  assert.doesNotMatch(html, /compIdRefresh/, 'no ordering guard for an unreachable race');
  assert.match(html, /enumLoadToken/, 'the reachable case stays covered by the close token');
  assert.doesNotMatch(html, /compIdEntries/, 'no held catalog survives');
  assert.match(
    html,
    /refillCompIds\(pickedCompId\);\s*\n\s*applyVisibility\(role\)/,
    'a role change repaints the suggestions, carrying its new pick'
  );
  // Switching role before the catalog lands leaves the select empty, where
  // `.val()` sets nothing — the repaint must not then fall back to the
  // pre-switch saved id.
  // Component 0 is MAV_COMP_ID_ALL, so the pick is tested for null, not
  // truthiness.
  assert.match(
    html,
    /desired === null \|\| desired === undefined/,
    'the role\'s own pick outranks the empty select, zero included'
  );
});

test('identity oneditprepare seeds CompID before async enum catalog', () => {
  // Sync seed must appear before loadEnumsCatalog so post-prepare validation
  // sees the saved numeric CompID while MAV_COMPONENT is still loading.
  const seedIdx = html.indexOf("fillCompIdSelect($compid, [],");
  const loadIdx = html.indexOf("loadEnumsCatalog(['MAV_COMPONENT']");
  assert.ok(seedIdx !== -1, 'sync CompID seed');
  assert.ok(loadIdx !== -1, 'async enum load');
  assert.ok(seedIdx < loadIdx, 'seed before async catalog');
  // Async fills re-fire change so a pre-fill input-error clears — the shared
  // fillEnumSelect helper (resource file) owns that trigger now.
  assert.match(resourceScript, /\$select\.trigger\('change'\)/);
});

test('adminApiUrl respects a non-root httpAdminRoot', () => {
  const context = loadHelpers();
  context.RED.settings.httpAdminRoot = '/red';
  assert.equal(context.RED.mavlink.adminApiUrl('/mavlink/enums'), '/red/mavlink/enums');
});

test('loadEnumsCatalog ignores responses after the dialog token is cancelled', () => {
  const context = loadHelpers();
  let calls = 0;
  const token = { cancelled: true };
  context.RED.mavlink.loadEnumsCatalog(['MAV_TYPE'], () => {
    calls += 1;
  }, token);
  assert.equal(calls, 0);
});

test('loadEnumsCatalog returns empty catalog locally when no dialect or vehicle is available', () => {
  const context = loadHelpers();
  let payload = null;
  context.RED.mavlink.loadEnumsCatalog(['MAV_TYPE'], (catalog) => {
    payload = catalog;
  });
  assert.equal(context.$.lastRequest, undefined, 'must not GET /mavlink/enums with {}');
  assert.deepEqual(plain(payload), { dialect: '', enums: {} });
});

test('heartbeatIntervalMs red-rings blank and non-positive values (walled garden)', () => {
  // The runtime opens the heartbeat timer at this value as saved (§0), and
  // Number('') is 0 — a zero-interval timer. The 1000 default belongs to the
  // dialog, so blank reds instead of silently meaning "1 Hz".
  const context = loadHelpers();
  const { heartbeatIntervalMs } = context.identityDefinition.defaults;
  assert.equal(heartbeatIntervalMs.validate.length, 2, 'two args, or a reason string reads as valid (§14)');
  const validate = (v) => heartbeatIntervalMs.validate.call({}, v, {});

  assert.equal(validate(1000), true);
  assert.equal(validate('250'), true);
  assert.match(String(validate('')), /positive number/, 'blank reds — the default is the dialog’s');
  assert.match(String(validate(0)), /positive number/, 'a zero-interval timer reds');
  assert.match(String(validate(-5)), /positive number/);
  assert.match(String(validate('abc')), /positive number/);
});

test('reopening a companion never retypes its saved CompID', () => {
  // 190 is a legal companion CompID. A seed that rewrote it to 191 on open
  // would silently change an identity the operator picked — and inferring
  // "this value was never chosen" from the value itself is the migration shim
  // the pre-1.0 rule forbids. The dialog shows what was saved, in both cases.
  for (const saved of [190, 192]) {
    const context = loadHelpers({ '#node-config-input-role': 'companion' });
    context.$.responses['/mavlink/enums'] = {
      dialect: 'common',
      enums: {
        MAV_COMPONENT: [
          { name: 'MAV_COMP_ID_MISSIONPLANNER', value: 190, label: 'MISSIONPLANNER (190)' },
          { name: 'MAV_COMP_ID_ONBOARD_COMPUTER', value: 191, label: 'ONBOARD_COMPUTER (191)' },
          { name: 'MAV_COMP_ID_ONBOARD_COMPUTER2', value: 192, label: 'ONBOARD_COMPUTER2 (192)' },
        ],
      },
    };

    context.identityDefinition.oneditprepare.call({
      id: 'c', role: 'companion', sourceComponentId: saved, heartbeatIntervalMs: 1000,
    });

    assert.equal(
      context.$('#node-config-input-sourceComponentId').val(),
      String(saved),
      `companion saved on ${saved} reopens on ${saved}`
    );
  }
});

test('Companion save clears the derived SysID and keeps the chosen CompID', () => {
  const context = loadHelpers({
    '#node-config-input-role': 'companion',
    '#node-config-input-sourceSystemId': '255',
    '#node-config-input-sourceComponentId': '190',
  });
  const node = {
    role: 'gcs',
    sourceSystemId: 255,
    sourceComponentId: 190,
  };

  context.identityDefinition.oneditsave.call(node);

  // Node-RED copies editor values to the node after oneditsave returns.
  node.role = context.$('#node-config-input-role').val();
  node.sourceSystemId = context.$('#node-config-input-sourceSystemId').val();
  const sourceComponentId = context.$('#node-config-input-sourceComponentId').val();
  if (sourceComponentId != null) {
    node.sourceComponentId = sourceComponentId;
  }

  assert.equal(node.role, 'companion');
  assert.equal(node.sourceSystemId, '', 'SysID is derived, so a leftover value goes');
  // The runtime reads this in every role. Blanking it would arrive as
  // Number('') === 0 — component 0, MAV_COMP_ID_ALL — instead of the slot the
  // operator picked.
  assert.equal(node.sourceComponentId, '190', 'the CompID survives the save');
});
