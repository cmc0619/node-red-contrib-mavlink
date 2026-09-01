'use strict';

const { synthesizeWireClasses, snakeToCamel } = require('./wire-classes');
const { isBlank } = require('../addressing/resolve');
const { typeInfo } = require('../codec/types');
const { endpointKey } = require('./endpoint-key');

/**
 * The wire framing boundary (DESIGN.md §2 "Defer to node-mavlink"). Framing,
 * encode/decode, CRC, splitting, and the signing HMAC primitives are
 * `node-mavlink`'s job — this module is the single adapter between the runtime's
 * decoded-message shape (`{ name, sysid, compid, fields }`, snake_case field
 * names, as the field codec §5 produces) and `node-mavlink`'s message classes.
 *
 * `node-mavlink` is lazy-loaded: it is required the first time a wire is built,
 * not at module load, so the rest of `lib/connection` (queue, peer table,
 * subscriptions, signing policy) loads and tests without it. When it is absent
 * the error names the missing package rather than surfacing a bare
 * `MODULE_NOT_FOUND`.
 *
 * The runtime accepts an injected wire, so its tests exercise the queue driver,
 * peer table, and subscription plumbing against a trivial in-memory wire and
 * never depend on `node-mavlink` being installed.
 *
 * **One decoder per network endpoint.** MAVLink v2 is a byte stream. TCP clients
 * and UDP peers must not share a `MavLinkPacketSplitter` — a partial frame from
 * peer A would contaminate peer B's next bytes. Serialize stays connection-wide
 * (one registry); decode pipelines are keyed by `address:port` and released on
 * peer close / idle eviction. A hard cap (default 100) LRU-evicts the coldest
 * pipeline so UDP source churn cannot grow memory without bound.
 *
 * @typedef {object} SerializeContext
 * @property {number} sysid  source system id
 * @property {number} compid  source component id
 * @property {number} seq  MAVLink sequence number
 * @property {boolean} [sign]  emit a v2 signature block
 * @property {number} [linkId]  signing link id
 * @property {Buffer} [key]  signing key (from node-mavlink's key derivation)
 * @property {number} [timestamp]  48-bit signing timestamp
 *
 * @typedef {object} DecodedFrame
 * @property {string} name
 * @property {number} sysid
 * @property {number} compid
 * @property {Object<string, *>} fields
 * @property {boolean} crcVerified  the msgid is known to the bound dialect and
 *   its CRC checked out (false on UNKNOWN_<id> — unverifiable by construction)
 * @property {boolean} signaturePresent
 * @property {boolean} signatureValid  HMAC matched (false when unsigned/no key)
 * @property {number|null} linkId
 * @property {number|null} timestamp
 *
 * @typedef {object} Wire
 * @property {(message: object, ctx: SerializeContext) => Buffer} serialize
 * @property {(buffer: Buffer, endpoint?: {address: string, port: number}|null) => DecodedFrame[]} decode
 * @property {(endpoint: {address: string, port: number}|null|string) => void} [releaseDecoder]
 * @property {(now: number, idleMs: number) => number} [evictIdleDecoders]
 * @property {() => void} [clearDecoders]
 * @property {() => number} [crcFailureCount]
 */

/**
 * Max live decode pipelines per Connection. One per drone endpoint is typical;
 * 100 leaves headroom for multi-link / SITL fleets while bounding spoofed UDP
 * source churn (Greptile #33).
 */
const DEFAULT_MAX_DECODERS = 100;

/**
 * node-mavlink's `PacketValidationResult`, which the package does not put on
 * its runtime export surface — so the values are named here instead of
 * imported (Gitar #344). The wire-decoders UNKNOWN and CRC-corruption tests
 * pin the behaviour end to end, so an upstream renumber fails loud rather than
 * silently reclassifying frames.
 */
const PACKET_VALID = 0;
const PACKET_INVALID = 1;
const PACKET_UNKNOWN = 2;

/**
 * Build a wire adapter backed by `node-mavlink` and a message registry.
 *
 * @param {object} options
 * @param {object} options.bundle  the dialect bundle (for snake↔wire field names)
 * @param {Buffer} [options.key]  signing key, for inbound signature verification
 * @param {number} [options.maxDecoders]  cap on per-endpoint pipelines (default 100)
 * @param {Function} [options.require]  injectable require, for testing the guard
 * @returns {Wire}
 * @throws {Error} when `node-mavlink` is not installed
 */
