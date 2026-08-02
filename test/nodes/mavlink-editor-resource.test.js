'use strict';

/**
 * Shared editor helpers (resources/mavlink-editor.js) — the single home for the
 * catalog source matrix (resolveCatalogTarget), catalog fetch (loadCatalog),
 * Target CompID reload (reloadTargetCompId), the Build-tier dialect /
 * vehicle / firmware default descriptors (buildTierDialectDefaults), and the
 * Build-tier row toggle (applyBuildTierRowVisibility). Every palette node
 * delegates here (DESIGN.md §6), so the matrix behaviour is proven once against
 * the shared implementation rather than per node.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const resourceScript = fs.readFileSync(
  path.join(__dirname, '..', '..', 'resources', 'mavlink-editor.js'),
  'utf8'
);

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Minimal jQuery-ish stub: `$(selector).length` is 1 only when the selector was
 * given a value, and `.val()` returns it. Absent selectors report length 0 so
 * helpers fall back to the node snapshot (`this`) exactly as they do in the
 * editor before a dialog is open.
 *
 * @param {object} [values]
 * @param {object} [nodeLookup]
 * @param {{trackToggle?: boolean, getJSON?: Function}} [opts]
 */
function loadResource(values = {}, nodeLookup = {}, opts = {}) {
  const toggled = {};
  const trackToggle = opts.trackToggle === true;
  function $(selector) {
    const has = Object.prototype.hasOwnProperty.call(values, selector);
    return {
      // Toggle tracking registers the selector so applyBuildTierRowVisibility
      // sees a live row even when no .val() was seeded.
      length: has || trackToggle ? 1 : 0,
      val() {
        return has ? values[selector] : undefined;
      },
      toggle(shown) {
        toggled[selector] = !!shown;
        return this;
      },
    };
  }
  $.getJSON = opts.getJSON || function () {
    return { fail() { return this; } };
  };
  const context = {
    RED: {
      settings: { httpAdminRoot: '/' },
      mavlink: {},
      nodes: {
        node(id) {
          return nodeLookup[id] || null;
        },
      },
    },
    $,
    toggled,
  };
  vm.runInNewContext(resourceScript, context);
  return context;
}

// ── resolveCatalogTarget ─────────────────────────────────────────────────────

test('resolveCatalogTarget Build tier: a concrete dialect queries by name', () => {
  const { RED } = loadResource({ '#node-input-dialect': 'common' });
  assert.deepEqual(
    plain(RED.mavlink.resolveCatalogTarget({ isBuild: true })),
    { key: 'dialect:common', query: { dialect: 'common' }, dialect: 'common', vehicleId: '' }
  );
});

test('resolveCatalogTarget Build tier: an empty dialect never invents ardupilotmega', () => {
  const { RED } = loadResource({ '#node-input-dialect': '' });
  assert.deepEqual(
    plain(RED.mavlink.resolveCatalogTarget({ isBuild: true })),
    { key: 'empty', query: null, dialect: '', vehicleId: '' }
  );
});

test('resolveCatalogTarget Build tier: the __vehicle escape queries by profile id + dialect', () => {
  const { RED } = loadResource(
    { '#node-input-dialect': '__vehicle', '#node-input-vehicle': 'vehicle-1' },
    { 'vehicle-1': { dialect: 'ardupilotmega' } }
  );
  assert.deepEqual(
    plain(RED.mavlink.resolveCatalogTarget({ isBuild: true })),
    {
      key: 'vehicle:vehicle-1',
      query: { vehicle: 'vehicle-1', dialect: 'ardupilotmega' },
      dialect: 'ardupilotmega',
      vehicleId: 'vehicle-1',
    }
  );
});

test('resolveCatalogTarget Build tier: __vehicle without a profile resolves to empty', () => {
  const { RED } = loadResource({ '#node-input-dialect': '__vehicle', '#node-input-vehicle': '' });
  assert.deepEqual(
    plain(RED.mavlink.resolveCatalogTarget({ isBuild: true })),
    { key: 'empty', query: null, dialect: '', vehicleId: '' }
  );
});

