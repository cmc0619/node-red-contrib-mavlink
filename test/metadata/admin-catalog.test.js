'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveCatalogSource,
  registerDialectCatalogRoute,
} = require('../../lib/metadata/admin-catalog');

test('resolveCatalogSource prefers a deployed vehicle bundle', () => {
  const bundle = { dialect: 'custom', messages: {} };
  const RED = {
    nodes: {
      getNode: (id) => (id === 'v1' ? { dialect: 'custom', getDialect: () => bundle } : null),
    },
  };
  const source = resolveCatalogSource(RED, { vehicle: 'v1' });
  assert.equal(source.dialect, 'custom');
  assert.equal(source.bundle, bundle);
});

test('resolveCatalogSource answers null for an undeployed vehicle without inventing a dialect', () => {
  const RED = { nodes: { getNode: () => null } };
  assert.equal(resolveCatalogSource(RED, { vehicle: 'gone' }), null);
  assert.equal(resolveCatalogSource(RED, { vehicle: 'gone', dialect: 'common' }).dialect, 'common',
    'an explicit ?dialect= beside it still resolves');
});

test('registerDialectCatalogRoute serves a deployed profile and a bundled dialect through one builder', () => {
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
    fromBundle: (bundle, dialect) => ({ via: 'bundle', dialect, ok: Boolean(bundle) }),
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
  assert.deepEqual(resDialect.body, { via: 'bundle', dialect: 'common', ok: true });

  const resGone = {
    statusCode: 200,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; },
  };
  handler({ query: { vehicle: 'gone' } }, resGone);
  assert.equal(resGone.statusCode, 404, 'an undeployed profile is a 404, never a guessed dialect');
  assert.ok(resGone.body.dialects.includes('common'), 'the 404 lists the bundled dialects');
});