function createWire(options) {
  const req = options.require || require;
  let mav;
  try {
    mav = req('node-mavlink');
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND') {
      throw new Error(
        "the 'node-mavlink' package is required for MAVLink framing but is not installed; " +
          'install it to enable Connection transports',
        { cause: err },
      );
    }
    throw err;
  }
  const maxDecoders =
    Number.isFinite(options.maxDecoders) && options.maxDecoders > 0
      ? Math.floor(options.maxDecoders)
      : DEFAULT_MAX_DECODERS;
  return buildWire(mav, options.bundle, options.key || null, maxDecoders);
}

/**
 * @param {object} mav  the loaded `node-mavlink` module
 * @param {object} bundle  dialect bundle
 * @param {Buffer|null} signingKey  signing key for inbound verification
 * @param {number} maxDecoders
 * @returns {Wire}
 */
function buildWire(mav, bundle, signingKey, maxDecoders) {
  // Registry starts empty and is filled entirely from the dialect bundle.
  // Include fidelity lives in the seed/catalog XML walk — we do not preload
  // mavlink-mappings modules. node-mavlink still supplies framing, CRC, and
  // signing primitives (splitter/parser/protocol); message classes are ours.
  const registry = {};
  const byName = {};
  const synthesized = synthesizeWireClasses(mav, bundle);
  const magicNumbers = {};
  for (const cls of synthesized) {
    registry[cls.MSG_ID] = cls;
    byName[cls.MSG_NAME] = cls;
    magicNumbers[cls.MSG_ID] = cls.MAGIC_NUMBER;
  }

  /**
   * CRC failures on a msgid this dialect carries, summed across every endpoint
   * on this Connection and monotonic for the life of the deploy — the splitters
   * come and go with UDP source churn, reconnects, and idle eviction, and a
   * tally that went with them would read a corrupted link as a clean one.
   */
  let crcFailures = 0;

  /**
   * node-mavlink drops any msgid its `magicNumbers` map does not carry. An
   * unknown id's CRC seed lives in the message definition, so the frame cannot
   * be checksum-verified and the library's answer is silence. That silence
   * hides the one clue that diagnoses a dialect mismatch — the id itself — so
   * here an unknown id is accepted and surfaces as an UNKNOWN_<id> frame in
   * decode().
   *
   * The base class decides what is known; this only overrides its verdict.
   * Deciding again here would mean copying the base's own lookup, which then
   * has to be kept in step with it forever.
   *
   * A CRC failure on a *known* id still returns INVALID and is still dropped —
   * the verdict is only tallied on its way past, because a frame whose CRC
   * failed cannot be trusted to name its own sender.
   *
   * One corrupt frame can fail the check more than once: on INVALID the base
   * splitter drops a byte and rescans from the next, so a stray START byte
   * inside a long payload can raise the verdict again for the same physical
   * frame (Gitar, #390). A rising delta is the one job this number has, and
   * that survives the double-count.
   *
   * Declared once per wire, not per decoder: `getDecoder` runs for every new
   * endpoint and again on every UDP source churn.
   */
  class DialectSplitter extends mav.MavLinkPacketSplitter {
    validatePacket(buffer, Protocol) {
      const result = super.validatePacket(buffer, Protocol);
      if (result === PACKET_INVALID) crcFailures += 1;
      return result === PACKET_UNKNOWN ? PACKET_VALID : result;
    }
  }

  /**
   * Map insertion order is LRU order: coldest at the front, warmest at the end.
   * `lastUsed` is only for idle-age eviction. Cap pressure prefers, in order:
   * (1) never-validated junk (buffer empty or not a MAVLink STX), (2) validated
   * with empty splitter buffer, (3) Map-LRU — so a peer mid-frame (including a
   * first frame that has not validated yet) is not the first casualty of source
   * churn (Greptile #33).
   *
   * @type {Map<string, {splitter: object, parser: object, lastUsed: number, validated: boolean}>}
   */
  const decoders = new Map();

  /** True when the splitter still holds an incomplete MAVLink frame. */
  function hasPendingPartial(entry) {
    const buf = entry.splitter && entry.splitter.buffer;
    return Buffer.isBuffer(buf) && buf.length > 0;
  }

  /**
   * Never-validated buffer that looks like a started MAVLink frame (v1 0xFE /
   * v2 0xFD). Junk that only stuffed non-STX bytes is safe to drop first.
   */
  function looksLikeMavPartial(entry) {
    const buf = entry.splitter && entry.splitter.buffer;
    if (!Buffer.isBuffer(buf) || buf.length === 0) return false;
    return buf[0] === 0xfd || buf[0] === 0xfe;
  }

  /**
   * Evict one pipeline under the cap: never-validated junk, then idle-complete
   * validated, then Map-LRU among remaining mid-frame entries (validated or
   * first-frame never-validated).
   */
  function evictOne() {
    for (const [key, entry] of decoders) {
      if (!entry.validated && !looksLikeMavPartial(entry)) {
        decoders.delete(key);
        return key;
      }
    }
    for (const [key, entry] of decoders) {
      if (entry.validated && !hasPendingPartial(entry)) {
        decoders.delete(key);
        return key;
      }
    }
    const first = decoders.keys().next();
    if (first.done) return null;
    decoders.delete(first.value);
    return first.value;
  }

  function touchDecoder(epKey, entry, now) {
    entry.lastUsed = now;
    // Re-insert so Map iteration order tracks true recency even when `now`
    // ties at millisecond resolution (CodeRabbit #33).
    decoders.delete(epKey);
    decoders.set(epKey, entry);
  }

  function getDecoder(epKey, now) {
    let entry = decoders.get(epKey);
    if (!entry) {
      while (decoders.size >= maxDecoders) {
        if (evictOne() === null) break;
      }
      // Paused-mode pipeline: drained synchronously via `read()` so each frame
      // is returned with the datagram's endpoint still in scope.
      const splitter = new DialectSplitter({}, { magicNumbers });
      const parser = splitter.pipe(new mav.MavLinkPacketParser());
      entry = { splitter, parser, lastUsed: now, validated: false };
      decoders.set(epKey, entry);
    } else {
      touchDecoder(epKey, entry, now);
    }
    return entry;
  }

  return {
    serialize(message, ctx) {
      const Clazz = byName[message.name];
      if (!Clazz) throw new Error(`no wire class for message '${message.name}'`);
      const messageMeta = bundle.messages[message.name];
      assertCoreIntegerFieldsSpoken(message.fields, messageMeta);
      const instance = new Clazz();
      assignFields(instance, message.fields, messageMeta);
      const willSign = !!(ctx.sign && ctx.key);
      // The v2 header's IFLAG_SIGNED incompatibility flag must be set before
      // the header bytes are written by serialize() below, or a receiver (any
      // MAVLink stack, including this module's own decode()) reads the frame
      // as unsigned and ignores the trailing signature block entirely —
      // node-mavlink's own sendSigned() helper does the same.
      const protocol = new mav.MavLinkProtocolV2(
        ctx.sysid,
        ctx.compid,
        willSign ? mav.MavLinkProtocolV2.IFLAG_SIGNED : undefined
      );
      let frame = protocol.serialize(instance, ctx.seq);
      // node-mavlink's v2 truncation cuts every trailing zero, so an all-zero
      // payload goes on the wire with length 0 — and spec-strict peers drop a
      // zero-length v2 frame outright (measured: a broadcast
      // PARAM_REQUEST_LIST never answered). Restore the one-byte minimum and
      // recompute the CRC over the fixed frame with the message's crc-extra
      // (the same primitives DialectSplitter verifies against). Before
      // signFrame(), so the signature covers the bytes actually sent.
      if (frame[1] === 0) {
        frame = Buffer.concat([
          frame.subarray(0, mav.MavLinkProtocolV2.PAYLOAD_OFFSET),
          Buffer.from([0]),
          frame.subarray(mav.MavLinkProtocolV2.PAYLOAD_OFFSET),
        ]);
        frame[1] = 1;
        frame.writeUInt16LE(
          mav.x25crc(frame, 1, mav.MavLinkProtocol.CHECKSUM_LENGTH, Clazz.MAGIC_NUMBER),
          frame.length - mav.MavLinkProtocol.CHECKSUM_LENGTH
        );
      }
      if (willSign) return signFrame(mav, frame, ctx);
      return frame;
    },

    /**
     * Decode bytes from one network endpoint. Partial frames stay buffered on
     * that endpoint's splitter only.
     *
     * @param {Buffer} buffer
     * @param {{address: string, port: number}|null} [endpoint]
     * @param {number} [now]  injectable clock (Connection passes `this._now()`)
     * @returns {DecodedFrame[]}
     */
    decode(buffer, endpoint, now = Date.now()) {
      const epKey = endpointKey(endpoint);
      const entry = getDecoder(epKey, now);
      const { splitter, parser } = entry;
      splitter.write(buffer);
      const frames = [];
      // Framing alone does not earn eviction standing. `validated` means "this
      // endpoint proved it speaks a dialect we can verify" — the implicit CRC
      // proof that keeps a real peer out of the first eviction tier (Greptile
      // #33). An UNKNOWN_<id> frame is CRC-unverifiable by construction, so a
      // spoofed source could otherwise pin a decoder with one forgeable frame.
      // Only a known msgid, whose crc-extra the splitter did check, promotes.
      let verified = false;
      let packet;
      while ((packet = parser.read()) !== null) {
        const Clazz = registry[packet.header.msgid];
        const signaturePresent = !!packet.signature;
        const signature = {
          signaturePresent,
          signatureValid:
            signaturePresent && signingKey ? packet.signature.matches(signingKey) : false,
          linkId: signaturePresent ? packet.signature.linkId : null,
          timestamp: signaturePresent ? packet.signature.timestamp : null,
        };
        // A msgid the bound dialect does not carry still names its sender.
        // Dropping it silently hid the one clue that diagnoses a dialect
        // mismatch — an operator met a vehicle speaking a newer dialect and
        // had to identify the id from a wire capture, because nothing in the
        // toolkit would say it (2026-08-18). The frame surfaces as
        // UNKNOWN_<id> with the raw payload; the peer table treats it like
        // any other non-section message (liveness), and an In node filtered
        // on the name — or unfiltered — sees it.
        if (!Clazz) {
          frames.push({
            name: `UNKNOWN_${packet.header.msgid}`,
            sysid: packet.header.sysid,
            compid: packet.header.compid,
            // Trimmed to the wire length: node-mavlink hands every packet a
            // fixed 255-byte payload buffer, so the raw bytes end at
            // `payloadLength` and the rest is padding. Shipping the padding
            // would make the frame *less* inspectable — the operator reading
            // an unknown payload could not tell where the message stops (and
            // under v2 truncation the wire itself already dropped the
            // trailing zeros, so the padding is not even the sender's).
            fields: {
              msgid: packet.header.msgid,
              payload: Buffer.from(packet.payload.subarray(0, packet.header.payloadLength)),
            },
            crcVerified: false,
            ...signature,
          });
          continue;
        }
        verified = true;
        const data = packet.protocol.data(packet.payload, Clazz);
        frames.push({
          name: Clazz.MSG_NAME || Clazz.name,
          sysid: packet.header.sysid,
          compid: packet.header.compid,
          fields: extractFields(data, bundle.messages[Clazz.MSG_NAME]),
          crcVerified: true,
          ...signature,
        });
      }
      if (verified) entry.validated = true;
      return frames;
    },

    /**
     * Drop the decode pipeline for a gone TCP/UDP peer so its partial buffer
     * cannot outlive the socket / rinfo.
     *
     * @param {{address: string, port: number}|null|string} endpoint
     */
    releaseDecoder(endpoint) {
      const epKey = typeof endpoint === 'string' ? endpoint : endpointKey(endpoint);
      decoders.delete(epKey);
    },

    /**
     * Evict decode pipelines idle longer than `idleMs` (UDP peers that stop
     * talking without a TCP close). Returns how many were removed.
     *
     * @param {number} now
     * @param {number} idleMs
     * @returns {number}
     */
    evictIdleDecoders(now, idleMs) {
      let removed = 0;
      for (const [key, entry] of decoders) {
        if (now - entry.lastUsed > idleMs) {
          decoders.delete(key);
          removed += 1;
        }
      }
      return removed;
    },

    /** Tear down every per-endpoint pipeline (Connection close). */
    clearDecoders() {
      decoders.clear();
    },

    /** @returns {number} live decoder count (tests). */
    decoderCount() {
      return decoders.size;
    },

    /** @returns {number} configured pipeline cap (tests). */
    maxDecoderCount() {
      return maxDecoders;
    },

    /** @returns {number} CRC validation failures on known msgids, since this wire was built. */
    crcFailureCount() {
      return crcFailures;
    },
  };
}

