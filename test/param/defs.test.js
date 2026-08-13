'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  paramDefsPath,
  parsePdefJson,
  readParamDefs,
  updateParamDefs,
} = require('../../lib/param/defs');

const canonicalArduPilotPdef = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'apm.pdef-canonical.json'),
  'utf8'
));

function tempUserDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mav-param-defs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function documentFor(paramId, description = 'Definition') {
  return {
    Vehicle: {
      [paramId]: {
        humanName: paramId,
        documentation: description,
        fields: {},
      },
    },
  };
}

test('parsePdefJson parses namespaced ArduPilot format', () => {
  const map = parsePdefJson({
    ArduCopter: {
      ARMING_CHECK: {
        humanName: 'Arming check',
        documentation: 'Enables pre-arming checks.',
        fields: { Units: '', Range: '0 16384', Increment: '1' },
        values: { '0': 'Disabled', '1': 'Enabled' },
      },
      PILOT_SPEED_UP: {
        humanName: 'Pilot maximum vertical speed up',
        documentation: 'Maximum vertical ascending rate.',
        fields: { Units: 'cm/s', Range: '10 500', Increment: '10' },
      },
    },
  });

  assert.equal(map.size, 2);
  assert.deepEqual(map.get('ARMING_CHECK'), {
    description: 'Enables pre-arming checks.',
    unit: '',
    min: 0,
    max: 16384,
    increment: 1,
    // ArduPilot publishes no wire type in either pdef format.
    type: undefined,
    values: [
      { value: 0, label: 'Disabled' },
      { value: 1, label: 'Enabled' },
    ],
    bits: undefined,
  });
  assert.equal(map.get('PILOT_SPEED_UP').unit, 'cm/s');
});

test('parsePdefJson parses the canonical ArduPilot PascalCase document shape', () => {
  const map = parsePdefJson(canonicalArduPilotPdef);

  assert.equal(map.size, 2);
  assert.deepEqual(map.get('MAV17_RAW_SENS'), {
    description: 'MAVLink Stream rate of RAW_IMU, SCALED_IMU2, SCALED_IMU3, ' +
      'SCALED_PRESSURE, SCALED_PRESSURE2, SCALED_PRESSURE3 and AIRSPEED',
    unit: 'Hz',
    min: 0,
    max: 50,
    increment: 1,
    type: undefined,
    values: undefined,
    bits: undefined,
  });
  assert.deepEqual(map.get('ALAND_ENABLE').values, [
    { value: 0, label: 'Disabled' },
    { value: 1, label: 'Enabled' },
  ]);
});

test('parsePdefJson parses bitmask definitions from all three published shapes', () => {
  const map = parsePdefJson({
    Vehicle: {
      // ArduPilot XML-derived field text: "bit:Label" pairs; a colon inside a
      // label belongs to the label.
      ARMING_CHECK: {
        humanName: 'Arming checks',
        documentation: 'Which checks arm requires.',
        fields: { Bitmask: '0:All,1:Barometer,3:Board voltage: main' },
      },
      // ArduPilot JSON object shape — bit positions as keys, unlike Values.
      LOG_BITMASK: {
        humanName: 'Log bitmask',
        documentation: 'What to log.',
        Bitmask: { 2: 'GPS', 0: 'Fast attitude' },
        fields: {},
      },
      // PX4 shape: [{index, description}] — out-of-int32-range bits dropped.
      COM_ARM_AUTH: {
        shortDesc: 'Arm authorization',
        bitmask: [
          { index: 31, description: 'High bit' },
          { index: 1, description: 'Second' },
          { index: 32, description: 'Outside int32' },
          { index: -1, description: 'Negative' },
        ],
      },
      // Bitmask present but every entry invalid: the editor gates its picker
      // on `def.bits` being falsy, so this must normalise to undefined, not [].
      BAD_BITS: {
        shortDesc: 'All bits unusable',
        fields: { Bitmask: '32:Out of range,notabit:Garbage' },
      },
    },
  });

  assert.deepEqual(map.get('ARMING_CHECK').bits, [
    { bit: 0, label: 'All' },
    { bit: 1, label: 'Barometer' },
    { bit: 3, label: 'Board voltage: main' },
  ]);
  // Sorted by bit position regardless of published order.
  assert.deepEqual(map.get('LOG_BITMASK').bits, [
    { bit: 0, label: 'Fast attitude' },
    { bit: 2, label: 'GPS' },
  ]);
  assert.deepEqual(map.get('COM_ARM_AUTH').bits, [
    { bit: 1, label: 'Second' },
    { bit: 31, label: 'High bit' },
  ]);
  assert.strictEqual(map.get('BAD_BITS').bits, undefined);
});

