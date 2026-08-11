'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { SigningState, timestampFromMs, ONE_MINUTE_UNITS } = require('../../lib/connection/signing');

const NOW_MS = 1893456000000; // some 2030 wall-clock; the exact value is irrelevant
const NOW_UNITS = timestampFromMs(NOW_MS);

/**
 * @param {object} overrides
 * @returns {object}
 */
function frame(overrides) {
  return {
    sysid: 1,
    compid: 1,
    linkId: 0,
    timestamp: NOW_UNITS,
    signaturePresent: true,
    signatureValid: true,
    messageName: 'ATTITUDE',
    ...overrides,
  };
}

test('first contact accepts a valid, recent signature and sets the floor', () => {
  const s = new SigningState({ now: () => NOW_MS });
  const v = s.acceptInbound(frame({}));
  assert.equal(v.accept, true);
  assert.equal(v.trusted, true);
  assert.equal(v.reason, 'first-contact');
  assert.equal(s.lastInboundTimestamp(1, 1, 0), NOW_UNITS);
});

test('first contact rejects a timestamp more than a minute behind local time', () => {
  const s = new SigningState({ now: () => NOW_MS });
  const v = s.acceptInbound(frame({ timestamp: NOW_UNITS - ONE_MINUTE_UNITS - 1 }));
  assert.equal(v.accept, false);
  assert.equal(v.reason, 'first-contact-too-old');
  assert.equal(s.lastInboundTimestamp(1, 1, 0), undefined);
});

test('an out-of-order (non-increasing) timestamp is rejected', () => {
  const s = new SigningState({ now: () => NOW_MS });
  s.acceptInbound(frame({ timestamp: NOW_UNITS }));
  const v = s.acceptInbound(frame({ timestamp: NOW_UNITS })); // equal → not greater
  assert.equal(v.accept, false);
  assert.equal(v.reason, 'replay-or-out-of-order');
});

test('a lagging but monotonic established stream stays accepted — the floor is first-contact only (#264)', () => {
  // First contact within the floor, then local time runs 20 minutes ahead
  // while the peer's clock (no GPS lock, clock reset) falls more than a minute
  // behind it. Monotonicity alone governs the established stream: a captured
  // packet can never exceed the last accepted timestamp, so the floor would
  // have guarded nothing and locked the real peer out (§7 signing, #264).
  const s = new SigningState({ now: () => NOW_MS });
  s.acceptInbound(frame({ timestamp: NOW_UNITS }));
  const later = NOW_MS + 20 * 60 * 1000;
  const v = s.acceptInbound(frame({ timestamp: NOW_UNITS + 1 }), later);
  assert.equal(v.accept, true);
  assert.equal(v.trusted, true);
  assert.equal(v.reason, 'accepted');
  assert.equal(s.lastInboundTimestamp(1, 1, 0), NOW_UNITS + 1);
});

test('the store never advances from a packet admitted by accept-invalid', () => {
  const s = new SigningState({ acceptInvalid: true, now: () => NOW_MS });
  s.acceptInbound(frame({ timestamp: NOW_UNITS })); // valid, sets floor
  const v = s.acceptInbound(
    frame({ timestamp: NOW_UNITS + 1000, signatureValid: false }) // higher, but forged
  );
  assert.equal(v.accept, true);
  assert.equal(v.trusted, false); // advisory only
  assert.equal(v.reason, 'invalid-accepted-untrusted');
  assert.equal(s.lastInboundTimestamp(1, 1, 0), NOW_UNITS); // floor unchanged
});

test('an invalid signature is rejected outright when accept-invalid is off', () => {
  const s = new SigningState({ now: () => NOW_MS });
  const v = s.acceptInbound(frame({ signatureValid: false }));
  assert.equal(v.accept, false);
  assert.equal(v.reason, 'invalid-signature');
});

test('require-signed drops unsigned frames but keeps the RADIO_STATUS allowlist', () => {
  const s = new SigningState({ requireSigned: true, now: () => NOW_MS });
  const dropped = s.acceptInbound(frame({ signaturePresent: false, messageName: 'ATTITUDE' }));
  assert.equal(dropped.accept, false);
  assert.equal(dropped.reason, 'unsigned-rejected-require-signed');

  const allowed = s.acceptInbound(frame({ signaturePresent: false, messageName: 'RADIO_STATUS' }));
  assert.equal(allowed.accept, true);
  assert.equal(allowed.trusted, false); // allowlisted, never trusted
});

test('unsigned frames carry no trust mark when require-signed is off (§7 trust ruling #264)', () => {
  // `false` is the explicit untrusted mark that bars a frame from settling
  // transactions; a plain unsigned link has no signing regime to judge
  // against, so the verdict stays unmarked and trusted-only gates pass it.
  const s = new SigningState({ now: () => NOW_MS });
  const v = s.acceptInbound(frame({ signaturePresent: false }));
  assert.equal(v.accept, true);
  assert.equal(v.trusted, undefined);
});

test('outbound timestamps are strictly increasing per stream', () => {
  const s = new SigningState({ now: () => NOW_MS });
  const a = s.nextOutboundTimestamp(255, 190);
  const b = s.nextOutboundTimestamp(255, 190);
  assert.ok(b > a);
});

test('a stalled clock still yields strictly increasing outbound timestamps', () => {
  let t = NOW_MS;
  const s = new SigningState({ now: () => t });
  const a = s.nextOutboundTimestamp(1, 1);
  // clock does not advance between messages
  const b = s.nextOutboundTimestamp(1, 1);
  assert.equal(b, a + 1); // +1 guarantees monotonicity even without clock movement
});

test('the outbound sequence wraps 0..255', () => {
  const s = new SigningState();
  const seqs = [];
  for (let i = 0; i < 257; i += 1) seqs.push(s.nextSeq(1, 1));
  assert.equal(seqs[0], 0);
  assert.equal(seqs[255], 255);
  assert.equal(seqs[256], 0); // wrapped
});

test('each source component gets its own sequence stream (issue #92)', () => {
  // Receivers do loss detection per (sysid, compid); interleaving two
  // identities on one counter would show phantom gaps in both streams.
  const s = new SigningState();
  assert.equal(s.nextSeq(255, 190), 0);
  assert.equal(s.nextSeq(255, 190), 1);
  assert.equal(s.nextSeq(255, 191), 0); // second identity starts fresh
  assert.equal(s.nextSeq(255, 190), 2); // first stream unaffected
  assert.equal(s.nextSeq(255, 191), 1);
  assert.equal(s.nextSeq(254, 190), 0); // same compid, different sysid: fresh stream
  assert.equal(s.nextSeq(255, 190), 3); // original stream still independent
});

test('sign-outbound with no key fails the connection closed', () => {
  const on = new SigningState({ signOutbound: true, hasKey: false });
  assert.equal(on.validate().ok, false);
  const ok = new SigningState({ signOutbound: true, hasKey: true });
  assert.equal(ok.validate().ok, true);
  const off = new SigningState({ signOutbound: false, hasKey: false });
  assert.equal(off.validate().ok, true); // signing off is the normal case
});

test('two connections sharing a key still carry distinct link IDs', () => {
  const a = new SigningState({ linkId: 1 });
  const b = new SigningState({ linkId: 2 });
  assert.notEqual(a.linkId, b.linkId);
});