test('resolveCatalogTarget wire tier: the connection bound profile is the catalog source', () => {
  const { RED } = loadResource(
    { '#node-input-connection': 'connection-1' },
    {
      'connection-1': { vehicle: { id: 'vehicle-1' } },
      'vehicle-1': { dialect: 'common' },
    }
  );
  assert.deepEqual(
    plain(RED.mavlink.resolveCatalogTarget({ isBuild: false })),
    {
      key: 'vehicle:vehicle-1',
      query: { vehicle: 'vehicle-1', dialect: 'common' },
      dialect: 'common',
      vehicleId: 'vehicle-1',
    }
  );
});

test('resolveCatalogTarget wire tier: no connection resolves to empty (no invented dialect)', () => {
  const { RED } = loadResource({ '#node-input-connection': '' });
  assert.deepEqual(
    plain(RED.mavlink.resolveCatalogTarget({ isBuild: false })),
    { key: 'empty', query: null, dialect: '', vehicleId: '' }
  );
});

test('resolveCatalogTarget derives Build from the delivery selector when isBuild is omitted', () => {
  const { RED } = loadResource({
    '#node-input-delivery': 'build',
    '#node-input-dialect': 'common',
  });
  assert.deepEqual(plain(RED.mavlink.resolveCatalogTarget().query), { dialect: 'common' });
});

test('resolveCatalogTarget falls back to the tier selector (Build node uses tier)', () => {
  const { RED } = loadResource({
    '#node-input-tier': 'build',
    '#node-input-dialect': 'common',
  });
  assert.deepEqual(plain(RED.mavlink.resolveCatalogTarget().query), { dialect: 'common' });
});

test('currentCatalogQuery Build tier also reads #node-input-tier (mavlink-build)', () => {
  // loadEnumsCatalog / CompID fills use currentCatalogQuery — if it only
  // checked #node-input-delivery, Build's target_component pulldown got no enums
  // (Codex #118).
  const { RED } = loadResource({
    '#node-input-tier': 'build',
    '#node-input-dialect': 'common',
  });
  assert.deepEqual(
    plain(RED.mavlink.currentCatalogQuery(['MAV_COMPONENT'])),
    { dialect: 'common', names: 'MAV_COMPONENT' }
  );
});

test('currentCatalogQuery prefers delivery over tier when both exist', () => {
  const { RED } = loadResource({
    '#node-input-delivery': 'send',
    '#node-input-tier': 'build',
    '#node-input-dialect': 'common',
    '#node-input-connection': 'conn-1',
  }, {
    'conn-1': { vehicle: 'vehicle-1' },
    'vehicle-1': { dialect: 'ardupilotmega' },
  });
  // Wire-tier via delivery — not Build dialect from the leftover tier control.
  assert.deepEqual(
    plain(RED.mavlink.currentCatalogQuery(['MAV_COMPONENT'])),
    { vehicle: 'vehicle-1', dialect: 'ardupilotmega', names: 'MAV_COMPONENT' }
  );
});

// ── buildTierDialectDefaults ─────────────────────────────────────────────────

test('buildTierDialectDefaults returns dialect + vehicle descriptors (no firmware by default)', () => {
  const { RED } = loadResource();
  const defaults = RED.mavlink.buildTierDialectDefaults();
  assert.deepEqual(Object.keys(defaults), ['dialect', 'vehicle']);
  assert.equal(defaults.dialect.value, '');
  assert.equal(defaults.vehicle.type, 'mavlink-vehicle');
  assert.equal(defaults.vehicle.value, '');
});

test('buildTierDialectDefaults dialect is required on Build only', () => {
  const { RED } = loadResource();
  const { dialect } = RED.mavlink.buildTierDialectDefaults();
  assert.equal(dialect.validate.call({ delivery: 'build' }, ''), false);
  assert.equal(dialect.validate.call({ delivery: 'build' }, 'common'), true);
  assert.equal(dialect.validate.call({ delivery: 'send' }, ''), true);
});

test('buildTierDialectDefaults vehicle is required only for Build + __vehicle', () => {
  const { RED } = loadResource();
  const { vehicle } = RED.mavlink.buildTierDialectDefaults();
  assert.equal(vehicle.validate.call({ delivery: 'build', dialect: '__vehicle' }, ''), false);
  assert.equal(vehicle.validate.call({ delivery: 'build', dialect: '__vehicle' }, 'veh-1'), true);
  assert.equal(vehicle.validate.call({ delivery: 'build', dialect: 'common' }, ''), true);
  assert.equal(vehicle.validate.call({ delivery: 'send', dialect: '__vehicle' }, ''), true);
});