/**
 * Sign a serialized frame using the runtime's own monotonic per-stream
 * timestamp (`ctx.timestamp`, §7 "Timestamps and replay" — already 48-bit,
 * 10 µs units since 2015-01-01). `MavLinkProtocolV2#sign`'s own `timestamp`
 * param instead expects a Unix-ms clock reading and reconverts it, defaulting
 * to `Date.now()` when omitted — passing our precomputed units through that
 * path would double-convert them, and omitting it (as before) drops the
 * SigningState timestamp on the floor entirely. This mirrors `sign()`'s own
 * steps but writes `ctx.timestamp` straight into the signature block.
 *
 * @param {object} mav  the loaded `node-mavlink` module
 * @param {Buffer} frame  the unsigned serialized frame
 * @param {SerializeContext} ctx
 * @returns {Buffer} the signed frame
 */
function signFrame(mav, frame, ctx) {
  const signed = Buffer.concat([
    frame,
    Buffer.from(new Uint8Array(mav.MavLinkPacketSignature.SIGNATURE_LENGTH)),
  ]);
  const signer = new mav.MavLinkPacketSignature(signed);
  signer.linkId = ctx.linkId || 0;
  signer.timestamp = ctx.timestamp;
  signer.signature = signer.calculate(ctx.key);
  return signed;
}