test('parsePdefJson parses flat format and normalises IDs', () => {
  const map = parsePdefJson({
    wpnav_speed: {
      humanName: 'Waypoint cruise speed',
      documentation: ['Defines the speed.', 'Measured in cm/s.'],
      fields: { Units: 'cm/s', Range: '20 2000', Increment: '50' },
    },
  });

  assert.equal(map.size, 1);
  assert.equal(map.get('WPNAV_SPEED').description, 'Defines the speed. Measured in cm/s.');
  assert.equal(map.get('WPNAV_SPEED').min, 20);
});

test('parsePdefJson ignores entries with no recognisable parameter shape', () => {
  const map = parsePdefJson({
    NOT_A_PARAM: { foo: 'bar', baz: 42 },
    Vehicle: {
      GOOD: { humanName: 'Good param', documentation: '', fields: {} },
    },
  });

  assert.deepEqual([...map.keys()], ['GOOD']);
});

test('holding-file path is deterministic under userDir and keyed only by profile ID', () => {
  assert.equal(
    paramDefsPath('C:\\node-red', 'profile-1'),
    path.join('C:\\node-red', 'mavlink', 'param-defs', 'profile-1.json')
  );
});

test('holding-file path rejects profile IDs that could escape the holding directory', () => {
  assert.throws(() => paramDefsPath('C:\\node-red', '../outside'), /unsupported characters/i);
  assert.throws(() => paramDefsPath('C:\\node-red', 'folder\\outside'), /unsupported characters/i);
});

test('readParamDefs returns an empty map only when the holding file is absent', async (t) => {
  const userDir = tempUserDir(t);

  const map = await readParamDefs(userDir, 'profile-no-seed');

  assert.equal(map.size, 0);
  assert.equal(fs.existsSync(paramDefsPath(userDir, 'profile-no-seed')), false);
});

test('readParamDefs reads the profile holding file without invoking fetch', async (t) => {
  const userDir = tempUserDir(t);
  const file = paramDefsPath(userDir, 'profile-local');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(documentFor('LOCAL_ONLY', 'Read from disk.')));
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('read attempted network access'); };
  t.after(() => { globalThis.fetch = previousFetch; });

  const map = await readParamDefs(userDir, 'profile-local');

  assert.equal(map.size, 1);
  assert.equal(map.get('LOCAL_ONLY').description, 'Read from disk.');
});

test('explicit updates overwrite one stable profile holding file across URL changes', async (t) => {
  const userDir = tempUserDir(t);
  const fetched = [];
  const fetchFn = async (url) => {
    fetched.push(url);
    return documentFor(url.endsWith('/one.json') ? 'FIRST' : 'SECOND');
  };

  const first = await updateParamDefs(
    userDir,
    'profile-stable',
    'https://example.test/one.json',
    { fetchFn }
  );
  const second = await updateParamDefs(
    userDir,
    'profile-stable',
    'https://example.test/two.json',
    { fetchFn }
  );
  const stored = await readParamDefs(userDir, 'profile-stable');
  const files = fs.readdirSync(path.dirname(paramDefsPath(userDir, 'profile-stable')));

  assert.equal(first.count, 1);
  assert.equal(second.count, 1);
  assert.deepEqual(fetched, [
    'https://example.test/one.json',
    'https://example.test/two.json',
  ]);
  assert.deepEqual([...stored.keys()], ['SECOND']);
  assert.deepEqual(files, ['profile-stable.json']);
});

test('explicit update rejects an empty URL before fetching', async (t) => {
  const userDir = tempUserDir(t);
  let fetched = false;

  await assert.rejects(
    updateParamDefs(userDir, 'profile-empty-url', '   ', {
      fetchFn: async () => { fetched = true; return documentFor('NOPE'); },
    }),
    /URL is required/i
  );
  assert.equal(fetched, false);
});

test('explicit update rejects a document with no definitions', async (t) => {
  const userDir = tempUserDir(t);

  await assert.rejects(
    updateParamDefs(userDir, 'profile-empty-doc', 'https://example.test/empty.json', {
      fetchFn: async () => ({}),
    }),
    /no parameter definitions/i
  );
  assert.equal(fs.existsSync(paramDefsPath(userDir, 'profile-empty-doc')), false);
});

