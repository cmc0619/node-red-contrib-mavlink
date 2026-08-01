'use strict';

/**
 * Signing channel state (DESIGN.md §7 "Config nodes", "Signing", "Timestamps
 * and replay"). Signing is a property of the *link*, so its state — link ID,
 * outgoing sequence, and replay memory — belongs to the Connection, not the
 * identity. This state model is present from the first commit even though
 * signing is off by default at runtime: the feature is optional, the state that
 * accommodates it is not, and bolting it on later means reworking Connection
 * (§12 step 4).
 *
 * `node-mavlink` provides the signing and verification primitives (computing and
 * matching the HMAC); accept/reject **policy**, the unsigned allowlist, and the
 * timestamp store are ours. This module owns only the policy and the store — it
 * computes no HMAC.
 *
 * The timestamp is 48 bits in 10 µs units since 1 January 2015 GMT — an offset
 * of 1 420 070 400 seconds from the Unix epoch. A logical stream is the tuple
 * (system ID, component ID, link ID), and every rule is per stream.
 */

/** Seconds between the Unix epoch and the MAVLink signing epoch (2015-01-01). */
const MAVLINK_EPOCH_UNIX_S = 1420070400;
/** One minute expressed in 10 µs units: 60 s × 100 000. */
const ONE_MINUTE_UNITS = 6000000;
/** Units per millisecond: 1 ms = 100 × 10 µs. */
const UNITS_PER_MS = 100;

/**
 * Message types accepted unsigned even when *require signed* is on. SiK radios
 * inject `RADIO_STATUS` and cannot sign; requiring signatures otherwise kills
 * link-quality data silently. Everything here is unauthenticated and must never
 * drive control (§7).
 */
const DEFAULT_UNSIGNED_ALLOWLIST = ['RADIO_STATUS'];

/**
 * @typedef {object} InboundFrame
 * @property {number} sysid
 * @property {number} compid
 * @property {number} linkId  link id from the packet's signature block
 * @property {number} timestamp  48-bit signing timestamp, 10 µs units
 * @property {boolean} signaturePresent  a v2 signature block was present
 * @property {boolean} signatureValid  the HMAC matched (from node-mavlink)
 * @property {string} messageName  for the unsigned allowlist
 */

/**
 * @typedef {object} InboundVerdict
 * @property {boolean} accept  deliver the frame at all
 * @property {boolean} trusted  may drive control; false for unsigned-allowlisted
 *   and for invalid-but-admitted frames, which are advisory only
 * @property {string} reason  machine-readable outcome tag
 */

class SigningState {
  /**
   * @param {object} [options]
   * @param {number} [options.linkId]  this connection's link id; two connections
   *   sharing a key still need distinct link IDs (§7)
   * @param {boolean} [options.signOutbound]
   * @param {boolean} [options.requireSigned]
   * @param {boolean} [options.acceptInvalid]  recovery override; admitted frames
   *   are untrusted and never advance the timestamp store
   * @param {boolean} [options.hasKey]  whether a passphrase/credential is present
   * @param {string[]} [options.unsignedAllowlist]
   * @param {() => number} [options.now]  clock source (ms)
   */
  constructor(options = {}) {
    this.linkId = options.linkId || 0;
    this.signOutbound = !!options.signOutbound;
    this.requireSigned = !!options.requireSigned;
    this.acceptInvalid = !!options.acceptInvalid;
    this.hasKey = !!options.hasKey;
    this._allowlist = new Set(options.unsignedAllowlist || DEFAULT_UNSIGNED_ALLOWLIST);
    this._now = options.now || Date.now;
    /** @type {Map<string, number>} last accepted inbound timestamp per stream */
    this._inbound = new Map();
    /** @type {Map<string, number>} last emitted outbound timestamp per stream */
    this._outbound = new Map();
    /**
     * Outgoing MAVLink sequence per source component, 0..255 wrapping.
     * Receivers do loss detection per (sysid, compid), so two identities
     * sharing one counter would show phantom gaps in both streams (issue #92).
     * @type {Map<string, number>}
     */
    this._seq = new Map();
  }

  /**
   * Whether the connection may open at all. Sign-outbound enabled without a
   * passphrase fails the connection closed — it must not quietly transmit
   * unsigned (§7).
   *
   * @returns {{ok: boolean, reason: string|null}}
   */
  validate() {
    if (this.signOutbound && !this.hasKey) {
      return {
        ok: false,
        reason: 'sign-outbound is enabled but no signing passphrase or raw key is set',
      };
    }
    return { ok: true, reason: null };
  }

  /**
   * Next MAVLink sequence number for an outbound frame (0..255, wrapping),
   * scoped to the sending component like the timestamp store — one monotonic
   * stream per bound identity.
   *
   * @param {number} sysid
   * @param {number} compid
   * @returns {number}
   */
  nextSeq(sysid, compid) {
    const key = `${sysid}/${compid}`;
    const seq = this._seq.get(key) || 0;
    this._seq.set(key, (seq + 1) % 256);
    return seq;
  }