test('buildTierDialectDefaults withFirmware adds the Firmware XOR validator (§6)', () => {
  const { RED } = loadResource();
  const defaults = RED.mavlink.buildTierDialectDefaults({ withFirmware: true });
  assert.deepEqual(Object.keys(defaults), ['dialect', 'vehicle', 'firmware']);
  const { firmware } = defaults;
  // Concrete Build dialect ⇒ firmware required.
  assert.equal(firmware.validate.call({ delivery: 'build', dialect: 'common' }, ''), false);
  assert.equal(firmware.validate.call({ delivery: 'build', dialect: 'common' }, 'ardupilot'), true);
  // __vehicle escape carries firmware from the profile ⇒ firmware not required.
  assert.equal(firmware.validate.call({ delivery: 'build', dialect: '__vehicle' }, ''), true);
  // Empty dialect (dialect validator already reds the node) ⇒ no second error.
  assert.equal(firmware.validate.call({ delivery: 'build', dialect: '' }, ''), true);
  // Wire tiers never require firmware.
  assert.equal(firmware.validate.call({ delivery: 'send', dialect: 'common' }, ''), true);
});

test('buildTierDialectDefaults honours modeField:tier for the Build node', () => {
  const { RED } = loadResource();
  const { dialect } = RED.mavlink.buildTierDialectDefaults({ modeField: 'tier' });
  assert.equal(dialect.validate.call({ tier: 'build' }, ''), false);
  assert.equal(dialect.validate.call({ tier: 'send' }, ''), true);
});

// ── applyBuildTierRowVisibility — the shared Build-tier row matrix ───────────

const VIS_ROWS = {
  dialectRow: '#row-dialect',
  vehicleRow: '#row-vehicle',
  firmwareRow: '#row-firmware',
  connectionRow: '#row-connection',
};

test('applyBuildTierRowVisibility Build + empty dialect: dialect only', () => {
  const { RED, toggled } = loadResource({}, {}, { trackToggle: true });
  RED.mavlink.applyBuildTierRowVisibility({
    isBuild: true,
    dialect: '',
    ...VIS_ROWS,
  });
  assert.equal(toggled['#row-dialect'], true);
  assert.equal(toggled['#row-vehicle'], false);
  assert.equal(toggled['#row-firmware'], false);
  assert.equal(toggled['#row-connection'], false);
});

test('applyBuildTierRowVisibility Build + __vehicle: dialect + vehicle', () => {
  const { RED, toggled } = loadResource({}, {}, { trackToggle: true });
  RED.mavlink.applyBuildTierRowVisibility({
    isBuild: true,
    dialect: '__vehicle',
    ...VIS_ROWS,
  });
  assert.equal(toggled['#row-dialect'], true);
  assert.equal(toggled['#row-vehicle'], true);
  assert.equal(toggled['#row-firmware'], false);
  assert.equal(toggled['#row-connection'], false);
});

test('applyBuildTierRowVisibility Build + concrete dialect: dialect + firmware', () => {
  const { RED, toggled } = loadResource({}, {}, { trackToggle: true });
  RED.mavlink.applyBuildTierRowVisibility({
    isBuild: true,
    dialect: 'common',
    ...VIS_ROWS,
  });
  assert.equal(toggled['#row-dialect'], true);
  assert.equal(toggled['#row-vehicle'], false);
  assert.equal(toggled['#row-firmware'], true);
  assert.equal(toggled['#row-connection'], false);
});

test('applyBuildTierRowVisibility wire tier: connection only', () => {
  const { RED, toggled } = loadResource({}, {}, { trackToggle: true });
  RED.mavlink.applyBuildTierRowVisibility({
    isBuild: false,
    dialect: 'common',
    ...VIS_ROWS,
  });
  assert.equal(toggled['#row-dialect'], false);
  assert.equal(toggled['#row-vehicle'], false);
  assert.equal(toggled['#row-firmware'], false);
  assert.equal(toggled['#row-connection'], true);
});

test('applyBuildTierRowVisibility skips absent optional firmwareRow', () => {
  const { RED, toggled } = loadResource({}, {}, { trackToggle: true });
  RED.mavlink.applyBuildTierRowVisibility({
    isBuild: true,
    dialect: 'common',
    dialectRow: '#row-dialect',
    vehicleRow: '#row-vehicle',
    connectionRow: '#row-connection',
  });
  assert.equal(toggled['#row-dialect'], true);
  assert.equal(toggled['#row-connection'], false);
  assert.equal(toggled['#row-firmware'], undefined);
});

