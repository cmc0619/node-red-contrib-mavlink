'use strict';

/**
 * The wire's signed-serialize path must carry the caller's own monotonic
 * per-stream timestamp (`ctx.timestamp`, produced by
 * SigningState#nextOutboundTimestamp — §7 "Timestamps and replay") through to
 * the signature block, rather than silently substituting node-mavlink's own
 * Date.now()-based default.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadBundled } = require('../../lib/metadata/bundled');
const { createWire } = require('../../lib/connection/wire');
const { SigningState } = require('../../lib/connection/signing');

const KEY = Buffer.from('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd', 'hex');

function heartbeatFields() {
  return { type: 6, autopilot: 8, base_mode: 0, custom_mode: 0, system_status: 0, mavlink_version: 3 };
}

test('a signed frame carries ctx.timestamp on the wire, not node-mavlink’s own clock default', () => {
  const wire = createWire({ bundle: loadBundled('minimal'), key: KEY });
  const ctxTimestamp = 12345678; // an arbitrary 48-bit signing-epoch value, far from Date.now()

  const buffer = wire.serialize(
    { name: 'HEARTBEAT', fields: heartbeatFields() },
    { sysid: 1, compid: 1, seq: 0, sign: true, linkId: 3, key: KEY, timestamp: ctxTimestamp }
  );

  const [decoded] = wire.decode(buffer);
  assert.equal(decoded.signaturePresent, true);
  assert.equal(decoded.signatureValid, true);
  assert.equal(decoded.linkId, 3);
  assert.equal(decoded.timestamp, ctxTimestamp);
});

test('signing state’s per-stream timestamps land on the wire and stay monotonic', () => {
  const wire = createWire({ bundle: loadBundled('minimal'), key: KEY });
  const signing = new SigningState({ signOutbound: true, hasKey: true, linkId: 0 });

  const first = signing.nextOutboundTimestamp(1, 1);
  const second = signing.nextOutboundTimestamp(1, 1);
  assert.ok(second > first);

  const frame1 = wire.serialize(
    { name: 'HEARTBEAT', fields: heartbeatFields() },
    { sysid: 1, compid: 1, seq: 0, sign: true, linkId: 0, key: KEY, timestamp: first }
  );
  const frame2 = wire.serialize(
    { name: 'HEARTBEAT', fields: heartbeatFields() },
    { sysid: 1, compid: 1, seq: 1, sign: true, linkId: 0, key: KEY, timestamp: second }
  );

  assert.equal(wire.decode(frame1)[0].timestamp, first);
  assert.equal(wire.decode(frame2)[0].timestamp, second);
});
