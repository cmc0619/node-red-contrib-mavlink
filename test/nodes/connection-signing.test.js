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