// ── reloadTargetCompId — thin defaulting wrapper over reloadCompIdSelect ─────

test('reloadTargetCompId defaults to #node-input-targetComponent', () => {
  const { RED } = loadResource({ '#node-input-targetComponent': '' });
  const calls = [];
  RED.mavlink.reloadCompIdSelect = ($select, opts) => {
    calls.push({ length: $select.length, initialSaved: opts.initialSaved });
  };
  RED.mavlink.reloadTargetCompId({ targetComponent: 190 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].length, 1);
  assert.equal(calls[0].initialSaved, 190);
});

test('reloadTargetCompId honours Command\'s targetComponent field name', () => {
  const { RED } = loadResource({ '#node-input-targetComponent': '' });
  const calls = [];
  RED.mavlink.reloadCompIdSelect = (_$select, opts) => {
    calls.push(opts.initialSaved);
  };
  RED.mavlink.reloadTargetCompId({ targetComponent: 1 }, { field: 'targetComponent' });
  assert.deepEqual(calls, [1]);
});

// ── loadCatalog — resolve → getJSON → race guard ─────────────────────────────

test('loadCatalog empty target returns without fetching', () => {
  let fetched = 0;
  const { RED } = loadResource(
    { '#node-input-dialect': '' },
    {},
    {
      getJSON() {
        fetched += 1;
        return { fail() { return this; } };
      },
    }
  );
  const state = { value: null, seq: 0 };
  const got = [];
  RED.mavlink.loadCatalog('/mavlink/build/messages', state, (c) => got.push(c), {
    isBuild: true,
    listKey: 'messages',
  });
  assert.equal(fetched, 0);
  assert.equal(state.seq, 1);
  assert.deepEqual(plain(got[0]), { messages: [], enums: {}, dialect: '' });
  assert.deepEqual(plain(state.value), { messages: [], enums: {}, dialect: '' });
});

test('loadCatalog fetches for every nonempty call', () => {
  const pending = [];
  const { RED } = loadResource(
    { '#node-input-dialect': 'common' },
    {},
    {
      getJSON(_url, _query, ok) {
        pending.push(ok);
        return { fail() { return this; } };
      },
    }
  );
  const state = { value: null, seq: 0 };
  const got = [];
  RED.mavlink.loadCatalog('/mavlink/build/messages', state, (c) => got.push(c), {
    isBuild: true,
    listKey: 'messages',
  });
  RED.mavlink.loadCatalog('/mavlink/build/messages', state, (c) => got.push(c), {
    isBuild: true,
    listKey: 'messages',
  });
  assert.equal(pending.length, 2);
  pending[0]({ messages: [{ name: 'STALE' }], enums: {}, dialect: 'common' });
  assert.equal(got.length, 0);
  pending[1]({ messages: [{ name: 'HEARTBEAT' }], enums: {}, dialect: 'common' });
  assert.equal(got.length, 1);
  assert.equal(got[0].messages[0].name, 'HEARTBEAT');
});

test('loadCatalog seq-guard drops a stale success', () => {
  const values = { '#node-input-dialect': 'common' };
  const pending = [];
  const { RED } = loadResource(
    values,
    {},
    {
      getJSON(_url, _query, ok) {
        pending.push(ok);
        return { fail() { return this; } };
      },
    }
  );
  const state = { value: null, seq: 0 };
  const got = [];
  RED.mavlink.loadCatalog('/mavlink/build/messages', state, (c) => got.push(['a', c]), {
    isBuild: true,
    listKey: 'messages',
  });
  values['#node-input-dialect'] = 'ardupilotmega';
  RED.mavlink.loadCatalog('/mavlink/build/messages', state, (c) => got.push(['b', c]), {
    isBuild: true,
    listKey: 'messages',
  });
  assert.equal(pending.length, 2);
  pending[0]({ messages: [{ name: 'STALE' }], enums: {}, dialect: 'common' });
  assert.equal(got.length, 0);
  pending[1]({ messages: [{ name: 'OK' }], enums: {}, dialect: 'ardupilotmega' });
  assert.equal(got.length, 1);
  assert.equal(got[0][0], 'b');
  assert.equal(got[0][1].messages[0].name, 'OK');
});

