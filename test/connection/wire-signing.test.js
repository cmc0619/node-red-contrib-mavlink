'use strict';

/**
 * Outbound signing at the wire boundary: the signature block must carry the
 * timestamp SigningState computed (§7 "Timestamps and replay" — strictly
 * increasing per stream, at least +1 per message), not node-mavlink's internal
 * Date.now() value, and the HMAC must still verify over it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadBundled } = require('../../lib/metadata');
const { createWire } = require('../../lib/connection/wire');
const { SigningState } = require('../../lib/connection/signing');

const { MavLinkPacketSignature } = require('node-mavlink');
const KEY = MavLinkPacketSignature.key('a shared passphrase');

const HEARTBEAT = {
  name: 'HEARTBEAT',
  fields: { type: 6, autopilot: 8, base_mode: 0, custom_mode: 0, system_status: 0, mavlink_version: 3 },
};

test('a signed frame carries the SigningState timestamp and verifies against the key', () => {
  const wire = createWire({ bundle: loadBundled('minimal'), key: KEY });
  const signing = new SigningState({ linkId: 2, signOutbound: true, hasKey: true });
  const timestamp = signing.nextOutboundTimestamp(255, 190);

  const frame = wire.serialize(HEARTBEAT, {
    sysid: 255,
    compid: 190,
    seq: 0,
    sign: true,
    linkId: 2,
    key: KEY,
    timestamp,
  });

  const [decoded] = wire.decode(frame);
  assert.equal(decoded.signaturePresent, true);
  assert.equal(decoded.signatureValid, true, 'the HMAC must cover the rewritten timestamp');
  assert.equal(decoded.linkId, 2);
  assert.equal(decoded.timestamp, timestamp);
});

test('successive signed frames increment the wire timestamp monotonically', () => {
  const wire = createWire({ bundle: loadBundled('minimal'), key: KEY });
  const signing = new SigningState({ linkId: 0, signOutbound: true, hasKey: true });

  const stamps = [0, 1, 2].map((seq) => {
    const frame = wire.serialize(HEARTBEAT, {
      sysid: 1,
      compid: 1,
      seq,
      sign: true,
      linkId: 0,
      key: KEY,
      timestamp: signing.nextOutboundTimestamp(1, 1),
    });
    return wire.decode(frame)[0].timestamp;
  });

  assert.ok(stamps[1] > stamps[0], `expected increasing timestamps, got ${stamps}`);
  assert.ok(stamps[2] > stamps[1], `expected increasing timestamps, got ${stamps}`);
});
