'use strict';

/**
 * Per-endpoint stream decoders (DESIGN.md §7): a partial MAVLink frame from
 * peer A must not poison peer B's next bytes.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadBundled } = require('../../lib/metadata');
const { createWire, DEFAULT_MAX_DECODERS } = require('../../lib/connection/wire');

const EP_A = { address: '10.0.0.1', port: 14550 };
const EP_B = { address: '10.0.0.2', port: 14551 };
const SIGNING_KEY = Buffer.alloc(32, 7);

function heartbeatFrame(wire) {
  return wire.serialize(
    {
      name: 'HEARTBEAT',
      fields: {
        type: 0,
        autopilot: 0,
        base_mode: 0,
        custom_mode: 0,
        system_status: 0,
        mavlink_version: 3,
      },
    },
    { sysid: 1, compid: 1, seq: 0 }
  );
}

test('partial frame on endpoint A does not contaminate a full frame on endpoint B', () => {
  const wire = createWire({ bundle: loadBundled('minimal') });
  const full = heartbeatFrame(wire);
  assert.ok(full.length > 8, 'expected a non-trivial HEARTBEAT frame');

  // Feed only the start of a frame to A — leftover must stay on A's splitter.
  const partial = full.subarray(0, Math.min(6, full.length - 1));
  assert.equal(wire.decode(partial, EP_A).length, 0);

  const fromB = wire.decode(full, EP_B);
  assert.equal(fromB.length, 1, 'B must decode a clean HEARTBEAT despite A partial');
  assert.equal(fromB[0].name, 'HEARTBEAT');

  // Completing A's frame on A still works (same stream).
  const rest = full.subarray(partial.length);
  const fromA = wire.decode(rest, EP_A);
  assert.equal(fromA.length, 1);
  assert.equal(fromA[0].name, 'HEARTBEAT');

  assert.equal(wire.decoderCount(), 2);
});

test('releaseDecoder drops a peer pipeline; next bytes start fresh', () => {
  const wire = createWire({ bundle: loadBundled('minimal') });
  const full = heartbeatFrame(wire);
  wire.decode(full.subarray(0, 6), EP_A);
  assert.equal(wire.decoderCount(), 1);
  wire.releaseDecoder(EP_A);
  assert.equal(wire.decoderCount(), 0);

  // After release, a full frame on A decodes without needing the old remainder.
  const frames = wire.decode(full, EP_A);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].name, 'HEARTBEAT');
});

test('evictIdleDecoders removes stale UDP pipelines', () => {
  const wire = createWire({ bundle: loadBundled('minimal') });
  const full = heartbeatFrame(wire);
  wire.decode(full, EP_A);
  wire.decode(full, EP_B);
  assert.equal(wire.decoderCount(), 2);

  const removed = wire.evictIdleDecoders(Date.now() + 60_000, 30_000);
  assert.equal(removed, 2);
  assert.equal(wire.decoderCount(), 0);
});

test('clearDecoders empties every pipeline', () => {
  const wire = createWire({ bundle: loadBundled('minimal') });
  const full = heartbeatFrame(wire);
  wire.decode(full, EP_A);
  wire.decode(full, EP_B);
  wire.clearDecoders();
  assert.equal(wire.decoderCount(), 0);
});

test('omit endpoint still decodes (serial / single-stream fallback)', () => {
  const wire = createWire({ bundle: loadBundled('minimal') });
  const full = heartbeatFrame(wire);
  const frames = wire.decode(full);
  assert.equal(frames.length, 1);
  assert.equal(wire.decoderCount(), 1);
});

test('default max decoder cap is 100', () => {
  const wire = createWire({ bundle: loadBundled('minimal') });
  assert.equal(DEFAULT_MAX_DECODERS, 100);
  assert.equal(wire.maxDecoderCount(), 100);
});

test('decoder map LRU-evicts when over maxDecoders (UDP churn bound)', () => {
  const wire = createWire({ bundle: loadBundled('minimal'), maxDecoders: 2 });
  const full = heartbeatFrame(wire);
  const ep = (n) => ({ address: '10.0.0.' + n, port: 14550 });
  // Same `now` for every call — Map re-insertion order must decide warmth, not
  // millisecond Date.now() advancement (CodeRabbit #33).
  const t = 1_000_000;

  wire.decode(full, ep(1), t);
  wire.decode(full, ep(2), t);
  assert.equal(wire.decoderCount(), 2);

  // Touch ep(1) so it is warmer than ep(2); allocating ep(3) should drop ep(2).
  wire.decode(full, ep(1), t);
  wire.decode(full, ep(3), t);
  assert.equal(wire.decoderCount(), 2);

  // ep(1) still warm — completing a partial there must not need a fresh sync hunt
  // from a wiped pipeline. ep(2) was evicted.
  const partial = full.subarray(0, 6);
  assert.equal(wire.decode(partial, ep(1), t).length, 0);
  assert.equal(wire.decode(full.subarray(6), ep(1), t).length, 1);

  // Fresh ep(2) after eviction starts clean (full frame decodes alone).
  assert.equal(wire.decode(full, ep(2), t).length, 1);
});

test('cap pressure prefers never-validated pipelines over a live peer mid-frame', () => {
  const wire = createWire({ bundle: loadBundled('minimal'), maxDecoders: 2 });
  const full = heartbeatFrame(wire);
  const ep = (n) => ({ address: '10.0.0.' + n, port: 14550 });
  const t = 2_000_000;
  const junk = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);

  // Legitimate peer validates, then parks a partial frame.
  assert.equal(wire.decode(full, ep(1), t).length, 1);
  assert.equal(wire.decode(full.subarray(0, 6), ep(1), t + 1).length, 0);

  // Spoof fills the last slot without ever validating.
  assert.equal(wire.decode(junk, ep(2), t + 2).length, 0);
  assert.equal(wire.decoderCount(), 2);

  // Another spoof must evict the never-validated slot, not the mid-frame peer.
  assert.equal(wire.decode(junk, ep(3), t + 3).length, 0);
  assert.equal(wire.decoderCount(), 2);

  // Completing the legitimate partial still works.
  assert.equal(wire.decode(full.subarray(6), ep(1), t + 4).length, 1);
});

test('an UNKNOWN_<id> frame surfaces but does not earn eviction standing', () => {
  // Surfacing an unverifiable frame must not hand its sender the standing a
  // CRC-verified peer earns: UNKNOWN_<id> is trivially forgeable, so if it
  // promoted the decoder past the first eviction tier, one spoofed datagram
  // would buy protection from the source-churn guard (Greptile #33, Gitar #344).
  const wire = createWire({ bundle: loadBundled('minimal'), maxDecoders: 2 });
  const common = createWire({ bundle: loadBundled('common') });
  const unknown = common.serialize(
    {
      name: 'PARAM_VALUE',
      fields: { param_id: 'X', param_value: 1, param_type: 9, param_count: 1, param_index: 0 },
    },
    { sysid: 7, compid: 1, seq: 0 }
  );
  const ep = (n) => ({ address: `10.0.0.${n}`, port: 14550 });
  const t = 4_000_000;

  // The frame reaches the flow — that is the whole point of the feature.
  assert.equal(wire.decode(unknown, ep(1), t)[0].name, 'UNKNOWN_22');

  // A real peer validates and parks a partial; the spoof fills the last slot.
  assert.equal(wire.decode(heartbeatFrame(wire), ep(2), t + 1).length, 1);
  assert.equal(
    wire.decode(heartbeatFrame(wire).subarray(0, 6), ep(2), t + 2).length,
    0
  );
  assert.equal(wire.decoderCount(), 2);

  // Allocating a third endpoint must evict the unknown-only slot, not the
  // mid-frame peer — proof the unknown frame never set `validated`.
  assert.equal(wire.decode(heartbeatFrame(wire), ep(3), t + 3).length, 1);
  assert.equal(wire.decoderCount(), 2);
  assert.equal(
    wire.decode(heartbeatFrame(wire).subarray(6), ep(2), t + 4).length,
    1,
    'the mid-frame peer survived and completed its frame'
  );
});

test('cap pressure prefers empty-buffer validated over a mid-frame peer', () => {
  const wire = createWire({ bundle: loadBundled('minimal'), maxDecoders: 2 });
  const full = heartbeatFrame(wire);
  const ep = (n) => ({ address: '10.0.0.' + n, port: 14550 });
  const t = 3_000_000;

  // Both peers validate. ep(1) then parks a partial; ep(2) stays buffer-empty.
  assert.equal(wire.decode(full, ep(1), t).length, 1);
  assert.equal(wire.decode(full, ep(2), t + 1).length, 1);
  assert.equal(wire.decode(full.subarray(0, 6), ep(1), t + 2).length, 0);

  // Allocating ep(3) must drop the empty-buffer peer, not the mid-frame one
  // (Greptile #33 residual once every slot is validated).
  assert.equal(wire.decode(full, ep(3), t + 3).length, 1);
  assert.equal(wire.decoderCount(), 2);

  assert.equal(wire.decode(full.subarray(6), ep(1), t + 4).length, 1);
  // ep(2) was evicted — a fresh full frame still decodes alone.
  assert.equal(wire.decode(full, ep(2), t + 5).length, 1);
});

test('cap pressure keeps a never-validated first-frame partial over junk', () => {
  const wire = createWire({ bundle: loadBundled('minimal'), maxDecoders: 2 });
  const full = heartbeatFrame(wire);
  const ep = (n) => ({ address: '10.0.0.' + n, port: 14550 });
  const t = 4_000_000;
  const junk = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);

  // New peer: first bytes of first frame — not validated yet, but STX-buffered.
  assert.equal(wire.decode(full.subarray(0, 6), ep(1), t).length, 0);
  assert.equal(wire.decode(junk, ep(2), t + 1).length, 0);
  assert.equal(wire.decoderCount(), 2);

  // More junk must drop the non-STX spoof, not the first-frame partial
  // (Greptile #33: never-validated tier must not wipe a started MAVLink frame).
  assert.equal(wire.decode(junk, ep(3), t + 2).length, 0);
  assert.equal(wire.decoderCount(), 2);

  assert.equal(wire.decode(full.subarray(6), ep(1), t + 3).length, 1);
});

test('a msgid the bound dialect does not carry surfaces as UNKNOWN_<id>, not silence', () => {
  // A vehicle speaking a newer dialect than the bound profile used to vanish
  // frame by frame — the one clue that diagnoses the mismatch (the id) was
  // dropped before anything could show it. The raw payload rides so the frame
  // is inspectable; a known frame in the same stream decodes as always.
  const minimal = createWire({ bundle: loadBundled('minimal') });
  const common = createWire({ bundle: loadBundled('common') });
  const paramValue = common.serialize(
    {
      name: 'PARAM_VALUE',
      fields: { param_id: 'X', param_value: 1, param_type: 9, param_count: 1, param_index: 0 },
    },
    { sysid: 7, compid: 1, seq: 0 }
  );

  const frames = minimal.decode(Buffer.concat([paramValue, heartbeatFrame(minimal)]), EP_A);

  assert.equal(frames.length, 2, 'both frames surface');
  assert.equal(frames[0].name, 'UNKNOWN_22');
  assert.equal(frames[0].sysid, 7);
  assert.equal(frames[0].compid, 1);
  assert.equal(frames[0].fields.msgid, 22);
  assert.equal(frames[0].crcVerified, false, 'an unknown msgid is unverifiable by construction');
  // Byte-for-byte against the wire, not just "is a Buffer": node-mavlink
  // hands out a fixed 255-byte payload buffer, so an untrimmed frame passes
  // an isBuffer check while carrying 230 bytes of padding the sender never
  // sent (CodeRabbit #344). The v2 header's length byte is the wire length.
  assert.deepEqual(
    frames[0].fields.payload,
    paramValue.subarray(10, 10 + paramValue[1]),
    'the payload is exactly the bytes that arrived'
  );
  assert.equal(frames[1].name, 'HEARTBEAT', 'known frames are unaffected');
  assert.equal(frames[1].crcVerified, true, 'a known msgid whose CRC checked out');
});

test('a signed UNKNOWN_<id> frame carries its signature verdict like any other', () => {
  // The signature block is framing, not payload semantics — it verifies
  // without the message definition, so an unknown id is exactly as signable
  // as a known one. If the verdict did not ride, requireSigned would read a
  // properly signed unknown frame as unsigned and drop it (CodeRabbit #344).
  const minimal = createWire({ bundle: loadBundled('minimal'), key: SIGNING_KEY });
  const common = createWire({ bundle: loadBundled('common') });
  const signed = common.serialize(
    {
      name: 'PARAM_VALUE',
      fields: { param_id: 'X', param_value: 1, param_type: 9, param_count: 1, param_index: 0 },
    },
    { sysid: 7, compid: 1, seq: 0, sign: true, linkId: 3, key: SIGNING_KEY, timestamp: 1_234_567 }
  );

  const [frame] = minimal.decode(signed, EP_A);

  assert.equal(frame.name, 'UNKNOWN_22');
  assert.equal(frame.signaturePresent, true);
  assert.equal(frame.signatureValid, true, 'the HMAC verifies without the definition');
  assert.equal(frame.linkId, 3);
  assert.equal(frame.timestamp, 1_234_567);
  assert.deepEqual(
    frame.fields.payload,
    signed.subarray(10, 10 + signed[1]),
    'the signature block is not mistaken for payload'
  );
});

test('a CRC-corrupt frame on a known msgid is counted; clean and UNKNOWN frames are not', () => {
  // A failed CRC means the bytes lied, so the sysid cannot be trusted enough to
  // build a message from — the frame is dropped inside the splitter and the
  // tally is the only thing a flow can see. It is per wire: every endpoint on
  // one Connection adds to the same number.
  const minimal = createWire({ bundle: loadBundled('minimal') });
  const common = createWire({ bundle: loadBundled('common') });
  assert.equal(minimal.crcFailureCount(), 0);

  const full = heartbeatFrame(minimal);
  assert.equal(minimal.decode(full, EP_A).length, 1);
  assert.equal(minimal.crcFailureCount(), 0, 'a frame that verifies is not corruption');

  // A msgid the bound dialect does not carry is a dialect mismatch, and it
  // already surfaces as a message — it must leave the corruption tally alone.
  const paramValue = common.serialize(
    {
      name: 'PARAM_VALUE',
      fields: { param_id: 'X', param_value: 1, param_type: 9, param_count: 1, param_index: 0 },
    },
    { sysid: 7, compid: 1, seq: 0 }
  );
  assert.equal(minimal.decode(paramValue, EP_A)[0].name, 'UNKNOWN_22');
  assert.equal(minimal.crcFailureCount(), 0, 'a dialect mismatch is not a bad link');

  // Last byte of a HEARTBEAT frame is the high half of its checksum.
  const corrupt = Buffer.from(full);
  corrupt[corrupt.length - 1] ^= 0xff;
  assert.equal(minimal.decode(corrupt, EP_A).length, 0, 'the corrupt frame is still dropped');
  assert.equal(minimal.crcFailureCount(), 1);

  assert.equal(minimal.decode(corrupt, EP_B).length, 0);
  assert.equal(minimal.crcFailureCount(), 2, 'endpoints share one Connection-wide count');
});