// ── PAYLOAD_VERBS / refreshVerbOptions ───────────────────────────────────────

test('PAYLOAD_VERBS mirrors lib/payload exactly', () => {
  const { RED } = loadResource();
  const { PAYLOAD_VERBS } = require('../../lib/payload');
  assert.deepEqual(plain(RED.mavlink.PAYLOAD_VERBS), plain(PAYLOAD_VERBS));
});

/**
 * jQuery stub rich enough for refreshVerbOptions (empty/append/option factory).
 * @param {object} values
 * @returns {{RED: object, values: object, options: string[]}}
 */
function loadVerbResource(values) {
  const options = [];
  function $(selector) {
    if (typeof selector === 'string' && selector.startsWith('<option')) {
      const opt = { _val: '', _text: '' };
      opt.val = function (v) { opt._val = v; return opt; };
      opt.text = function (t) { opt._text = t; return opt; };
      return opt;
    }
    const has = Object.prototype.hasOwnProperty.call(values, selector);
    const api = {
      length: has ? 1 : 0,
      val(v) {
        if (arguments.length === 0) return has ? values[selector] : undefined;
        values[selector] = v;
        return api;
      },
      empty() { options.length = 0; return api; },
      append($el) { options.push($el._val); return api; },
    };
    return api;
  }
  $.getJSON = () => ({ fail() { return this; } });
  const context = {
    RED: {
      settings: { httpAdminRoot: '/' },
      mavlink: {},
      nodes: { node() { return null; } },
    },
    $,
  };
  vm.runInNewContext(resourceScript, context);
  return { RED: context.RED, values, options };
}

test('refreshVerbOptions rebuilds the verb select for the topic', () => {
  const { RED, values, options } = loadVerbResource({
    '#node-input-topic': 'servo',
    '#node-input-verb': 'set',
  });
  RED.mavlink.refreshVerbOptions();
  assert.deepEqual(options, ['set', 'repeat']);
  assert.equal(values['#node-input-verb'], 'set');
});

test('refreshVerbOptions prefers opts.saved when still valid', () => {
  const { RED, values } = loadVerbResource({
    '#node-input-topic': 'camera',
    '#node-input-verb': 'photo',
  });
  RED.mavlink.refreshVerbOptions({ saved: 'start-video' });
  assert.equal(values['#node-input-verb'], 'start-video');
});

// ── bitmask helpers ──────────────────────────────────────────────────────────

test('bitmaskTitle appends the Ctrl/Cmd-click hint', () => {
  const { RED } = loadResource();
  assert.equal(
    RED.mavlink.bitmaskTitle('Flags'),
    'Flags (Ctrl/Cmd-click to select multiple flags.)'
  );
  assert.match(RED.mavlink.bitmaskTitle(), /Bitmask flags/);
});

test('booleanEntryLabel maps FALSE/TRUE names to boolean words', () => {
  const { RED } = loadResource();
  assert.equal(RED.mavlink.booleanEntryLabel({ name: 'FALSE', label: 'FALSE (0)' }), 'false');
  assert.equal(RED.mavlink.booleanEntryLabel({ name: 'MAV_BOOL_TRUE', label: 'x' }), 'true');
  assert.equal(RED.mavlink.booleanEntryLabel({ name: 'OTHER', label: 'Other (2)' }), 'Other (2)');
});

test('selectedBitmaskValues returns the set flag values', () => {
  const { RED } = loadResource();
  const entries = [
    { value: 1 },
    { value: 2 },
    { value: 4 },
  ];
  // plain() crosses the vm realm boundary for deepStrictEqual.
  assert.deepEqual(plain(RED.mavlink.selectedBitmaskValues(5, entries)), ['1', '4']);
  assert.deepEqual(plain(RED.mavlink.selectedBitmaskValues('', entries)), []);
  assert.deepEqual(
    plain(RED.mavlink.selectedBitmaskValues(0, [{ value: 0 }, { value: 1 }])),
    ['0']
  );
});

// ── select title-sync + missing-option sentinel ──────────────────────────────

