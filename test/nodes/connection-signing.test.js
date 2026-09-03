'use strict';

/**
 * nodes/mavlink-connection.js buildSigning() (DESIGN.md §7 "Signing"). A
 * passphrase must derive a verification key regardless of the sign-outbound /
 * require-signed checkboxes — those two remain independent policy switches
 * (outbound signing, inbound rejection), not gates on whether a key exists to
 * verify against at all.
 *
 * Also the verdict→surface wiring (issue #243): rejected inbound frames must
 * produce an operator-visible signal — a per-streak deduped warn and a badge
 * naming the reason — and the accept-invalid recovery override must show the
 * connection as untrusted conspicuously (DESIGN.md §7).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  buildSigning,
  makeRejectedHandler,
  applyStatus,
} = require('../../nodes/mavlink-connection');
const { STATE } = require('../../lib/connection');
const { SigningState, timestampFromMs } = require('../../lib/connection/signing');
const BADGE_MAX = 24; // §6 badge cap, as the runtime produces it

test('a passphrase alone (both checkboxes off) still derives a key', () => {
  const signing = buildSigning(
    { linkId: 0, signOutbound: false, requireSigned: false },
    { signingPassphrase: 'correct horse battery staple' }
  );
  assert.equal(signing.hasKey, true);
  assert.ok(Buffer.isBuffer(signing.key), 'key must be derived even with both switches off');
  assert.equal(signing.signOutbound, false, 'sign-outbound policy is unaffected');
  assert.equal(signing.requireSigned, false, 'require-signed policy is unaffected');
});

test('no passphrase means no key, regardless of the switches', () => {
  const signing = buildSigning({ linkId: 0, signOutbound: false, requireSigned: true }, {});
  assert.equal(signing.hasKey, false);
  assert.equal(signing.key, null);
});

test('sign-outbound and require-signed still carry through as independent policy flags', () => {
  const signing = buildSigning(
    { linkId: 0, signOutbound: true, requireSigned: true },
    { signingPassphrase: 'secret' }
  );
  assert.equal(signing.signOutbound, true);
  assert.equal(signing.requireSigned, true);
  assert.ok(signing.key, 'key still derives when the switches are on too');
});

test('a raw hex key becomes the key bytes verbatim — no hashing', () => {
  const hex = 'aa'.repeat(16) + 'bb'.repeat(16); // 64 hex chars, 32 bytes
  const signing = buildSigning({ linkId: 0, signOutbound: true }, { signingKeyHex: hex });
  assert.equal(signing.hasKey, true);
  assert.ok(Buffer.isBuffer(signing.key));
  assert.equal(signing.key.length, 32);
  assert.equal(signing.key.toString('hex'), hex, 'raw bytes pass through untouched');
});

test('raw key hex is case-insensitive', () => {
  const hex = `${'AbCdEf'.repeat(10)  }AbCd`; // 64 chars mixed case
  const signing = buildSigning({ linkId: 0 }, { signingKeyHex: hex });
  assert.equal(signing.key.toString('hex'), hex.toLowerCase());
});

test('the two key rules live in the editor, not in buildSigning (§0)', () => {
  // Both are static, cross-field, deploy-time facts about the *form*: exactly
  // 64 hex characters, and never alongside a passphrase. AGENTS.md names the
  // passphrase/raw-key pair as a walled-garden red ring by name, so the
  // driver takes the credentials as saved and derives the key.
  const html = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', '..', 'nodes', 'mavlink-connection.html'),
    'utf8'
  );
  const block = html.slice(html.indexOf('signingKeyHex: {'), html.indexOf('label() {'));
  assert.match(block, /64 hex characters/, 'the format rule reds in the editor');
  assert.match(block, /cannot be set alongside a passphrase/, 'and so does the exclusivity');
  // Saved password credentials surface as has_* booleans, so both spellings
  // have to be read or the rule only fires while the dialog is open.
  assert.match(block, /has_signingPassphrase/);

  // A well-formed raw key still derives the same 32 bytes.
  const signing = buildSigning({ linkId: 0 }, { signingKeyHex: 'aa'.repeat(32) });
  assert.ok(signing.key.equals(Buffer.from('aa'.repeat(32), 'hex')));
});

// ── issue #243: rejected-frame surfacing and the untrusted badge ─────────────

/** @returns {{node: object, warns: string[], statuses: object[]}} */
function statusNode() {
  const warns = [];
  const statuses = [];
  return {
    node: { warn: (m) => warns.push(m), status: (s) => statuses.push(s) },
    warns,
    statuses,
  };
}

test('rejections warn once per consecutive same-reason streak (#243)', () => {
  const { node, warns, statuses } = statusNode();
  const handler = makeRejectedHandler(node, { hasKey: false, acceptInvalid: false });

  handler({ reason: 'invalid-signature' });
  handler({ reason: 'invalid-signature' });
  handler({ reason: 'invalid-signature' });
  assert.equal(warns.length, 1, 'a stream of same-reason drops warns exactly once');
  assert.equal(statuses.length, 1);

  // A different reason starts a new streak, and the first reason returning
  // after it warns again — dedup is per streak, not per deploy.
  handler({ reason: 'unsigned-rejected-require-signed' });
  handler({ reason: 'invalid-signature' });
  assert.equal(warns.length, 3);
});