test('a failed update preserves the last good profile holding file', async (t) => {
  const userDir = tempUserDir(t);
  await updateParamDefs(userDir, 'profile-preserve', 'https://example.test/good.json', {
    fetchFn: async () => documentFor('LAST_GOOD'),
  });

  await assert.rejects(
    updateParamDefs(userDir, 'profile-preserve', 'https://example.test/bad.json', {
      fetchFn: async () => { throw new Error('network down'); },
    }),
    /network down/
  );

  const stored = await readParamDefs(userDir, 'profile-preserve');
  const files = fs.readdirSync(path.dirname(paramDefsPath(userDir, 'profile-preserve')));
  assert.deepEqual([...stored.keys()], ['LAST_GOOD']);
  assert.deepEqual(files, ['profile-preserve.json']);
});

test('a filesystem failure after the temporary write removes the sibling temporary file', async (t) => {
  const userDir = tempUserDir(t);
  const target = paramDefsPath(userDir, 'profile-rename-failure');
  fs.mkdirSync(target, { recursive: true });

  await assert.rejects(
    updateParamDefs(userDir, 'profile-rename-failure', 'https://example.test/good.json', {
      fetchFn: async () => documentFor('VALID'),
    })
  );

  assert.deepEqual(
    fs.readdirSync(path.dirname(target)),
    ['profile-rename-failure.json'],
    'failed atomic replacement must not leave a sibling temporary file'
  );
});

test(
  'Windows rename failure preserves the last good file and removes the sibling temporary file',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const userDir = tempUserDir(t);
    const target = paramDefsPath(userDir, 'profile-readonly');
    await updateParamDefs(userDir, 'profile-readonly', 'https://example.test/good.json', {
      fetchFn: async () => documentFor('LAST_GOOD'),
    });
    fs.chmodSync(target, 0o444);

    try {
      await assert.rejects(
        updateParamDefs(userDir, 'profile-readonly', 'https://example.test/replacement.json', {
          fetchFn: async () => documentFor('REPLACEMENT'),
        }),
        (err) => err && err.code === 'EPERM'
      );

      const stored = await readParamDefs(userDir, 'profile-readonly');
      assert.deepEqual([...stored.keys()], ['LAST_GOOD']);
      assert.deepEqual(
        fs.readdirSync(path.dirname(target)),
        ['profile-readonly.json'],
        'failed Windows replacement must not leave a sibling temporary file'
      );
    } finally {
      fs.chmodSync(target, 0o666);
    }
  }
);

test('corrupt local JSON and invalid local documents propagate instead of appearing absent', async (t) => {
  const userDir = tempUserDir(t);
  const corruptFile = paramDefsPath(userDir, 'profile-corrupt');
  const emptyFile = paramDefsPath(userDir, 'profile-empty');
  fs.mkdirSync(path.dirname(corruptFile), { recursive: true });
  fs.writeFileSync(corruptFile, '{not json');
  fs.writeFileSync(emptyFile, '{}');

  await assert.rejects(readParamDefs(userDir, 'profile-corrupt'), /JSON|property name|position/i);
  await assert.rejects(readParamDefs(userDir, 'profile-empty'), /no parameter definitions/i);
});

/**
 * PX4 publishes `parameters.json.xz`: a different container *and* a different
 * schema from ArduPilot's `apm.pdef.json`. Both walls were hit in the field —
 * the XZ bytes reached JSON.parse and its error, binary and all, was shown to
 * the operator.
 */

/** A fetch response carrying raw bytes, as `defaultFetch` now reads them. */
function bytesResponse(bytes) {
  return { ok: true, async arrayBuffer() { return Buffer.from(bytes); } };
}

test('parsePdefJson reads the PX4 parameters array, keyed by the entry name', () => {
  const map = parsePdefJson({
    version: 1,
    parameters: [
      {
        name: 'RC1_MIN',
        shortDesc: 'RC channel 1 minimum',
        longDesc: 'Minimum value for RC channel 1',
        type: 'Float',
        min: 800,
        max: 1500,
        units: 'us',
      },
    ],
  });

  // The id lives *inside* the entry here; the ArduPilot walk would have keyed
  // this off the array index and produced a param called "0".
  assert.deepEqual([...map.keys()], ['RC1_MIN']);
  const def = map.get('RC1_MIN');
  assert.equal(def.description, 'Minimum value for RC channel 1', 'longDesc preferred over shortDesc');
  assert.equal(def.unit, 'us');
  assert.equal(def.min, 800);
  assert.equal(def.max, 1500);
});

