'use strict';

/**
 * Per-endpoint stream decoders (DESIGN.md §7): a partial MAVLink frame from
 * peer A must not poison peer B's next bytes.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadBundled } = require('../../lib/metadata');
const { createWire } = require('../../lib/connection/wire');

const EP_A = { address: '10.0.0.1', port: 14550 };
const EP_B = { address: '10.0.0.2', port: 14551 };

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
