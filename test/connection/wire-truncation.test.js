'use strict';

/**
 * MAVLink v2 trailing-zero truncation must never produce a zero-length
 * payload: node-mavlink trims every trailing zero, and spec-strict peers
 * (pymavlink's parser, ArduPilot) drop a v2 frame whose length byte is 0
 * (measured: a broadcast PARAM_REQUEST_LIST, all-zero payload, never
 * answered). The wire adapter restores the one-byte minimum and recomputes
 * the CRC over the frame actually sent — before signing, so the signature
 * covers the fixed bytes.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadBundled } = require('../../lib/metadata');
const { createWire } = require('../../lib/connection/wire');
const { SigningState } = require('../../lib/connection/signing');

const KEY = Buffer.from('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd', 'hex');

const CTX = { sysid: 255, compid: 190, seq: 0 };

test('an all-zero v2 payload goes on the wire as one zero byte, not zero bytes', () => {
  const wire = createWire({ bundle: loadBundled('common') });
  const frame = wire.serialize(
    { name: 'PARAM_REQUEST_LIST', fields: { target_system: 0, target_component: 0 } },
    CTX
  );

  assert.equal(frame[1], 1, 'the length byte is the one-byte minimum');
  assert.equal(frame.length, 13, '10 header + 1 payload + 2 CRC');
  assert.equal(frame[10], 0, 'the restored payload byte is the truncated zero');

  // The recomputed CRC must verify — decode() drops a CRC-failing frame, so a
  // round-trip is the proof, and the trimmed zeros must read back as spoken.
  const [decoded] = wire.decode(frame);
  assert.equal(decoded.name, 'PARAM_REQUEST_LIST');
  assert.equal(decoded.crcVerified, true);
  assert.equal(decoded.fields.target_system, 0);
  assert.equal(decoded.fields.target_component, 0);
});

test('a non-zero payload is untouched by the one-byte minimum', () => {
  const wire = createWire({ bundle: loadBundled('common') });
  const frame = wire.serialize(
    { name: 'PARAM_REQUEST_LIST', fields: { target_system: 0, target_component: 1 } },
    CTX
  );

  assert.equal(frame[1], 2, 'both payload bytes survived truncation as before');
  assert.equal(frame.length, 14);

  const [decoded] = wire.decode(frame);
  assert.equal(decoded.fields.target_system, 0);
  assert.equal(decoded.fields.target_component, 1);
});

test('a signed all-zero frame still verifies — the signature covers the fixed frame', () => {
  const wire = createWire({ bundle: loadBundled('common'), key: KEY });
  const signing = new SigningState({ signOutbound: true, hasKey: true, linkId: 0 });
  const timestamp = signing.nextOutboundTimestamp(CTX.sysid, CTX.compid);

  const frame = wire.serialize(
    { name: 'PARAM_REQUEST_LIST', fields: { target_system: 0, target_component: 0 } },
    { ...CTX, sign: true, linkId: 0, key: KEY, timestamp }
  );

  assert.equal(frame[1], 1, 'the fix ran before the signature block was appended');
  assert.equal(frame.length, 26, '13 fixed frame + 13 signature');

  const [decoded] = wire.decode(frame);
  assert.equal(decoded.name, 'PARAM_REQUEST_LIST');
  assert.equal(decoded.signaturePresent, true);
  assert.equal(decoded.signatureValid, true, 'the HMAC covers the one-byte-payload frame');
  assert.equal(decoded.timestamp, timestamp);
});