test('PX4 entries without a longDesc fall back to the one-line shortDesc', () => {
  // longDesc is on 61% of PX4 entries; shortDesc on 100%. A blank tooltip for
  // the other 39% would be the visible symptom.
  const map = parsePdefJson({
    parameters: [{ name: 'PWM_MAIN_REV', shortDesc: 'Reverse Output Range for SIM', type: 'Int32' }],
  });
  assert.equal(map.get('PWM_MAIN_REV').description, 'Reverse Output Range for SIM');
});

test('PX4 states enumerated values as an array, ArduPilot as an object; both land the same', () => {
  const px4 = parsePdefJson({
    parameters: [{
      name: 'ADSB_EMERGC',
      shortDesc: 'ADSB-Out Emergency State',
      values: [
        { value: 0, description: 'NoEmergency' },
        { value: 1, description: 'General' },
      ],
    }],
  });
  assert.deepEqual(px4.get('ADSB_EMERGC').values, [
    { value: 0, label: 'NoEmergency' },
    { value: 1, label: 'General' },
  ]);

  const ardupilot = parsePdefJson({
    Vehicle: { ARMING_CHECK: { humanName: 'Arming', documentation: 'x', Values: { 0: 'None', 1: 'All' } } },
  });
  assert.deepEqual(ardupilot.get('ARMING_CHECK').values, [
    { value: 0, label: 'None' },
    { value: 1, label: 'All' },
  ]);
});

test('a values array with no usable entries yields undefined, not NaN options', () => {
  const map = parsePdefJson({
    parameters: [{ name: 'X', shortDesc: 'x', values: [{ description: 'no value field' }] }],
  });
  assert.equal(map.get('X').values, undefined);
});

test('an XZ archive is named as such instead of reaching JSON.parse', async (t) => {
  const userDir = tempUserDir(t);
  // The real magic number, and the bytes behind the "7zXZ" in the reported error.
  const xz = [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00, 0x00, 0x04, 0xe6, 0xd6];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => bytesResponse(xz);
  t.after(() => { globalThis.fetch = previousFetch; });

  await assert.rejects(
    updateParamDefs(userDir, 'profile-xz', 'https://artifacts.px4.io/Firmware/_general/parameters.json.xz'),
    (err) => {
      assert.match(err.message, /XZ archive, not JSON/);
      // The point of the change: no binary, no "Unexpected token" in the editor.
      assert.doesNotMatch(err.message, /Unexpected token/);
      return true;
    }
  );
});

test('a body that is neither JSON nor XML is quoted as printable ASCII only', async (t) => {
  const userDir = tempUserDir(t);
  const previousFetch = globalThis.fetch;
  // "oops" followed by bytes that would render as control characters. A body
  // starting with '<' takes the XML branch instead and gets its own message.
  globalThis.fetch = async () => bytesResponse([0x6f, 0x6f, 0x70, 0x73, 0x00, 0x01, 0x1f]);
  t.after(() => { globalThis.fetch = previousFetch; });

  await assert.rejects(
    updateParamDefs(userDir, 'profile-garbage', 'https://example.invalid/params'),
    (err) => {
      assert.match(err.message, /did not return JSON or XML \(starts with "oops\.\.\."\)/);
      assert.doesNotMatch(err.message, /Unexpected token/);
      return true;
    }
  );
});

test('a well-formed PX4 document still downloads and persists', async (t) => {
  const userDir = tempUserDir(t);
  const doc = { parameters: [{ name: 'RC1_MIN', shortDesc: 'RC channel 1 minimum', units: 'us' }] };
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => bytesResponse(Buffer.from(JSON.stringify(doc), 'utf8'));
  t.after(() => { globalThis.fetch = previousFetch; });

  const result = await updateParamDefs(userDir, 'profile-px4', 'https://example.invalid/parameters.json');
  assert.equal(result.count, 1);
  const reread = await readParamDefs(userDir, 'profile-px4');
  assert.equal(reread.get('RC1_MIN').unit, 'us');
});

/**
 * PX4 publishes the same 1836 parameters twice: `parameters.json.xz` and an
 * uncompressed `parameters.xml`. The XML is what makes PX4 usable without an
 * LZMA dependency, so it normalizes into the PX4 *JSON* shape and every
 * assertion about that shape above continues to hold.
 */