test('no key configured: the surface names the missing key, not the vehicle (#243)', () => {
  // With no key every signed frame verifies false, so "invalid signature"
  // alone would send the operator to the vehicle. The gap is on this side.
  const { node, warns, statuses } = statusNode();
  makeRejectedHandler(node, { hasKey: false, acceptInvalid: false })({
    reason: 'invalid-signature',
  });
  assert.match(warns[0], /dropping signed traffic — no key configured/);
  assert.deepEqual(statuses[0], { fill: 'yellow', shape: 'ring', text: 'drop: no signing key' });
});

test('with a key present the same verdict reads as verification failure', () => {
  const { node, warns, statuses } = statusNode();
  makeRejectedHandler(node, { hasKey: true, acceptInvalid: false })({
    reason: 'invalid-signature',
  });
  assert.match(warns[0], /signature verification failed/);
  assert.equal(statuses[0].text, 'drop: invalid signature');
});

/**
 * Drive SigningState through every rejecting path so the surface is pinned to
 * the verdict vocabulary that actually exists, not to a hand-copied list.
 *
 * @returns {string[]} every distinct reject reason
 */
function liveRejectReasons() {
  const now = 4_000_000_000_000; // any modern clock ms
  const signed = (timestamp) => ({
    sysid: 1, compid: 1, linkId: 0, timestamp,
    signaturePresent: true, signatureValid: true, messageName: 'ATTITUDE',
  });
  const reasons = [];

  reasons.push(
    new SigningState({ requireSigned: true }).acceptInbound(
      { ...signed(0), signaturePresent: false }, now
    ).reason
  );
  reasons.push(
    new SigningState({}).acceptInbound({ ...signed(0), signatureValid: false }, now).reason
  );
  reasons.push(new SigningState({}).acceptInbound(signed(0), now).reason); // first contact, stale

  const fresh = timestampFromMs(now);
  const state = new SigningState({});
  state.acceptInbound(signed(fresh), now);
  reasons.push(state.acceptInbound(signed(fresh), now).reason); // not greater than last

  return reasons;
}

test('every live reject reason surfaces with a badge inside the §6 cap', () => {
  const reasons = liveRejectReasons();
  assert.deepEqual(
    [...new Set(reasons)].sort(),
    [
      'first-contact-too-old',
      'invalid-signature',
      'replay-or-out-of-order',
      'unsigned-rejected-require-signed',
    ],
    'the harness exercised the whole reject vocabulary of signing.js'
  );
  for (const reason of reasons) {
    const { node, warns, statuses } = statusNode();
    makeRejectedHandler(node, { hasKey: true, acceptInvalid: false })({ reason });
    assert.equal(warns.length, 1, `${reason} must warn`);
    assert.match(warns[0], /dropping/, `${reason} warn text names a drop`);
    assert.equal(statuses.length, 1, `${reason} must badge`);
    assert.ok(
      statuses[0].text.length <= BADGE_MAX,
      `${reason} badge '${statuses[0].text}' exceeds the §6 cap`
    );
  }
});

test('accept-invalid on: drop badges yield to the untrusted badge, warns still land', () => {
  const { node, warns, statuses } = statusNode();
  const handler = makeRejectedHandler(node, { hasKey: true, acceptInvalid: true });
  handler({ reason: 'replay-or-out-of-order' });
  assert.equal(warns.length, 1, 'the warn is not suppressed');
  assert.equal(statuses.length, 0, 'the conspicuous UNTRUSTED badge must stay visible');
});

test('accept-invalid on shows connected as conspicuously untrusted (DESIGN §7)', () => {
  const { node, statuses } = statusNode();
  applyStatus(node, STATE.CONNECTED, true);
  assert.deepEqual(
    statuses[0],
    { fill: 'red', shape: 'dot', text: 'connected — UNTRUSTED' },
    'red dot, not the settled green — and without waiting for a frame'
  );

  applyStatus(node, STATE.CONNECTED, false);
  assert.deepEqual(statuses[1], { fill: 'green', shape: 'dot', text: 'connected' });

  // The override changes only the connected badge — error stays error.
  applyStatus(node, STATE.ERROR, true);
  assert.deepEqual(statuses[2], { fill: 'red', shape: 'ring', text: 'error' });
});

test('the node wires the rejected handler and the untrusted flag into the runtime', () => {
  // Same source-scan style as connection-node-guards' resolveSourceIds pin:
  // the helpers alone are not enough — the constructor must attach them.
  const source = fs.readFileSync(
    path.join(__dirname, '..', '..', 'nodes', 'mavlink-connection.js'),
    'utf8'
  );
  assert.match(
    source,
    /node\.connection\.on\('rejected', makeRejectedHandler\(node, signing\)\)/,
    'the rejected event has a consumer in the node'
  );
  assert.match(
    source,
    /node\.connection\.on\('state', \(state\) => applyStatus\(node, state, signing\.acceptInvalid\)\)/,
    'every state badge carries the untrusted flag'
  );
});

