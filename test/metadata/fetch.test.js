'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { fetchDialect, REMOTE_SOURCES } = require('../../lib/metadata');

/**
 * Remote fetch (DESIGN.md §4): pin the commit first, follow includes at that
 * commit so the snapshot is self-contained, record provenance, and keep the
 * source selectable. The network is injected, so these run offline; every
 * rejection propagates to the caller's promise (§2).
 */

const XML = (body) => `<?xml version="1.0"?>\n<mavlink>${body}</mavlink>`;

const BASE = XML(
  '<enums><enum name="MAV_TYPE"><entry value="0" name="MAV_TYPE_GENERIC"/></enum></enums>' +
  '<messages><message id="0" name="HEARTBEAT"><field type="uint8_t" name="type" enum="MAV_TYPE">t</field></message></messages>'
);
const TOP = XML(
  '<include>common.xml</include><version>2</version>' +
  '<messages><message id="9000" name="CUSTOM"><field type="uint8_t" name="a">a</field></message></messages>'
);

/**
 * A stub GitHub source: `resolveCommit` pins to a fixed SHA, `fetchFile` serves
 * from an in-memory tree, `listFiles` lists it. Records what was fetched.
 */
function stubSource(tree, sha = 'deadbeefcafe') {
  const requested = [];
  return {
    sha,
    requested,
    resolveCommit: async () => sha,
    fetchFile: async (_repo, commit, file) => {
      requested.push({ commit, file });
      if (!(file in tree)) {
        throw new Error(`404 ${file}`);
      }
      return tree[file];
    },
    listFiles: async () => Object.keys(tree),
  };
}

test('REMOTE_SOURCES lists both selectable upstreams', () => {
  assert.deepEqual(REMOTE_SOURCES, ['mavlink/mavlink', 'ArduPilot/mavlink']);
});

test('fetches the include closure at the resolved commit and records provenance', async () => {
  const src = stubSource({ 'ardupilotmega.xml': TOP, 'common.xml': BASE });
  const bundle = await fetchDialect({
    repo: 'ArduPilot/mavlink',
    ref: 'master',
    files: 'ardupilotmega.xml',
    resolveCommit: src.resolveCommit,
    fetchFile: src.fetchFile,
    listFiles: src.listFiles,
  });

  assert.equal(bundle.fetched.repo, 'ArduPilot/mavlink');
  assert.equal(bundle.fetched.commit, src.sha);
  assert.ok(Date.parse(bundle.fetched.fetchedAt) > 0, 'fetchedAt is an ISO timestamp');
  // Every file was fetched at the pinned commit, not the ref.
  assert.ok(src.requested.every((r) => r.commit === src.sha));
  assert.deepEqual(src.requested.map((r) => r.file).sort(), ['ardupilotmega.xml', 'common.xml']);
  assert.deepEqual(bundle.files, ['common.xml', 'ardupilotmega.xml']);
  assert.ok(bundle.messages.CUSTOM && bundle.messages.HEARTBEAT);
});

test('the source is selectable; an unknown source rejects before any fetch', async () => {
  const src = stubSource({ 'common.xml': BASE });
  const ok = await fetchDialect({
    repo: 'mavlink/mavlink',
    files: 'common.xml',
    resolveCommit: src.resolveCommit,
    fetchFile: src.fetchFile,
  });
  assert.equal(ok.fetched.repo, 'mavlink/mavlink');

  await assert.rejects(
    () => fetchDialect({ repo: 'evil/mavlink', files: 'common.xml', resolveCommit: src.resolveCommit, fetchFile: src.fetchFile }),
    /Unknown remote source 'evil\/mavlink'/
  );
});

test('a failed commit resolution rejects, naming the source and ref', async () => {
  await assert.rejects(
    () =>
      fetchDialect({
        repo: 'mavlink/mavlink',
        ref: 'no-such-branch',
        files: 'common.xml',
        resolveCommit: async () => {
          throw new Error('git ref not found');
        },
        fetchFile: async () => BASE,
      }),
    /git ref not found/
  );
});

test('a null commit resolution rejects with a diagnostic naming source@ref', async () => {
  await assert.rejects(
    () =>
      fetchDialect({
        repo: 'mavlink/mavlink',
        ref: 'main',
        files: 'common.xml',
        resolveCommit: async () => null,
        fetchFile: async () => BASE,
      }),
    /mavlink\/mavlink@main/
  );
});

test('a missing include file surfaces the transport rejection', async () => {
  // TOP includes common.xml, but the tree omits it: fetchFile throws 404.
  const src = stubSource({ 'ardupilotmega.xml': TOP });
  await assert.rejects(
    () =>
      fetchDialect({
        repo: 'ArduPilot/mavlink',
        files: 'ardupilotmega.xml',
        resolveCommit: src.resolveCommit,
        fetchFile: src.fetchFile,
      }),
    /404 common\.xml/
  );
});

test('listFiles gates a bad entry name before fetching it', async () => {
  const src = stubSource({ 'common.xml': BASE });
  await assert.rejects(
    () =>
      fetchDialect({
        repo: 'mavlink/mavlink',
        files: 'nonexistent.xml',
        resolveCommit: src.resolveCommit,
        fetchFile: src.fetchFile,
        listFiles: src.listFiles,
      }),
    /'nonexistent\.xml' is not among the files/
  );
});

test('an empty listFiles result rejects the entry (does not skip validation)', async () => {
  await assert.rejects(
    () =>
      fetchDialect({
        repo: 'mavlink/mavlink',
        files: 'common.xml',
        resolveCommit: async () => 'abc',
        fetchFile: async () => BASE,
        listFiles: async () => [],
      }),
    /'common\.xml' is not among the files/
  );
});
