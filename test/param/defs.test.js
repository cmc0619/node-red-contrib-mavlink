'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveDefsUrl,
  assertSafeDefsUrl,
  assertSafeDefsDestination,
  parsePdefJson,
  fetchParamDefs,
  clearMemCache,
  FAMILY_TO_ARDUPILOT_VEHICLE,
} = require('../../lib/param/defs');

/* ── resolveDefsUrl ─────────────────────────────────────────────── */

test('resolveDefsUrl builds ArduPilot URL for known vehicle families', () => {
  assert.equal(
    resolveDefsUrl('copter', 'ardupilot', ''),
    'https://autotest.ardupilot.org/Parameters/ArduCopter/apm.pdef.json'
  );
  assert.equal(
    resolveDefsUrl('plane', 'ardupilot', ''),
    'https://autotest.ardupilot.org/Parameters/ArduPlane/apm.pdef.json'
  );
  assert.equal(
    resolveDefsUrl('rover', 'ardupilot', ''),
    'https://autotest.ardupilot.org/Parameters/Rover/apm.pdef.json'
  );
  assert.equal(
    resolveDefsUrl('boat', 'ardupilot', ''),
    'https://autotest.ardupilot.org/Parameters/Rover/apm.pdef.json'
  );
  assert.equal(
    resolveDefsUrl('sub', 'ardupilot', ''),
    'https://autotest.ardupilot.org/Parameters/Sub/apm.pdef.json'
  );
});

test('resolveDefsUrl returns null for generic/unknown ArduPilot family', () => {
  assert.equal(resolveDefsUrl('generic', 'ardupilot', ''), null);
  assert.equal(resolveDefsUrl('unknown', 'ardupilot', ''), null);
  assert.equal(resolveDefsUrl('antenna-tracker', 'ardupilot', ''), null);
});

test('resolveDefsUrl returns null for PX4 with no custom URL', () => {
  assert.equal(resolveDefsUrl('copter', 'px4', ''), null);
  assert.equal(resolveDefsUrl('copter', 'px4', undefined), null);
});

test('resolveDefsUrl returns custom URL when provided, regardless of firmware', () => {
  const custom = 'https://example.com/my-params.json';
  assert.equal(resolveDefsUrl('copter', 'ardupilot', custom), custom);
  assert.equal(resolveDefsUrl('generic', 'px4', custom), custom);
  assert.equal(resolveDefsUrl('plane', 'custom', custom), custom);
});

test('resolveDefsUrl ignores blank custom URL string', () => {
  assert.equal(resolveDefsUrl('copter', 'ardupilot', '   '), 'https://autotest.ardupilot.org/Parameters/ArduCopter/apm.pdef.json');
  assert.equal(resolveDefsUrl('generic', 'px4', '   '), null);
});

test('assertSafeDefsUrl rejects non-https and private destinations (SSRF)', () => {
  assert.throws(() => assertSafeDefsUrl('http://example.com/p.json'), /https/);
  assert.throws(() => assertSafeDefsUrl('https://127.0.0.1/p.json'), /private|link-local|not allowed/i);
  assert.throws(() => assertSafeDefsUrl('https://192.168.1.9/p.json'), /private|link-local/i);
  assert.throws(() => assertSafeDefsUrl('https://169.254.169.254/latest'), /private|link-local/i);
  assert.throws(() => assertSafeDefsUrl('https://[::ffff:10.0.0.8]/p.json'), /private|link-local/i);
  assert.throws(() => assertSafeDefsUrl('https://[::ffff:7f00:1]/p.json'), /private|link-local/i);
  assert.throws(() => assertSafeDefsUrl('https://localhost/p.json'), /not allowed/);
  assert.doesNotThrow(() => assertSafeDefsUrl('https://example.com/p.json'));
  assert.throws(
    () => resolveDefsUrl('copter', 'px4', 'https://10.0.0.5/secret.json'),
    (err) => err.code === 'PARAM_DEFS_URL_FORBIDDEN'
  );
});

test('assertSafeDefsDestination rejects hostnames that resolve to private addresses', async () => {
  await assert.rejects(
    () =>
      assertSafeDefsDestination('https://evil.example/p.json', async () => [
        { address: '10.1.2.3', family: 4 },
      ]),
    (err) => err.code === 'PARAM_DEFS_URL_FORBIDDEN' && /private address/.test(err.message)
  );
  const pinned = await assertSafeDefsDestination('https://cdn.example/p.json', async () => [
    { address: '93.184.216.34', family: 4 },
  ]);
  assert.deepEqual(pinned, [{ address: '93.184.216.34', family: 4 }]);
});

test('fetchParamDefs refuses a hostname that DNS-maps to a private address', async () => {
  clearMemCache();
  let fetched = 0;
  await assert.rejects(
    () =>
      fetchParamDefs('https://evil.example/p.json', {
        lookupFn: async () => [{ address: '192.168.0.20', family: 4 }],
        fetchFn: async () => {
          fetched += 1;
          return {};
        },
      }),
    (err) => err.code === 'PARAM_DEFS_URL_FORBIDDEN'
  );
  assert.equal(fetched, 0);
});

/* ── parsePdefJson ──────────────────────────────────────────────── */

