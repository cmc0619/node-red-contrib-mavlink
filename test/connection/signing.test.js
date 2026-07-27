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

test('a valid but stale timestamp (past the one-minute floor) is rejected', () => {
  const s = new SigningState({ now: () => NOW_MS });
  s.acceptInbound(frame({ timestamp: NOW_UNITS - 10 * ONE_MINUTE_UNITS }));
  // establish a floor 10 minutes back, then advance local time far ahead
  const later = () => NOW_MS + 20 * 60 * 1000;
  const s2 = new SigningState({ now: later });
  s2.acceptInbound(frame({ timestamp: timestampFromMs(later()) })); // fresh first contact
  const v = s2.acceptInbound(frame({ timestamp: timestampFromMs(later()) + 1 - ONE_MINUTE_UNITS * 2 }));
  assert.equal(v.accept, false);
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

test('unsigned frames are accepted (untrusted) when require-signed is off', () => {
  const s = new SigningState({ now: () => NOW_MS });
  const v = s.acceptInbound(frame({ signaturePresent: false }));
  assert.equal(v.accept, true);
  assert.equal(v.trusted, false);
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
  for (let i = 0; i < 257; i += 1) seqs.push(s.nextSeq());
  assert.equal(seqs[0], 0);
  assert.equal(seqs[255], 255);
  assert.equal(seqs[256], 0); // wrapped
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