test('missingEnumOptionLabel is the single #N (not in dialect) wording', () => {
  const { RED } = loadResource();
  assert.equal(RED.mavlink.missingEnumOptionLabel(190), '#190 (not in dialect)');
  assert.equal(RED.mavlink.missingEnumOptionLabel('HEARTBEAT'), '#HEARTBEAT (not in dialect)');
});

test('ensureSavedEnumOption appends only when the value is absent', () => {
  const options = [];
  const context = {
    RED: { settings: { httpAdminRoot: '/' }, mavlink: {}, nodes: { node() { return null; } } },
    $: null,
  };
  const $select = {
    find() {
      return { length: options.some((o) => o.value === '190') ? 1 : 0 };
    },
    append($opt) {
      options.push({ value: $opt._val, text: $opt._text });
      return $select;
    },
  };
  context.$ = function (html) {
    if (typeof html === 'string' && html.startsWith('<option')) {
      const opt = { _val: '', _text: '' };
      opt.val = function (v) { opt._val = v; return opt; };
      opt.text = function (t) { opt._text = t; return opt; };
      return opt;
    }
    return { length: 0, val() { return undefined; } };
  };
  vm.runInNewContext(resourceScript, context);
  assert.equal(context.RED.mavlink.ensureSavedEnumOption($select, ''), false);
  assert.equal(context.RED.mavlink.ensureSavedEnumOption($select, 190), true);
  assert.equal(options[0].text, '#190 (not in dialect)');
  assert.equal(context.RED.mavlink.ensureSavedEnumOption($select, 190), false);
});

test('bindSelectTitleSync mirrors the selected option title onto the select', () => {
  let selectTitle = '';
  let changeHandler = null;
  const $select = {
    find() {
      return { attr() { return 'Dialect tip'; } };
    },
    attr(name, value) {
      if (name === 'title' && arguments.length > 1) selectTitle = value;
      return $select;
    },
    removeAttr() {
      selectTitle = '';
      return $select;
    },
    off() { return $select; },
    on(_evt, fn) { changeHandler = fn; return $select; },
  };
  const { RED } = loadResource();
  const sync = RED.mavlink.bindSelectTitleSync($select, { namespace: 'mavTestTip' });
  assert.equal(selectTitle, 'Dialect tip');
  assert.equal(typeof changeHandler, 'function');
  assert.equal(typeof sync, 'function');
});

test('refreshIdentitySelect reads the live connection and forwards rolesAllowed', () => {
  const calls = [];
  const values = {
    '#node-input-connection': 'conn-1',
    '#node-input-identity': 'id-1',
  };
  const { RED } = loadResource(values);
  RED.mavlink.fillIdentitySelect = ($select, connectionId, opts) => {
    calls.push({ connectionId, opts: plain(opts), length: $select.length });
    return 'id-1';
  };
  const selected = RED.mavlink.refreshIdentitySelect(
    { identity: 'id-1' },
    { rolesAllowed: ['gcs', 'custom'] }
  );
  assert.equal(selected, 'id-1');
  assert.equal(calls[0].connectionId, 'conn-1');
  assert.deepEqual(calls[0].opts, { saved: 'id-1', rolesAllowed: ['gcs', 'custom'] });
  assert.equal(calls[0].length, 1);
});

// ── BAND_OPTIONS + companion target visibility ───────────────────────────────

test('BAND_OPTIONS lists the five §7 queue bands once', () => {
  const { RED } = loadResource();
  assert.deepEqual(
    plain(RED.mavlink.BAND_OPTIONS.map((o) => o.value)),
    ['0', '1', '2', '3', '4']
  );
  assert.equal(RED.mavlink.BAND_OPTIONS[2].label, 'Control (2)');
});

test('fillBandSelect rebuilds options and restores the saved band', () => {
  const options = [];
  let selected;
  const $select = {
    empty() { options.length = 0; return $select; },
    append($opt) {
      options.push({ value: $opt._val, text: $opt._text });
      return $select;
    },
    val(v) {
      if (arguments.length) { selected = v; return $select; }
      return selected;
    },
  };
  const context = {
    RED: { settings: { httpAdminRoot: '/' }, mavlink: {}, nodes: { node() { return null; } } },
    $: function (html) {
      if (typeof html === 'string' && html.startsWith('<option')) {
        const opt = { _val: '', _text: '' };
        opt.val = function (v) { opt._val = v; return opt; };
        opt.text = function (t) { opt._text = t; return opt; };
        opt.appendTo = function (sel) { sel.append(opt); return opt; };
        return opt;
      }
      return $select;
    },
  };
  vm.runInNewContext(resourceScript, context);
  context.RED.mavlink.fillBandSelect($select, '3');
  assert.equal(options.length, 5);
  assert.equal(options[0].text, 'Emergency (0)');
  assert.equal(selected, '3');
});