/**
 * Per-message core scalar-int field names, derived once per message metadata
 * — the type filter otherwise re-ran per field on every pack (twice per send:
 * the send() dry-run and the pump serialize). Keyed weakly so the list drops
 * with its bundle.
 *
 * @type {WeakMap<object, string[]>}
 */
const coreIntNamesByMeta = new WeakMap();

/** @param {object} messageMeta @returns {string[]} */
function coreIntegerFieldNames(messageMeta) {
  let names = coreIntNamesByMeta.get(messageMeta);
  if (names) return names;
  names = [];
  for (const field of messageMeta.fields) {
    if (field.extension || field.arrayLength) continue;
    const info = typeInfo(field.type);
    if (!info || info.kind === 'float' || info.kind === 'double' || info.kind === 'char') continue;
    names.push(field.name);
  }
  coreIntNamesByMeta.set(messageMeta, names);
  return names;
}

/**
 * Core scalar ints on the fields bag must be spoken and finite before pack.
 * Otherwise class default / Buffer write a silent 0 (false success). Extensions
 * and floats are not checked (§14.65; NaN float is legal).
 *
 * @param {Object<string, *>|null|undefined} fields
 * @param {object} [messageMeta]
 */
function assertCoreIntegerFieldsSpoken(fields, messageMeta) {
  if (!messageMeta) return;
  const bag = fields || {};
  for (const name of coreIntegerFieldNames(messageMeta)) {
    const value = bag[name];
    if (isBlank(value) || !Number.isFinite(Number(value))) {
      throw new Error('invalid packet');
    }
  }
}

/**
 * Copy codec wire values (snake_case, keyed by the bundle's field names) onto a
 * `node-mavlink` message instance (camelCase properties).
 *
 * @param {object} instance
 * @param {Object<string, *>} fields
 * @param {object} [messageMeta]
 */
function assignFields(instance, fields, messageMeta) {
  if (!fields) return;
  const metaFields = messageMeta ? messageMeta.fields : null;
  const names = metaFields ? metaFields.map((f) => f.name) : Object.keys(fields);
  for (const snake of names) {
    if (!Object.prototype.hasOwnProperty.call(fields, snake)) continue;
    instance[snakeToCamel(snake)] = fields[snake];
  }
}

/**
 * The inverse of {@link assignFields}: read a decoded instance's camelCase
 * properties back into the bundle's snake_case field names.
 *
 * @param {object} instance
 * @param {object} [messageMeta]
 * @returns {Object<string, *>}
 */
function extractFields(instance, messageMeta) {
  const out = {};
  if (!messageMeta) return out;
  for (const field of messageMeta.fields) {
    out[field.name] = instance[snakeToCamel(field.name)];
  }
  return out;
}

module.exports = {
  createWire,
};