const PX4_XML = `<?xml version="1.0"?>
<parameters>
  <version>3</version>
  <group name="Radio Calibration">
    <parameter name="RC1_MIN" default="1000.0" type="FLOAT">
      <short_desc>RC channel 1 minimum</short_desc>
      <long_desc>Minimum value for RC channel 1</long_desc>
      <min>800.0</min>
      <max>1500.0</max>
      <unit>us</unit>
      <increment>0.5</increment>
    </parameter>
    <parameter name="RC1_TRIM" type="FLOAT">
      <short_desc>RC trim</short_desc>
    </parameter>
  </group>
  <group name="ADSB">
    <parameter name="ADSB_EMERGC" type="INT32">
      <short_desc>ADSB-Out Emergency State</short_desc>
      <values>
        <value code="0">NoEmergency</value>
        <value code="-1.0">Negative float code</value>
      </values>
      <bitmask>
        <bit index="2">Squawk</bit>
      </bitmask>
    </parameter>
    <parameter name="ADSB_IDENT" type="INT32" boolean="true">
      <short_desc>ADSB-Out Ident Configuration</short_desc>
      <long_desc>Enable Identification of Position feature</long_desc>
    </parameter>
  </group>
</parameters>`;

function xmlResponse(text) {
  return { ok: true, async arrayBuffer() { return Buffer.from(text, 'utf8'); } };
}

test('PX4 parameters.xml is read, walking groups and mapping snake_case elements', async (t) => {
  const userDir = tempUserDir(t);
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => xmlResponse(PX4_XML);
  t.after(() => { globalThis.fetch = previousFetch; });

  const { count } = await updateParamDefs(
    userDir, 'profile-xml', 'https://artifacts.px4.io/Firmware/_general/parameters.xml'
  );
  assert.equal(count, 4, 'parameters are found inside their <group> wrappers');

  const map = await readParamDefs(userDir, 'profile-xml');
  assert.deepEqual(map.get('RC1_MIN'), {
    description: 'Minimum value for RC channel 1',
    unit: 'us',
    min: 800,
    max: 1500,
    increment: 0.5,
    type: 'MAV_PARAM_TYPE_REAL32',
    values: undefined,
    bits: undefined,
  });
  assert.equal(
    map.get('RC1_TRIM').description, 'RC trim',
    'short_desc carries the entry when long_desc is absent'
  );
  // A single <bit> is the shape that breaks without the parser's isArray
  // config — one element parses as a bare object, not a one-entry array.
  assert.deepEqual(map.get('ADSB_EMERGC').bits, [{ bit: 2, label: 'Squawk' }],
    '<bitmask><bit index> parses through the PX4 XML mirror');
});

test('XML value codes are not always integers', () => {
  // 36 of PX4's real entries use codes like "-1.0"; a digits-only test drops them.
  const previous = globalThis.fetch;
  globalThis.fetch = previous;
  const map = parsePdefJson({
    parameters: [{ name: 'X', shortDesc: 'x', values: [{ value: -1.0, description: 'Neg' }] }],
  });
  assert.deepEqual(map.get('X').values, [{ value: -1, label: 'Neg' }]);
});

test('a boolean="true" parameter expands to the Disabled/Enabled pair PX4 itself generates', async (t) => {
  // The XML states booleans as an attribute and omits <values>; PX4's own JSON
  // generator expands it. This is the entire measured difference between the
  // two published formats — 98 parameters, 0 otherwise unexplained.
  const userDir = tempUserDir(t);
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => xmlResponse(PX4_XML);
  t.after(() => { globalThis.fetch = previousFetch; });

  await updateParamDefs(userDir, 'profile-bool', 'https://example.invalid/parameters.xml');
  const map = await readParamDefs(userDir, 'profile-bool');
  assert.deepEqual(map.get('ADSB_IDENT').values, [
    { value: 0, label: 'Disabled' },
    { value: 1, label: 'Enabled' },
  ]);
  // An explicit <values> block still wins over the attribute expansion.
  assert.deepEqual(map.get('ADSB_EMERGC').values, [
    { value: 0, label: 'NoEmergency' },
    { value: -1, label: 'Negative float code' },
  ]);
});

test('XML that is not a parameter document says so instead of reporting zero parameters', async (t) => {
  const userDir = tempUserDir(t);
  const previousFetch = globalThis.fetch;
  // An HTML error page also starts with '<' and would otherwise reach the
  // "contains no parameter definitions" wall, which reads as an empty source.
  globalThis.fetch = async () => xmlResponse('<html><body>404 Not Found</body></html>');
  t.after(() => { globalThis.fetch = previousFetch; });

  await assert.rejects(
    updateParamDefs(userDir, 'profile-html-xml', 'https://example.invalid/oops'),
    /no <parameters> root/
  );
});
