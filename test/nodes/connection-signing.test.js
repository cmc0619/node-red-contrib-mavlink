'use strict';

/**
 * nodes/mavlink-connection.js buildSigning() (DESIGN.md §7 "Signing"). A
 * passphrase must derive a verification key regardless of the sign-outbound /
 * require-signed checkboxes — those two remain independent policy switches
 * (outbound signing, inbound rejection), not gates on whether a key exists to
 * verify against at all.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildSigning } = require('../../nodes/mavlink-connection');

test('a passphrase alone (both checkboxes off) still derives a key', () => {
  const signing = buildSigning(
    { signOutbound: false, requireSigned: false },
    { signingPassphrase: 'correct horse battery staple' }
  );
  assert.equal(signing.hasKey, true);
  assert.ok(Buffer.isBuffer(signing.key), 'key must be derived even with both switches off');
  assert.equal(signing.signOutbound, false, 'sign-outbound policy is unaffected');
  assert.equal(signing.requireSigned, false, 'require-signed policy is unaffected');
});

test('no passphrase means no key, regardless of the switches', () => {
  const signing = buildSigning({ signOutbound: false, requireSigned: true }, {});
  assert.equal(signing.hasKey, false);
  assert.equal(signing.key, null);
});

test('sign-outbound and require-signed still carry through as independent policy flags', () => {
  const signing = buildSigning(
    { signOutbound: true, requireSigned: true },
    { signingPassphrase: 'secret' }
  );
  assert.equal(signing.signOutbound, true);
  assert.equal(signing.requireSigned, true);
  assert.ok(signing.key, 'key still derives when the switches are on too');
});

test('a raw hex key becomes the key bytes verbatim — no hashing', () => {
  const hex = 'aa'.repeat(16) + 'bb'.repeat(16); // 64 hex chars, 32 bytes
  const signing = buildSigning({ signOutbound: true }, { signingKeyHex: hex });
  assert.equal(signing.hasKey, true);
  assert.ok(Buffer.isBuffer(signing.key));
  assert.equal(signing.key.length, 32);
  assert.equal(signing.key.toString('hex'), hex, 'raw bytes pass through untouched');
});

test('raw key hex is case-insensitive and tolerates surrounding whitespace', () => {
  const hex = 'AbCdEf'.repeat(10) + 'AbCd'; // 64 chars mixed case
  const signing = buildSigning({}, { signingKeyHex: `  ${hex}  ` });
  assert.equal(signing.key.toString('hex'), hex.toLowerCase());
});

test('passphrase AND raw key together fail loud — the connection never guesses', () => {
  assert.throws(
    () => buildSigning({}, { signingPassphrase: 'secret', signingKeyHex: 'aa'.repeat(32) }),
    /both a signing passphrase and a raw signing key/
  );
});

test('a malformed raw key fails loud naming the requirement', () => {
  // Too short, and non-hex characters — both must reject, never truncate/pad.
  assert.throws(() => buildSigning({}, { signingKeyHex: 'abc123' }), /64 hex characters/);
  assert.throws(() => buildSigning({}, { signingKeyHex: 'zz'.repeat(32) }), /64 hex characters/);
});
