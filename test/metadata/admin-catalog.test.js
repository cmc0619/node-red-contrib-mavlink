'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  resolveCatalogSource,
  registerDialectCatalogRoute,
} = require('../../lib/metadata/admin-catalog');
const { resolveDialect } = require('../../lib/vehicle');

function apiStub(dialects = ['common', 'ardupilotmega']) {
  return {
    knownDialects: () => dialects,
  };
}

const XML = (body) => `<?xml version="1.0"?>\n<mavlink>${body}</mavlink>`;

test('resolveCatalogSource prefers a deployed vehicle bundle', () => {
  const bundle = { dialect: 'custom', messages: {} };
  const RED = {
    nodes: {
      getNode: (id) => (id === 'v1' ? { dialect: 'custom', getDialect: () => bundle } : null),
    },
  };
  const source = resolveCatalogSource(RED, apiStub(), { vehicle: 'v1' });
  assert.equal(source.kind, 'bundle');
  assert.equal(source.dialect, 'custom');
  assert.equal(source.bundle, bundle);
});

test('resolveCatalogSource serves a customDialectPath profile via getDialect()', () => {
  // Normal operating mode: deployed profile compiled from an absolute XML path.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mav-catalog-custom-'));
  const entry = path.join(dir, 'bench.xml');
  fs.writeFileSync(
    entry,
    XML(
      '<messages><message id="42" name="BENCH_MSG">' +
        '<field type="uint8_t" name="v">v</field></message></messages>'
    )
  );
  const bundle = resolveDialect({
    dialectSource: 'custom',
    customDialectPath: entry,
    dialectRevision: 'legacy-path',
  });
  const RED = {
    nodes: {
      getNode: (id) => (id === 'v-custom'
        ? { dialect: bundle.dialect, getDialect: () => bundle }
        : null),
    },
  };
  const source = resolveCatalogSource(RED, apiStub(), { vehicle: 'v-custom' });
  assert.equal(source.kind, 'bundle');
  assert.equal(source.bundle, bundle);
  assert.equal(source.dialect, 'bench');
  assert.ok(source.bundle.messages.BENCH_MSG);
});

test('resolveCatalogSource refuses missing vehicle without inventing a dialect', () => {
  const RED = { nodes: { getNode: () => null } };
  const source = resolveCatalogSource(RED, apiStub(), { vehicle: 'gone' });
  assert.equal(source.kind, 'error');
  assert.equal(source.status, 404);
  assert.equal(source.body.commands, undefined);
});

test('resolveCatalogSource soft mode returns a notice for undeployed vehicle', () => {
  const RED = { nodes: { getNode: () => null } };
  const source = resolveCatalogSource(RED, apiStub(), { vehicle: 'gone' }, { soft: true });
  assert.equal(source.kind, 'empty');
  assert.match(source.notice, /not deployed/i);
});

test('registerDialectCatalogRoute wires fromBundle / fromDialect', () => {
  const handlers = new Map();
  const RED = {
    nodes: {
      getNode: (id) => (id === 'v1'
        ? { dialect: 'custom', getDialect: () => ({ dialect: 'custom' }) }
        : null),
    },
    httpAdmin: {
      get(path, _auth, handler) { handlers.set(path, handler); },
    },
    auth: { needsPermission() { return () => {}; } },
    log: { error() {} },
  };
  registerDialectCatalogRoute(RED, {
    path: '/mavlink/test/catalog',
    logLabel: 'test',
    fromBundle: (_api, bundle, dialect) => ({ via: 'bundle', dialect, ok: !!bundle }),
    fromDialect: (_api, dialect) => ({ via: 'dialect', dialect }),
  });
  const handler = handlers.get('/mavlink/test/catalog');
  assert.ok(handler);

  const resBundle = {
    statusCode: 200,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; },
  };
  handler({ query: { vehicle: 'v1' } }, resBundle);
  assert.deepEqual(resBundle.body, { via: 'bundle', dialect: 'custom', ok: true });

  const resDialect = {
    statusCode: 200,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; },
  };
  handler({ query: { dialect: 'common' } }, resDialect);
  assert.deepEqual(resDialect.body, { via: 'dialect', dialect: 'common' });
});