test('parsePdefJson parses namespaced ArduPilot format', () => {
  const json = {
    ArduCopter: {
      ARMING_CHECK: {
        humanName: 'Arming check',
        documentation: 'Enables pre-arming checks.',
        user: 'Standard',
        fields: { Units: '', Range: '0 16384', Increment: '1' },
        values: { '0': 'Disabled', '1': 'Enabled' },
      },
      PILOT_SPEED_UP: {
        humanName: 'Pilot maximum vertical speed up',
        documentation: 'Maximum vertical ascending rate.',
        user: 'Standard',
        fields: { Units: 'cm/s', Range: '10 500', Increment: '10' },
      },
    },
  };

  const map = parsePdefJson(json);
  assert.equal(map.size, 2);

  const arming = map.get('ARMING_CHECK');
  assert.ok(arming, 'ARMING_CHECK must be in the map');
  assert.equal(arming.description, 'Enables pre-arming checks.');
  assert.equal(arming.min, 0);
  assert.equal(arming.max, 16384);
  assert.equal(arming.increment, 1);
  assert.deepEqual(arming.values, [
    { value: 0, label: 'Disabled' },
    { value: 1, label: 'Enabled' },
  ]);

  const speed = map.get('PILOT_SPEED_UP');
  assert.ok(speed, 'PILOT_SPEED_UP must be in the map');
  assert.equal(speed.unit, 'cm/s');
  assert.equal(speed.min, 10);
  assert.equal(speed.max, 500);
  assert.equal(speed.values, undefined);
});

test('parsePdefJson parses flat format (no vehicle namespace)', () => {
  const json = {
    WPNAV_SPEED: {
      humanName: 'Waypoint cruise speed',
      documentation: 'Defines the speed in cm/s.',
      user: 'Standard',
      fields: { Units: 'cm/s', Range: '20 2000', Increment: '50' },
    },
  };

  const map = parsePdefJson(json);
  assert.equal(map.size, 1);
  const def = map.get('WPNAV_SPEED');
  assert.ok(def);
  assert.equal(def.unit, 'cm/s');
  assert.equal(def.min, 20);
});

test('parsePdefJson normalises param ids to uppercase', () => {
  const json = {
    ArduCopter: {
      arming_check: { humanName: 'arming check', documentation: '' },
    },
  };
  const map = parsePdefJson(json);
  assert.ok(map.has('ARMING_CHECK'));
});

test('parsePdefJson handles array documentation', () => {
  const json = {
    FOO: {
      humanName: 'Foo',
      documentation: ['First sentence.', 'Second sentence.'],
      fields: {},
    },
  };
  const map = parsePdefJson(json);
  const def = map.get('FOO');
  assert.ok(def);
  assert.equal(def.description, 'First sentence. Second sentence.');
});

test('parsePdefJson ignores entries with no recognisable shape', () => {
  const json = {
    NOT_A_PARAM: { foo: 'bar', baz: 42 },
    ArduCopter: {
      GOOD: { humanName: 'Good param', documentation: '', fields: {} },
    },
  };
  const map = parsePdefJson(json);
  // NOT_A_PARAM has no humanName/documentation — not a param entry, and
  // iterating its values finds no entries, so it contributes nothing.
  assert.equal(map.size, 1);
  assert.ok(map.has('GOOD'));
});

test('parsePdefJson returns empty map for null/non-object input', () => {
  assert.equal(parsePdefJson(null).size, 0);
  assert.equal(parsePdefJson('string').size, 0);
  assert.equal(parsePdefJson([]).size, 0);
  assert.equal(parsePdefJson({}).size, 0);
});

/* ── fetchParamDefs (injectable fetch) ─────────────────────────── */

test('fetchParamDefs calls injectable fetch and parses result', async () => {
  clearMemCache();
  const fakeJson = {
    Rover: {
      SPEED: {
        humanName: 'Speed',
        documentation: 'Maximum speed.',
        fields: { Units: 'm/s', Range: '0 10', Increment: '0.5' },
      },
    },
  };
  const fetched = [];
  const fetchFn = async (url) => { fetched.push(url); return fakeJson; };

  const map = await fetchParamDefs('https://example.com/test.json', { fetchFn });
  assert.equal(fetched.length, 1);
  assert.equal(fetched[0], 'https://example.com/test.json');
  assert.ok(map.has('SPEED'));
  assert.equal(map.get('SPEED').unit, 'm/s');
});

test('fetchParamDefs returns cached result without re-fetching', async () => {
  clearMemCache();
  const fakeJson = { Rover: { SPEED: { humanName: 'Speed', documentation: '', fields: {} } } };
  let fetchCount = 0;
  const fetchFn = async () => { fetchCount++; return fakeJson; };

  await fetchParamDefs('https://example.com/cached.json', { fetchFn });
  await fetchParamDefs('https://example.com/cached.json', { fetchFn });
  assert.equal(fetchCount, 1, 'second call must hit the memory cache');
});

test('fetchParamDefs propagates fetch errors', async () => {
  clearMemCache();
  const fetchFn = async () => { throw new Error('network down'); };
  await assert.rejects(
    () => fetchParamDefs('https://example.com/fail.json', { fetchFn }),
    /network down/
  );
});

/* ── FAMILY_TO_ARDUPILOT_VEHICLE export ─────────────────────────── */

test('FAMILY_TO_ARDUPILOT_VEHICLE exports the expected mapping', () => {
  assert.equal(FAMILY_TO_ARDUPILOT_VEHICLE.copter, 'ArduCopter');
  assert.equal(FAMILY_TO_ARDUPILOT_VEHICLE.plane, 'ArduPlane');
  assert.equal(FAMILY_TO_ARDUPILOT_VEHICLE.rover, 'Rover');
  assert.equal(FAMILY_TO_ARDUPILOT_VEHICLE.boat, 'Rover');
  assert.equal(FAMILY_TO_ARDUPILOT_VEHICLE.sub, 'Sub');
});
