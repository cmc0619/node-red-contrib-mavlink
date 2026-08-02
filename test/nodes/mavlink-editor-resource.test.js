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

test('reloadTargetCompId honours Command\'s targetCompid field name', () => {
  const { RED } = loadResource({ '#node-input-targetCompid': '' });
  const calls = [];
  RED.mavlink.reloadCompIdSelect = (_$select, opts) => {
    calls.push(opts.initialSaved);
  };
  RED.mavlink.reloadTargetCompId({ targetCompid: 1 }, { field: 'targetCompid' });
  assert.deepEqual(calls, [1]);
});

// ── loadCatalog — resolve → cache → getJSON → race guard ─────────────────────

test('loadCatalog empty target caches and returns without fetching', () => {
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
  const cache = { byKey: {}, seq: 0 };
  const got = [];
  RED.mavlink.loadCatalog('/mavlink/build/messages', cache, (c) => got.push(c), {
    isBuild: true,
    listKey: 'messages',
  });
  assert.equal(fetched, 0);
  assert.equal(cache.seq, 1);
  assert.deepEqual(plain(got[0]), { messages: [], enums: {}, dialect: '' });
  assert.deepEqual(plain(cache.byKey.empty), { messages: [], enums: {}, dialect: '' });
});

test('loadCatalog cache hit bumps seq and skips getJSON', () => {
  let fetched = 0;
  const { RED } = loadResource(
    { '#node-input-dialect': 'common' },
    {},
    {
      getJSON() {
        fetched += 1;
        return { fail() { return this; } };
      },
    }
  );
  const cache = {
    byKey: { 'dialect:common': { messages: [{ name: 'HEARTBEAT' }], enums: {}, dialect: 'common' } },
    seq: 0,
  };
  const got = [];
  RED.mavlink.loadCatalog('/mavlink/build/messages', cache, (c) => got.push(c), {
    isBuild: true,
    listKey: 'messages',
  });
  assert.equal(fetched, 0);
  assert.equal(cache.seq, 1);
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
  const cache = { byKey: {}, seq: 0 };
  const got = [];
  RED.mavlink.loadCatalog('/mavlink/build/messages', cache, (c) => got.push(['a', c]), {
    isBuild: true,
    listKey: 'messages',
  });
  values['#node-input-dialect'] = 'ardupilotmega';
  RED.mavlink.loadCatalog('/mavlink/build/messages', cache, (c) => got.push(['b', c]), {
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

test('loadCatalog coalesce fans out waiters for the same key', () => {
  let fetches = 0;
  let okHandler;
  const { RED } = loadResource(
    { '#node-input-dialect': 'common' },
    {},
    {
      getJSON(_url, _query, ok) {
        fetches += 1;
        okHandler = ok;
        return { fail() { return this; } };
      },
    }
  );
  const cache = { byKey: {}, seq: 0, inflight: {} };
  const got = [];
  RED.mavlink.loadCatalog('/mavlink/command/commands', cache, (c) => got.push(c), {
    isBuild: true,
    listKey: 'commands',
  });
  RED.mavlink.loadCatalog('/mavlink/command/commands', cache, (c) => got.push(c), {
    isBuild: true,
    listKey: 'commands',
  });
  assert.equal(fetches, 1, 'same-key consumers share one XHR');
  okHandler({ commands: [{ value: 400 }], enums: {}, dialect: 'common' });
  assert.equal(got.length, 2);
  assert.equal(got[0].commands[0].value, 400);
  assert.equal(Object.keys(cache.inflight).length, 0);
});

test('loadCatalog coalesce drops waiters when resolve key moved', () => {
  let okHandler;
  const values = { '#node-input-dialect': 'common' };
  const { RED } = loadResource(
    values,
    {},
    {
      getJSON(_url, _query, ok) {
        okHandler = ok;
        return { fail() { return this; } };
      },
    }
  );
  const cache = { byKey: {}, seq: 0, inflight: {} };
  const got = [];
  RED.mavlink.loadCatalog('/mavlink/command/commands', cache, (c) => got.push(c), {
    isBuild: true,
    listKey: 'commands',
  });
  values['#node-input-dialect'] = 'ardupilotmega';
  okHandler({ commands: [{ value: 400 }], enums: {}, dialect: 'common' });
  // Catalog is cached, but waiters are dropped because the live target moved.
  assert.equal(got.length, 0);
  assert.ok(cache.byKey['dialect:common']);
  assert.equal(Object.keys(cache.inflight).length, 0);
});

test('loadCatalog onKey fires for cache hit and empty target', () => {
  const { RED } = loadResource({ '#node-input-dialect': '' });
  const keys = [];
  const cache = { byKey: {}, seq: 0 };
  RED.mavlink.loadCatalog('/mavlink/build/messages', cache, () => {}, {
    isBuild: true,
    listKey: 'messages',
    onKey: (k) => keys.push(k),
  });
  assert.deepEqual(keys, ['empty']);
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