  /**
   * Next outbound signing timestamp for a stream: strictly increasing, at least
   * +1 per message. On start it is the greater of the clock-derived value and
   * any stored value, so an NTP-disciplined host stays monotonic across
   * restarts without persistence (§7 "Outbound").
   *
   * @param {number} sysid
   * @param {number} compid
   * @param {number} [now]
   * @returns {number}
   */
  nextOutboundTimestamp(sysid, compid, now = this._now()) {
    const key = streamKey(sysid, compid, this.linkId);
    const clock = timestampFromMs(now);
    const stored = this._outbound.get(key);
    const next = stored === undefined ? clock : Math.max(clock, stored + 1);
    this._outbound.set(key, next);
    return next;
  }

  /**
   * Apply the inbound accept/reject policy to a frame. Never advances the
   * timestamp store from a packet that failed verification, including one
   * admitted by *accept invalid signatures* — doing so would let a forged
   * packet raise the floor and lock out the real peer (§7 "On accept").
   *
   * @param {InboundFrame} frame
   * @param {number} [now]
   * @returns {InboundVerdict}
   */
  acceptInbound(frame, now = this._now()) {
    if (!frame.signaturePresent) return this._acceptUnsigned(frame);
    if (!frame.signatureValid) return this._acceptInvalid();
    return this._acceptValid(frame, now);
  }

  /**
   * Unsigned / v1 frame: accepted unless *require signed* is on, in which case
   * only the allowlist survives — and always untrusted (§7).
   *
   * @param {InboundFrame} frame
   * @returns {InboundVerdict}
   */
  _acceptUnsigned(frame) {
    if (!this.requireSigned) return verdict(true, false, 'unsigned-accepted');
    if (this._allowlist.has(frame.messageName)) {
      return verdict(true, false, 'unsigned-allowlisted');
    }
    return verdict(false, false, 'unsigned-rejected-require-signed');
  }

  /**
   * Invalid signature: rejected unless the recovery override is on, in which
   * case the frame is admitted untrusted and never advances the store.
   *
   * @returns {InboundVerdict}
   */
  _acceptInvalid() {
    if (this.acceptInvalid) return verdict(true, false, 'invalid-accepted-untrusted');
    return verdict(false, false, 'invalid-signature');
  }

  /**
   * Valid signature: subject to the first-contact bootstrap and the monotonic /
   * one-minute-floor rules. Advances the store only when the timestamp is
   * greater than the last accepted one for the stream.
   *
   * @param {InboundFrame} frame
   * @param {number} now
   * @returns {InboundVerdict}
   */
  _acceptValid(frame, now) {
    const key = streamKey(frame.sysid, frame.compid, frame.linkId);
    const last = this._inbound.get(key);
    const floor = timestampFromMs(now) - ONE_MINUTE_UNITS;

    if (last === undefined) {
      if (frame.timestamp < floor) return verdict(false, false, 'first-contact-too-old');
      this._inbound.set(key, frame.timestamp);
      return verdict(true, true, 'first-contact');
    }
    if (frame.timestamp <= last) return verdict(false, false, 'replay-or-out-of-order');
    if (frame.timestamp < floor) return verdict(false, false, 'too-old');
    this._inbound.set(key, frame.timestamp);
    return verdict(true, true, 'accepted');
  }

  /**
   * Last accepted inbound timestamp for a stream, or undefined. Exposed so
   * tests can assert the store did not advance from an unverified packet.
   *
   * @param {number} sysid
   * @param {number} compid
   * @param {number} linkId
   * @returns {number|undefined}
   */
  lastInboundTimestamp(sysid, compid, linkId) {
    return this._inbound.get(streamKey(sysid, compid, linkId));
  }
}

/**
 * @param {number} sysid
 * @param {number} compid
 * @param {number} linkId
 * @returns {string}
 */
function streamKey(sysid, compid, linkId) {
  return `${sysid}/${compid}/${linkId}`;
}

/**
 * Convert a Unix-ms clock reading to a 48-bit MAVLink signing timestamp.
 *
 * @param {number} ms  Unix milliseconds
 * @returns {number}  10 µs units since 2015-01-01
 */
function timestampFromMs(ms) {
  return Math.floor((ms - MAVLINK_EPOCH_UNIX_S * 1000) * UNITS_PER_MS);
}

/**
 * @param {boolean} accept
 * @param {boolean} trusted
 * @param {string} reason
 * @returns {InboundVerdict}
 */
function verdict(accept, trusted, reason) {
  return { accept, trusted, reason };
}

module.exports = {
  SigningState,
  timestampFromMs,
  MAVLINK_EPOCH_UNIX_S,
  ONE_MINUTE_UNITS,
  DEFAULT_UNSIGNED_ALLOWLIST,
};
