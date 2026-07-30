'use strict';

/**
 * Shared editor helpers (resources/mavlink-editor.js) — the single home for the
 * catalog source matrix (resolveCatalogTarget) and the Build-tier dialect /
 * vehicle / firmware default descriptors (buildTierDialectDefaults). Every
 * palette node delegates here (DESIGN.md §6), so the matrix behaviour is proven
 * once against the shared implementation rather than per node.
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
 */
function loadResource(values = {}, nodeLookup = {}) {
  function $(selector) {
    const has = Object.prototype.hasOwnProperty.call(values, selector);
    return {
      length: has ? 1 : 0,
      val() {
        return has ? values[selector] : undefined;
      },
    };
  }
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
