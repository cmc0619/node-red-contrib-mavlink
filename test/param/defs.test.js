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
    values: [
      { value: 0, label: 'Disabled' },
      { value: 1, label: 'Enabled' },
    ],
  });
  assert.equal(map.get('PILOT_SPEED_UP').unit, 'cm/s');
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
