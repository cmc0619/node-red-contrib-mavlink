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

function captureRoutes(userDir, nodesById = {}) {
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
      getNode(id) { return nodesById[id] || null; },
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

test('GET says what is missing when there is no profile, no firmware and no seed to fall back on', async (t) => {
  const { routes } = captureRoutes(tempUserDir(t));
  const res = mockRes();

  // No holding file, and getNode resolves nothing — so no firmware is known
  // and the seed cannot be keyed. The answer has to name the missing piece.
  await routes.get('GET /mavlink/param/defs').handler(
    { query: { vehicle: 'profile-missing' } },
    res
  );

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.defs, {});
  assert.match(res.body.notice, /firmware|Vehicle Profile/i);
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

/**
 * The shipped seed (DESIGN.md §4). Before it, definitions existed only in a
 * per-profile holding file that had to be downloaded by hand, so the Build tier
 * with an explicit dialect — which names no profile — could never reach any,
 * and answered "requires a Vehicle Profile holding file" to an operator who had
 * just downloaded one.
 */

test('GET answers the Build tier from the seed, with no profile at all', async (t) => {
  const { routes } = captureRoutes(tempUserDir(t));
  const res = mockRes();

  await routes.get('GET /mavlink/param/defs').handler(
    { query: { dialect: 'development', firmware: 'px4' } },
    res
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.source, 'seed');
  assert.ok(res.body.defs.RC1_MIN, 'PX4 definitions are served without a profile');
  assert.match(res.body.defs.RC1_MIN.description, /channel 1/i);
  assert.ok(res.body.stamp, 'the answer names which seed it came from');
});

test('GET keys the seed on firmware — the same id differs between stacks', async (t) => {
  const { routes } = captureRoutes(tempUserDir(t));

  const px4 = mockRes();
  await routes.get('GET /mavlink/param/defs').handler(
    { query: { firmware: 'px4' } }, px4
  );
  const ardupilot = mockRes();
  await routes.get('GET /mavlink/param/defs').handler(
    { query: { firmware: 'ardupilot' } }, ardupilot
  );

  // RC1_MIN is microseconds on PX4 and PWM on ArduPilot, with different
  // bounds. Serving one firmware's metadata under the other is a wrong answer,
  // not a near miss.
  assert.equal(px4.body.defs.RC1_MIN.unit, 'us');
  assert.equal(ardupilot.body.defs.RC1_MIN.unit, 'PWM');
  assert.notEqual(px4.body.defs.RC1_MIN.max, ardupilot.body.defs.RC1_MIN.max);
});

test('GET takes firmware and vehicle family from the named profile', async (t) => {
  const { routes } = captureRoutes(tempUserDir(t), {
    'profile-copter': { firmware: 'ardupilot', vehicleFamily: 'copter' },
  });
  const res = mockRes();

  await routes.get('GET /mavlink/param/defs').handler(
    { query: { vehicle: 'profile-copter' } },
    res
  );

  assert.equal(res.body.source, 'seed');
  assert.ok(res.body.defs.RC1_MIN);
  // Copter-only: a Plane or Rover seed would not carry this.
  assert.ok(res.body.defs.ATC_ANG_RLL_P, 'the copter document was selected');
});

test('a downloaded definition overrides the seeded one for the same id', async (t) => {
  const userDir = tempUserDir(t);
  writeHoldingFile(userDir, 'profile-copter', {
    Vehicle: {
      RC1_MIN: { humanName: 'Mine', documentation: 'From my own vehicle.', fields: {} },
    },
  });
  const { routes } = captureRoutes(userDir, {
    'profile-copter': { firmware: 'ardupilot', vehicleFamily: 'copter' },
  });
  const res = mockRes();

  await routes.get('GET /mavlink/param/defs').handler(
    { query: { vehicle: 'profile-copter' } },
    res
  );

  assert.equal(res.body.source, 'profile');
  assert.equal(
    res.body.defs.RC1_MIN.description, 'From my own vehicle.',
    'the download wins: it came from the firmware actually being flown'
  );
  assert.ok(
    Object.keys(res.body.defs).length > 1,
    'and it does not replace the whole seed, only the ids it covers'
  );
});

test('a corrupt holding file is reported without also costing the shipped seed', async (t) => {
  const userDir = tempUserDir(t);
  const file = path.join(userDir, 'mavlink', 'param-defs', 'profile-copter.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{broken');
  const { routes } = captureRoutes(userDir, {
    'profile-copter': { firmware: 'ardupilot', vehicleFamily: 'copter' },
  });
  const res = mockRes();

  await routes.get('GET /mavlink/param/defs').handler(
    { query: { vehicle: 'profile-copter' } },
    res
  );

  assert.equal(res.statusCode, 200, 'the seed still answers');
  assert.ok(res.body.defs.RC1_MIN);
  assert.match(res.body.notice, /unreadable/i, 'but the operator is told their download is broken');
});

test('an unknown firmware yields nothing rather than another firmware s parameters', async (t) => {
  const { routes } = captureRoutes(tempUserDir(t));
  const res = mockRes();

  await routes.get('GET /mavlink/param/defs').handler(
    { query: { firmware: 'betaflight' } },
    res
  );

  assert.deepEqual(res.body.defs, {});
  assert.match(res.body.notice, /betaflight/);
});

test('GET honours firmware and family sent by the editor, with no deployed profile', async (t) => {
  // `getNode` resolves only *deployed* config nodes. A Vehicle Profile the
  // operator just created is visible in the editor and invisible here, so
  // relying on it alone left the field empty until the next deploy.
  const { routes } = captureRoutes(tempUserDir(t)); // no nodes registered at all
  const res = mockRes();

  await routes.get('GET /mavlink/param/defs').handler(
    { query: { vehicle: 'profile-not-yet-deployed', firmware: 'ardupilot', vehicleFamily: 'plane' } },
    res
  );

  assert.equal(res.body.source, 'seed');
  assert.ok(res.body.defs.RC1_MIN, 'definitions arrive without a deployed profile');
  assert.ok(res.body.defs.ARSPD_OFF_PCNT, 'and the plane document was selected, not the union');
});

test('GET prefers the editor query over a stale deployed profile', async (t) => {
  // Editing a profile's firmware and asking before deploying must answer for
  // what is on screen, not for what was last deployed.
  const { routes } = captureRoutes(tempUserDir(t), {
    'profile-1': { firmware: 'ardupilot', vehicleFamily: 'copter' },
  });
  const res = mockRes();

  await routes.get('GET /mavlink/param/defs').handler(
    { query: { vehicle: 'profile-1', firmware: 'px4' } },
    res
  );

  assert.equal(res.body.defs.RC1_MIN.unit, 'us', 'PX4 units, not ArduPilot PWM');
});
