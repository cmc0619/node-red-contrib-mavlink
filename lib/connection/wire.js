'use strict';

const { synthesizeWireClasses, snakeToCamel } = require('./wire-classes');

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
 * @property {boolean} signaturePresent
 * @property {boolean} signatureValid  HMAC matched (false when unsigned/no key)
 * @property {number|null} linkId
 * @property {number|null} timestamp
 *
 * @typedef {object} Wire
 * @property {(message: object, ctx: SerializeContext) => Buffer} serialize
 * @property {(buffer: Buffer, endpoint?: {address: string, port: number}|null) => DecodedFrame[]} decode
 * @property {(endpoint: {address: string, port: number}|null|string) => void} [releaseDecoder]
 * @property {(now?: number, idleMs?: number) => number} [evictIdleDecoders]
 * @property {() => void} [clearDecoders]
 */

/** Fallback key for serial / tests that omit an endpoint. */
const DEFAULT_ENDPOINT_KEY = '__default__';

/**
 * Max live decode pipelines per Connection. One per drone endpoint is typical;
 * 100 leaves headroom for multi-link / SITL fleets while bounding spoofed UDP
 * source churn (Greptile #33).
 */
const DEFAULT_MAX_DECODERS = 100;

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
          'install it to enable Connection transports'
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
  const synthesized = synthesizeWireClasses(mav, bundle, {
    names: new Set(),
    ids: new Set(),
    byName,
  });
  const magicNumbers = {};
  for (const cls of synthesized) {
    registry[cls.MSG_ID] = cls;
    byName[cls.MSG_NAME] = cls;
    magicNumbers[cls.MSG_ID] = cls.MAGIC_NUMBER;
  }

  /**
   * Map insertion order is LRU order: coldest at the front, warmest at the end.
   * `lastUsed` is only for idle-age eviction. `validated` means this endpoint
   * has produced at least one decoded MAVLink frame — cap pressure prefers
   * never-validated (junk/spoof) pipelines so a live peer mid-frame is not
   * the first casualty of source churn (Greptile #33).
   *
   * @type {Map<string, {splitter: object, parser: object, lastUsed: number, validated: boolean}>}
   */
  const decoders = new Map();

  /** Evict one pipeline under the cap: never-validated first, else Map-LRU. */
  function evictOne() {
    for (const [key, entry] of decoders) {
      if (!entry.validated) {
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
      const splitter = new mav.MavLinkPacketSplitter({}, { magicNumbers });
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
      const instance = new Clazz();
      assignFields(instance, message.fields, bundle.messages[message.name]);
      const protocol = new mav.MavLinkProtocolV2(ctx.sysid, ctx.compid);
      const frame = protocol.serialize(instance, ctx.seq);
      if (ctx.sign && ctx.key) return protocol.sign(frame, ctx.linkId || 0, ctx.key);
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
      let packet;
      while ((packet = parser.read()) !== null) {
        const Clazz = registry[packet.header.msgid];
        if (!Clazz) continue;
        const data = packet.protocol.data(packet.payload, Clazz);
        const signaturePresent = !!packet.signature;
        frames.push({
          name: Clazz.MSG_NAME || Clazz.name,
          sysid: packet.header.sysid,
          compid: packet.header.compid,
          fields: extractFields(data, bundle.messages[Clazz.MSG_NAME]),
          signaturePresent,
          signatureValid:
            signaturePresent && signingKey ? packet.signature.matches(signingKey) : false,
          linkId: signaturePresent ? packet.signature.linkId : null,
          timestamp: signaturePresent ? packet.signature.timestamp : null,
        });
      }
      if (frames.length) entry.validated = true;
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
     * @param {number} [now]
     * @param {number} [idleMs]
     * @returns {number}
     */
    evictIdleDecoders(now = Date.now(), idleMs = 30_000) {
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
  };
}

/**
 * @param {{address: string, port: number}|null|undefined} endpoint
 * @returns {string}
 */
function endpointKey(endpoint) {
  if (!endpoint || endpoint.address === undefined || endpoint.address === null) {
    return DEFAULT_ENDPOINT_KEY;
  }
  return `${endpoint.address}:${endpoint.port}`;
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
  const names = messageMeta ? messageMeta.fields.map((f) => f.name) : Object.keys(fields);
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
  snakeToCamel,
  endpointKey,
  DEFAULT_ENDPOINT_KEY,
  DEFAULT_MAX_DECODERS,
};
