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
      // liveOr consults the edit stack to decide whether the live DOM speaks
      // for the node under validation (#217). Default: nothing being edited.
      editor: { getEditStack: () => opts.editStack || [] },
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
    {
      key: 'dialect:common',
      query: { dialect: 'common' },
      dialect: 'common',
      vehicleId: '',
      firmware: '',
      vehicleFamily: '',
    }
  );
});

test('resolveCatalogTarget Build tier: an empty dialect never invents ardupilotmega', () => {
  const { RED } = loadResource({ '#node-input-dialect': '' });
  assert.deepEqual(
    plain(RED.mavlink.resolveCatalogTarget({ isBuild: true })),
    { key: 'empty', query: null, dialect: '', vehicleId: '', firmware: '', vehicleFamily: '' }
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
      key: 'vehicle:vehicle-1|ardupilotmega||',
      query: { vehicle: 'vehicle-1', dialect: 'ardupilotmega' },
      dialect: 'ardupilotmega',
      vehicleId: 'vehicle-1',
      firmware: '',
      vehicleFamily: '',
    }
  );
});

test('resolveCatalogTarget Build tier: __vehicle without a profile resolves to empty', () => {
  const { RED } = loadResource({ '#node-input-dialect': '__vehicle', '#node-input-vehicle': '' });
  assert.deepEqual(
    plain(RED.mavlink.resolveCatalogTarget({ isBuild: true })),
    { key: 'empty', query: null, dialect: '', vehicleId: '', firmware: '', vehicleFamily: '' }
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
      key: 'vehicle:vehicle-1|common||',
      query: { vehicle: 'vehicle-1', dialect: 'common' },
      dialect: 'common',
      vehicleId: 'vehicle-1',
      firmware: '',
      vehicleFamily: '',
    }
  );
});

test('resolveCatalogTarget wire tier: no connection resolves to empty (no invented dialect)', () => {
  const { RED } = loadResource({ '#node-input-connection': '' });
  assert.deepEqual(
    plain(RED.mavlink.resolveCatalogTarget({ isBuild: false })),
    { key: 'empty', query: null, dialect: '', vehicleId: '', firmware: '', vehicleFamily: '' }
  );
});

test('resolveCatalogTarget: live fields and saved config resolve to the same key', () => {
  const fields = {
    '#node-input-delivery': 'build',
    '#node-input-dialect': 'ardupilotmega',
    '#node-input-firmware': 'ardupilot',
  };
  const { RED } = loadResource(fields);

  // The keyed definition cache is only sound because a dialog's load and a
  // closed node's `validate` land on the same entry. They read different
  // places — the DOM and the saved config — so this is the load-bearing case.
  assert.equal(
    RED.mavlink.resolveCatalogTarget().key,
    RED.mavlink.resolveCatalogTarget({
      source: { delivery: 'build', dialect: 'ardupilotmega', firmware: 'ardupilot' },
    }).key
  );
});

test('resolveCatalogTarget: firmware is a definition axis, and only when present', () => {
  const withFirmware = loadResource({
    '#node-input-dialect': 'ardupilotmega',
    '#node-input-firmware': 'px4',
  }).RED.mavlink.resolveCatalogTarget({ isBuild: true });
  const without = loadResource({
    '#node-input-dialect': 'ardupilotmega',
  }).RED.mavlink.resolveCatalogTarget({ isBuild: true });

  // Same dialect, different firmware: PX4 and ArduPilot document RC1_MIN with
  // different bounds, so one key may never serve both.
  assert.equal(withFirmware.key, 'dialect:ardupilotmega|px4');
  assert.equal(withFirmware.query.firmware, 'px4');
  // Dialogs without the field keep their original key and query untouched.
  assert.equal(without.key, 'dialect:ardupilotmega');
  assert.deepEqual(plain(without.query), { dialect: 'ardupilotmega' });
});

