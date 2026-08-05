'use strict';

const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const canonicalArduPilotPdef = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'apm.pdef-canonical.json'),
  'utf8'
));

/**
 * A fetch response carrying `obj` as UTF-8 JSON bytes. The downloader reads
 * `arrayBuffer()` rather than `json()` so it can sniff the magic number first —
 * PX4 serves an XZ archive under `Content-Type: application/json`, so bytes are
 * the only honest signal.
 */
function jsonResponse(obj) {
  return {
    ok: true,
    async arrayBuffer() { return Buffer.from(JSON.stringify(obj), 'utf8'); },
  };
}

function tempUserDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mav-param-route-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function captureRoutes(userDir) {
  const routes = new Map();
  const permissions = [];
  const RED = {
    settings: { userDir },
    nodes: {
      types: {},
      createNode(node, config) {
        Object.setPrototypeOf(node, EventEmitter.prototype);
        EventEmitter.call(node);
        node.id = config.id || 'node';
        node.status = () => {};
        node.error = () => {};
      },
      registerType(name, ctor) { this.types[name] = ctor; },
      getNode() { return null; },
    },
    httpAdmin: {
      get(route, auth, handler) { routes.set(`GET ${route}`, { auth, handler }); },
      post(route, auth, handler) { routes.set(`POST ${route}`, { auth, handler }); },
    },
    auth: {
      needsPermission(permission) {
        permissions.push(permission);
        return (_req, _res, next) => next && next();
      },
    },
  };

  const modulePath = require.resolve('../../nodes/mavlink-param');
  delete require.cache[modulePath];
  require(modulePath)(RED);
  return { routes, permissions };
}

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function writeHoldingFile(userDir, profileId, document) {
  const file = path.join(userDir, 'mavlink', 'param-defs', `${profileId}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(document));
}

test('parameter definition read and update routes both require mavlink.read', (t) => {
  const { routes, permissions } = captureRoutes(tempUserDir(t));

  assert.ok(routes.has('GET /mavlink/param/defs'));
  assert.ok(routes.has('POST /mavlink/param/defs/update'));
  assert.deepEqual(permissions, ['mavlink.read', 'mavlink.read']);
});

test('GET reads a profile holding file without fetching or requiring a deployed profile', async (t) => {
  const userDir = tempUserDir(t);
  writeHoldingFile(userDir, 'profile-local', {
    Vehicle: {
      LOCAL_ONLY: { humanName: 'Local', documentation: 'Disk only.', fields: {} },
    },
  });
  const { routes } = captureRoutes(userDir);
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('GET attempted a fetch'); };
  t.after(() => { globalThis.fetch = previousFetch; });
  const res = mockRes();

  await routes.get('GET /mavlink/param/defs').handler(
    { query: { vehicle: 'profile-local' } },
    res
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.defs.LOCAL_ONLY.description, 'Disk only.');
  assert.equal(res.body.url, undefined);
});

test('GET returns empty definitions with an Update notice when no holding file exists', async (t) => {
  const { routes } = captureRoutes(tempUserDir(t));
  const res = mockRes();

  await routes.get('GET /mavlink/param/defs').handler(
    { query: { vehicle: 'profile-missing' } },
    res
  );

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.defs, {});
  assert.match(res.body.notice, /Update.*Vehicle Profile/i);
});

test('GET returns an error response for a corrupt local holding file', async (t) => {
  const userDir = tempUserDir(t);
  const file = path.join(userDir, 'mavlink', 'param-defs', 'profile-corrupt.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{broken');
  const { routes } = captureRoutes(userDir);
  const res = mockRes();

  await routes.get('GET /mavlink/param/defs').handler(
    { query: { vehicle: 'profile-corrupt' } },
    res
  );

  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body.defs, {});
  assert.match(res.body.error, /parameter definitions/i);
});

test('POST rejects an empty URL without altering the profile holding file', async (t) => {
  const userDir = tempUserDir(t);
  writeHoldingFile(userDir, 'profile-existing', {
    Vehicle: {
      GOOD: { humanName: 'Good', documentation: 'Last good.', fields: {} },
    },
  });
  const { routes } = captureRoutes(userDir);
  const res = mockRes();

  await routes.get('POST /mavlink/param/defs/update').handler(
    { body: { vehicle: 'profile-existing', url: '  ' } },
    res
  );

  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /URL is required/i);
  const stored = JSON.parse(fs.readFileSync(
    path.join(userDir, 'mavlink', 'param-defs', 'profile-existing.json'),
    'utf8'
  ));
  assert.ok(stored.Vehicle.GOOD);
});

test('POST rejects a missing Vehicle Profile ID', async (t) => {
  const { routes } = captureRoutes(tempUserDir(t));
  const res = mockRes();

  await routes.get('POST /mavlink/param/defs/update').handler(
    { body: { vehicle: ' ', url: 'https://example.test/params.json' } },
    res
  );

  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /Vehicle Profile ID is required/i);
});

test('POST explicitly downloads and returns the validated definition count', async (t) => {
  const userDir = tempUserDir(t);
  const { routes } = captureRoutes(userDir);
  const requested = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    requested.push(url);
    return jsonResponse({
      Vehicle: {
        ONE: { humanName: 'One', documentation: 'First.', fields: {} },
        TWO: { humanName: 'Two', documentation: 'Second.', fields: {} },
      },
    });
  };
  t.after(() => { globalThis.fetch = previousFetch; });
  const updateRes = mockRes();

  await routes.get('POST /mavlink/param/defs/update').handler(
    { body: { vehicle: 'profile-update', url: 'https://example.test/params.json' } },
    updateRes
  );

  assert.equal(updateRes.statusCode, 200);
  assert.deepEqual(updateRes.body, { ok: true, count: 2 });
  assert.deepEqual(requested, ['https://example.test/params.json']);

  const readRes = mockRes();
  await routes.get('GET /mavlink/param/defs').handler(
    { query: { vehicle: 'profile-update' } },
    readRes
  );
  assert.deepEqual(Object.keys(readRes.body.defs), ['ONE', 'TWO']);
});

test('POST accepts and persists the canonical ArduPilot PascalCase document', async (t) => {
  const userDir = tempUserDir(t);
  const { routes } = captureRoutes(userDir);
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse(canonicalArduPilotPdef);
  t.after(() => { globalThis.fetch = previousFetch; });
  const updateRes = mockRes();

  await routes.get('POST /mavlink/param/defs/update').handler(
    { body: { vehicle: 'profile-canonical', url: 'https://example.test/apm.pdef.json' } },
    updateRes
  );

  assert.equal(updateRes.statusCode, 200);
  assert.deepEqual(updateRes.body, { ok: true, count: 2 });

  const readRes = mockRes();
  await routes.get('GET /mavlink/param/defs').handler(
    { query: { vehicle: 'profile-canonical' } },
    readRes
  );
  assert.equal(readRes.body.defs.MAV17_RAW_SENS.unit, 'Hz');
  assert.deepEqual(readRes.body.defs.ALAND_ENABLE.values, [
    { value: 0, label: 'Disabled' },
    { value: 1, label: 'Enabled' },
  ]);
});