test('applyCompanionTargetVisibility hides both rows for wire companion', () => {
  const toggles = {};
  const context = {
    RED: {
      settings: { httpAdminRoot: '/' },
      mavlink: {},
      nodes: {
        node(id) {
          return id === 'comp-1' ? { role: 'companion' } : null;
        },
      },
    },
    $(selector) {
      return {
        length: 1,
        toggle(shown) { toggles[selector] = !!shown; },
      };
    },
  };
  vm.runInNewContext(resourceScript, context);
  const vis = context.RED.mavlink.applyCompanionTargetVisibility({
    isBuild: false,
    identityId: 'comp-1',
    targetSystemRow: '#sys',
    targetComponentRow: '#comp',
  });
  assert.equal(vis.isCompanion, true);
  assert.equal(vis.targetSystem, false);
  assert.equal(vis.targetComponent, false);
  assert.equal(toggles['#sys'], false);
  assert.equal(toggles['#comp'], false);
});

test('applyCompanionTargetVisibility keeps payload compid when hideCompidWhenCompanion is false', () => {
  const { RED } = loadResource({}, {
    'comp-1': { role: 'companion' },
  });
  const vis = RED.mavlink.applyCompanionTargetVisibility({
    isBuild: false,
    identityId: 'comp-1',
    hideCompidWhenCompanion: false,
  });
  assert.equal(vis.targetSystem, false);
  assert.equal(vis.targetComponent, true);
});

test('applyCompanionTargetVisibility shows targets on Build regardless of identity', () => {
  const { RED } = loadResource({}, {
    'comp-1': { role: 'companion' },
  });
  const vis = RED.mavlink.applyCompanionTargetVisibility({
    isBuild: true,
    identityId: 'comp-1',
  });
  assert.equal(vis.isCompanion, false);
  assert.equal(vis.targetSystem, true);
  assert.equal(vis.targetComponent, true);
});

// ── normalizeIdentityIds — the Connection dialog's extra-identity rules ──────

test('normalizeIdentityIds drops blanks, duplicates, and the primary identity', () => {
  const { RED } = loadResource();
  assert.deepEqual(
    plain(RED.mavlink.normalizeIdentityIds(
      ['', 'id-2', 'id-1', 'id-2', null, undefined, 'id-3'],
      'id-1' // the primary — runtime binds it first; repeating it would
      //        register the same identity twice
    )),
    ['id-2', 'id-3']
  );
});

test('normalizeIdentityIds preserves dialog order of the survivors', () => {
  const { RED } = loadResource();
  assert.deepEqual(
    plain(RED.mavlink.normalizeIdentityIds(['id-c', 'id-a', 'id-b', 'id-a'], '')),
    ['id-c', 'id-a', 'id-b']
  );
});

test('normalizeIdentityIds tolerates absent input', () => {
  const { RED } = loadResource();
  assert.deepEqual(plain(RED.mavlink.normalizeIdentityIds(undefined, 'x')), []);
  assert.deepEqual(plain(RED.mavlink.normalizeIdentityIds([], 'x')), []);
});

// ── payloadVerbIgnoresCarrier — drift pin against lib/payload (§9) ───────────

test('payloadVerbIgnoresCarrier mirrors the lib recipe table exactly', () => {
  const { RED } = loadResource({});
  const { PAYLOAD_RECIPES } = require('../../lib/payload');
  // The editor-side predicate cannot require() the lib, so it hardcodes the
  // message-kind set. This pin fails the moment a recipe is added or changed
  // in lib/payload without updating the mirror (Codex #61 review).
  for (const [key, recipe] of Object.entries(PAYLOAD_RECIPES)) {
    const [topic, verb, path] = key.split('|');
    assert.equal(
      RED.mavlink.payloadVerbIgnoresCarrier(topic, verb, path || 'legacy'),
      recipe.kind === 'message',
      `${key}: editor predicate must match lib kind '${recipe.kind}'`
    );
  }
});