test('resolveCatalogTarget: an undeployed profile answers from the editor-side node', () => {
  const { RED } = loadResource(
    { '#node-input-dialect': '__vehicle', '#node-input-vehicle': 'vehicle-1' },
    { 'vehicle-1': { dialect: 'ardupilotmega', firmware: 'ardupilot', vehicleFamily: 'copter' } }
  );
  const target = RED.mavlink.resolveCatalogTarget({ isBuild: true });

  // `RED.nodes.getNode` on the runtime side sees deployed config nodes only,
  // so the profile's own metadata has to travel with its id.
  assert.deepEqual(plain(target.query), {
    vehicle: 'vehicle-1',
    dialect: 'ardupilotmega',
    firmware: 'ardupilot',
    vehicleFamily: 'copter',
  });
  // …and join the key, or editing an undeployed profile keeps serving the
  // catalog the previous value loaded.
  assert.equal(target.key, 'vehicle:vehicle-1|ardupilotmega|ardupilot|copter');
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
  assert.deepEqual(Object.keys(defaults), ['dialect', 'connection', 'vehicle']);
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
  assert.deepEqual(Object.keys(defaults), ['dialect', 'connection', 'vehicle', 'firmware']);
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
  const state = { seq: 0 };
  const got = [];
  RED.mavlink.loadCatalog('/mavlink/build/messages', state, (c) => got.push(c), {
    isBuild: true,
    listKey: 'messages',
  });
  assert.equal(fetched, 0);
  assert.equal(state.seq, 1);
  assert.deepEqual(plain(got[0]), { messages: [], enums: {}, dialect: '' });
  assert.equal(Object.hasOwn(state, 'value'), false, 'loader returns the catalog only through its callback');
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
  const state = { seq: 0 };
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
  const state = { seq: 0 };
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

test('bitmaskFromSelection folds a multi-select back into one number', () => {
  const { RED } = loadResource();
  const fold = RED.mavlink.bitmaskFromSelection;

  // Round-trips its own inverse above.
  assert.equal(fold(['1', '4']), 5);
  // jQuery hands back a bare string for one selection and null for none —
  // the normalisation each caller used to spell out for itself.
  assert.equal(fold('4'), 4);
  assert.equal(fold(null), null);
  assert.equal(fold([]), null);
  // Null, not 0, so a caller can tell "nothing selected" from a zero fold.
  assert.equal(fold(['0']), 0);
  // BigInt, because `|` wraps above 2^31 and dialect bitmasks go there.
  assert.equal(fold(['2147483648', '1']), 2147483649);
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

/**
 * `loadResource`'s `$` answers selectors only — booleanEnumInput builds an
 * element and chains against it, so these tests supply a recording element.
 * Deliberately local: the shared stub stays minimal for everything else.
 */
function loadResourceWithElements() {
  function element() {
    const attrs = {};
    const props = {};
    const api = {
      addClass() { return api; },
      css() { return api; },
      attr(k, v) {
        if (v === undefined) return attrs[k];
        attrs[k] = String(v);
        return api;
      },
      prop(k, v) {
        if (v === undefined) return props[k];
        props[k] = v;
        return api;
      },
      is(sel) { return sel === ':checked' ? !!props.checked : false; },
    };
    return api;
  }
  const $ = () => element();
  $.getJSON = () => ({ fail() { return this; } });
  const context = { RED: { settings: {}, mavlink: {}, nodes: { node: () => null } }, $ };
  vm.runInNewContext(resourceScript, context);
  return context.RED;
}

test('booleanEnumInput renders a checkbox carrying the dialect true value', () => {
  const RED = loadResourceWithElements();
  const entries = [
    { name: 'MAV_BOOL_FALSE', value: 0 },
    { name: 'MAV_BOOL_TRUE', value: 1 },
  ];

  const off = RED.mavlink.booleanEnumInput(entries, { saved: 0, className: 'param-input' });
  const on = RED.mavlink.booleanEnumInput(entries, { saved: 1, className: 'param-input' });
  const unset = RED.mavlink.booleanEnumInput(entries, { saved: '', className: 'param-input' });

  assert.equal(off.attr('data-kind'), 'boolean');
  // The true value comes from the entry, never a baked 1.
  assert.equal(off.attr('data-true'), '1');
  assert.equal(off.prop('checked'), false);
  assert.equal(on.prop('checked'), true);
  assert.equal(unset.prop('checked'), false, 'a never-set param reads as off');
});

test('a non-boolean enum is not turned into a checkbox', () => {
  const RED = loadResourceWithElements();
  // Two entries, but not the FALSE/TRUE pair — must stay a pulldown.
  assert.equal(RED.mavlink.isFalseTrueEnum([
    { name: 'MAV_FRAME_GLOBAL', value: 0 },
    { name: 'MAV_FRAME_LOCAL_NED', value: 1 },
  ]), false);
});

test('the magic-boolean table is audited, not a general prose parser', () => {
  const RED = loadResourceWithElements();
  // Only MAV_CMD_COMPONENT_ARM_DISARM param2 qualifies (DESIGN.md §14).
  assert.equal(RED.mavlink.magicBooleanValue(400, 2), 21196);
  assert.equal(RED.mavlink.magicBooleanValue(400, 1), null, 'param1 has a real enum');
  // Target Camera ID params mention 255 in prose but are sentinels on a
  // numeric id, not booleans — they must not be swept in.
  assert.equal(RED.mavlink.magicBooleanValue(2000, 1), null);
  assert.equal(Object.keys(RED.mavlink.MAGIC_BOOLEAN_PARAMS).length, 1);
});

test('booleanEnumInput accepts an explicit true value for a no-enum param', () => {
  const RED = loadResourceWithElements();
  const forced = RED.mavlink.booleanEnumInput([], { saved: 21196, trueValue: 21196 });
  assert.equal(forced.attr('data-true'), '21196');
  assert.equal(forced.prop('checked'), true);
  assert.equal(RED.mavlink.booleanEnumValue(forced), 21196);
  const off = RED.mavlink.booleanEnumInput([], { saved: 0, trueValue: 21196 });
  assert.equal(RED.mavlink.booleanEnumValue(off), 0, 'unchecked is 0, never absent');
});

test('a checkbox always writes a value — unchecked is false, not missing', () => {
  const RED = loadResourceWithElements();
  // A command param resolves absent to 0, but a generic message field does
  // not: lib/codec/message.js skips names the values object lacks, so an
  // omitted field leaves the wire entirely. One behaviour for both.
  const entries = [
    { name: 'MAV_BOOL_FALSE', value: 0 },
    { name: 'MAV_BOOL_TRUE', value: 1 },
  ];
  assert.equal(RED.mavlink.booleanEnumValue(RED.mavlink.booleanEnumInput(entries, { saved: 1 })), 1);
  assert.equal(RED.mavlink.booleanEnumValue(RED.mavlink.booleanEnumInput(entries, { saved: 0 })), 0);
  assert.equal(
    RED.mavlink.booleanEnumValue(RED.mavlink.booleanEnumInput(entries, {})),
    0,
    'never rendered before → still false, not absent'
  );
});


test('splitCompIdsByTopic suggests components the dialect names after the device', () => {
  const { RED } = loadResource();
  const { loadBundled } = require('../../lib/metadata');
  const entries = loadBundled('ardupilotmega').enums.MAV_COMPONENT.entries;

  // No table: payload topics are device names, so upstream's own naming does
  // the work. Counts are the dialect's, not ours.
  const counts = {};
  for (const topic of ['camera', 'gimbal', 'winch', 'parachute', 'gripper']) {
    counts[topic] = RED.mavlink.splitCompIdsByTopic(entries, topic).suggested.length;
  }
  assert.deepEqual(counts, { camera: 6, gimbal: 7, winch: 1, parachute: 1, gripper: 0 });

  // Suggesting is not filtering — every component stays reachable.
  for (const topic of ['camera', 'gripper', '']) {
    const split = RED.mavlink.splitCompIdsByTopic(entries, topic);
    assert.equal(
      split.suggested.length + split.others.length,
      entries.length,
      `${topic || '(none)'} must not drop components`
    );
  }

  // A topic the dialect knows nothing about suggests nothing rather than
  // collapsing the list to zero choices.
  assert.deepEqual(RED.mavlink.splitCompIdsByTopic(entries, 'gripper').others, entries);
});

// ── validateIntRange ─────────────────────────────────────────────────────────

test('validateIntRange refuses what the wire field cannot encode', () => {
  const { RED } = loadResource();
  // param_index is int16_t and -1 is the protocol's "use the name" sentinel.
  const index = RED.mavlink.validateIntRange(-1, 32767);

  assert.equal(index(-1), true, 'the by-name sentinel');
  assert.equal(index(0), true, 'the first real index');
  assert.equal(index(32767), true, 'the field ceiling');
  assert.equal(index(''), true, 'blank is inherit/optional, as elsewhere');

  assert.match(String(index(-5)), /between -1 and 32767/, 'no such index');
  assert.match(String(index(99999)), /between -1 and 32767/, 'past int16');
  assert.match(String(index(2.5)), /integer/, 'the field is integral');
});

test('validateUint8 keeps its own name and bounds through the shared range check', () => {
  const { RED } = loadResource();
  const id = RED.mavlink.validateUint8(1);
  assert.equal(id(1), true);
  assert.equal(id(255), true);
  assert.match(String(id(0)), /between 1 and 255/, 'a source id may not be 0');
  assert.match(String(id(256)), /between 1 and 255/);
});

// ── PARAM_TYPE_OPTIONS ───────────────────────────────────────────────────────

test('PARAM_TYPE_OPTIONS mirrors the codec table it copies', () => {
  const { RED } = loadResource();
  const { PARAM_TYPES } = require('../../lib/codec/param-union');

  // Same set, same numbers. The editor copy exists only because browser HTML
  // cannot require() the module; drifting from it would offer a type the codec
  // refuses to encode, or hide one it accepts.
  const fromCodec = Object.entries(PARAM_TYPES)
    .map(([value, info]) => ({ name: info.name, value: Number(value) }))
    .sort((a, b) => a.value - b.value);
  // `plain` first: the options are built inside the VM realm, so a structural
  // comparison against Node-side objects fails on prototype identity alone.
  const fromEditor = plain(RED.mavlink.PARAM_TYPE_OPTIONS)
    .map((o) => ({ name: o.name, value: o.value }))
    .sort((a, b) => a.value - b.value);

  assert.deepEqual(fromEditor, fromCodec);
});

test('PARAM_TYPE_OPTIONS omits the widths the codec cannot encode', () => {
  const { RED } = loadResource();
  // MAV_PARAM_TYPE also has REAL64 / INT64 / UINT64. Offering them would offer
  // a choice that fails at send.
  const names = RED.mavlink.PARAM_TYPE_OPTIONS.map((o) => o.name);
  for (const absent of ['MAV_PARAM_TYPE_REAL64', 'MAV_PARAM_TYPE_INT64', 'MAV_PARAM_TYPE_UINT64']) {
    assert.equal(names.includes(absent), false, `${absent} is not encodable`);
  }
  assert.equal(names[0], 'MAV_PARAM_TYPE_REAL32', 'the field default leads the list');
});

// ── isBlank / liveOr / toggleRow / fillEnumSelect precedence ─────────────────

test('isBlank is one spelling of "nothing was entered"', () => {
  const { RED } = loadResource();
  for (const blank of [undefined, null, '', '   ', '\t\n']) {
    assert.equal(RED.mavlink.isBlank(blank), true, JSON.stringify(blank));
  }
  // 0 and false are values, not absences — an optional numeric field that
  // treated 0 as blank would silently drop a legal sysid or index.
  for (const filled of [0, false, '0', 'x', -1]) {
    assert.equal(RED.mavlink.isBlank(filled), false, JSON.stringify(filled));
  }
});

test('liveOr: the live field speaks only for the node whose dialog is on top (#217)', () => {
  const self = { id: 'n1' };

  // Own dialog on top of the edit stack: the live field wins — the operator
  // may have just changed it and not saved.
  const own = loadResource({ '#node-input-action': 'set' }, {}, { editStack: [self] }).RED;
  assert.equal(own.mavlink.liveOr(self, '#node-input-action', 'read'), 'set',
    'the live field wins while the node\'s own dialog is open');

  // Somebody else's dialog on top: the same DOM value is a lie about this
  // node. Node-RED's config-save cascade validates every user of the config
  // node before its tray closes, so this state is real, not theoretical.
  const foreign = loadResource({ '#node-input-action': 'set' }, {}, { editStack: [{ id: 'other' }] }).RED;
  assert.equal(foreign.mavlink.liveOr(self, '#node-input-action', 'read'), 'read',
    'a foreign dialog\'s live value must not leak into this node\'s validation');

  // Stacked trays: own dialog present but no longer on top (a config dialog
  // opened above it) — the top dialog's DOM is the one jQuery finds first,
  // so only the top-of-stack owner may read live.
  const buried = loadResource({ '#node-input-action': 'set' }, {}, { editStack: [self, { id: 'cfg' }] }).RED;
  assert.equal(buried.mavlink.liveOr(self, '#node-input-action', 'read'), 'read',
    'a buried dialog does not own the live DOM');

  // Dialog closed: the selector matches nothing, which is the state Node-RED
  // runs `validate` in on import and on deploy.
  const closed = loadResource().RED;
  assert.equal(closed.mavlink.liveOr(self, '#node-input-action', 'read'), 'read',
    'the saved value carries it');
  assert.equal(closed.mavlink.liveOr(self, '#node-input-action', undefined, 'read'), 'read',
    'and the fallback carries it when nothing was ever saved');
  assert.equal(closed.mavlink.liveOr(self, '#node-input-action', undefined), '');

  // A field that exists but is empty is not an answer either.
  const empty = loadResource({ '#node-input-action': '' }, {}, { editStack: [self] }).RED;
  assert.equal(empty.mavlink.liveOr(self, '#node-input-action', 'read'), 'read');

  // No owner (or an owner without an id) can never read live — fail closed.
  assert.equal(own.mavlink.liveOr(null, '#node-input-action', 'read'), 'read');
  assert.equal(own.mavlink.liveOr({}, '#node-input-action', 'read'), 'read');
});

test('toggleRow tolerates a row the dialog does not have', () => {
  const { RED } = loadResource({}, {}, { trackToggle: true });
  assert.doesNotThrow(() => RED.mavlink.toggleRow('#row-not-here', true));
  assert.doesNotThrow(() => RED.mavlink.toggleRow('', true));
  assert.doesNotThrow(() => RED.mavlink.toggleRow(undefined, false));
});

test('fillEnumSelect: preferLive decides which value survives a refill', () => {
  const { makeDom } = require('../helpers/fake-dom');
  const { installEditorHelpers } = require('../helpers/editor-resource');
  const ENTRIES = [
    { name: 'ALPHA', value: 1 },
    { name: 'BRAVO', value: 2 },
    { name: 'CHARLIE', value: 3 },
  ];

  /**
   * @param {string} live     what the operator has already picked
   * @param {*} saved         the node's pre-edit value
   * @param {boolean} preferLive
   * @returns {string} the selection after the refill
   */
  function refill(live, saved, preferLive) {
    const { $ } = makeDom({ '#sel': live });
    const context = { RED: { settings: { httpAdminRoot: '/' } }, $ };
    installEditorHelpers(context);
    const $sel = $('#sel');
    context.RED.mavlink.fillEnumSelect($sel, ENTRIES, {
      saved, preferLive, valueKey: 'value', triggerChange: false,
    });
    return $sel.val();
  }

  // The default is right for a one-time fill in oneditprepare: the saved value
  // is what the node means, and the select has not been touched yet.
  assert.equal(refill('3', 2, false), '2', 'saved wins by default');
  // An async refill lands after the operator has moved the select. Snapping it
  // back to the pre-edit value discards a choice they already made.
  assert.equal(refill('3', 2, true), '3', 'preferLive keeps the in-progress pick');
  // Nothing in progress: preferLive changes nothing.
  assert.equal(refill('', 2, true), '2');
  // Nothing saved either: the first entry, as before.
  assert.equal(refill('', undefined, true), '1');
});

// ── shared Connection descriptor ─────────────────────────────────────────────

test('buildTierDialectDefaults connection is required on wire tiers, never on Build', () => {
  const { RED } = loadResource({}, { live: { valid: true } });
  const { connection } = RED.mavlink.buildTierDialectDefaults();

  // Build sends nothing, so a blank Connection is the correct configuration —
  // this is the false positive the bare `{value, type}` declaration produced.
  assert.equal(connection.validate.call({ delivery: 'build' }, ''), true);
  assert.equal(connection.validate.call({ delivery: 'build' }, '_ADD_'), true);

  // Wire tiers require one. The screenshot case: Connection set to "none" on a
  // send tier must stay flagged.
  assert.equal(typeof connection.validate.call({ delivery: 'confirm' }, ''), 'string');
  assert.equal(typeof connection.validate.call({ delivery: 'confirm' }, '_ADD_'), 'string');
  assert.equal(connection.validate.call({ delivery: 'confirm' }, 'live'), true);
});

test('buildTierDialectDefaults connection restates the config-node reference check', () => {
  // Declaring any validate suppresses Node-RED's built-in reference check, so
  // the descriptor has to carry it or a deleted Connection stops being flagged.
  const { RED } = loadResource({}, { live: { valid: true }, broken: { valid: false } });
  const { connection } = RED.mavlink.buildTierDialectDefaults();

  assert.equal(connection.validate.call({ delivery: 'send' }, 'live'), true);
  assert.match(connection.validate.call({ delivery: 'send' }, 'deleted'), /no longer exists/);
  assert.match(connection.validate.call({ delivery: 'send' }, 'broken'), /not properly configured/);
});

test('buildTierDialectDefaults connection validator declares (v, opt)', () => {
  // Arity 2 is what makes Node-RED treat a returned string as an invalid
  // reason; a one-arg version coerces it with !! and every failure reads as
  // valid (§14 "One-arg editor validators treat an error string as valid").
  const { RED } = loadResource();
  assert.equal(RED.mavlink.buildTierDialectDefaults().connection.validate.length, 2);
});

test('buildTierDialectDefaults connection follows the Build node tier field', () => {
  const { RED } = loadResource();
  const { connection } = RED.mavlink.buildTierDialectDefaults({ modeField: 'tier' });
  assert.equal(connection.validate.call({ tier: 'build' }, ''), true);
  assert.equal(typeof connection.validate.call({ tier: 'send' }, ''), 'string');
});

test('buildTierDialectDefaults vehicle carries no required key (it would skip validate)', () => {
  // `required: false` beside a validate short-circuits an empty value to valid
  // before the validator runs, which left the Build + __vehicle rule dead.
  const { RED } = loadResource();
  const { vehicle, connection } = RED.mavlink.buildTierDialectDefaults();
  assert.equal(Object.prototype.hasOwnProperty.call(vehicle, 'required'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(connection, 'required'), false);
});
