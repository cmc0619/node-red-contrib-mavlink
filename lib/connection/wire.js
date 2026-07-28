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
 * @property {(buffer: Buffer) => DecodedFrame[]} decode  complete frames in a
 *   datagram; a UDP datagram carries whole frames, so decode is synchronous and
 *   the caller keeps the datagram's endpoint alongside each frame
 */

/**
 * Build a wire adapter backed by `node-mavlink` and a message registry.
 *
 * @param {object} options
 * @param {object} options.bundle  the dialect bundle (for snake↔wire field names)
 * @param {Buffer} [options.key]  signing key, for inbound signature verification
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
  return buildWire(mav, options.bundle, options.key || null);
}

/**
 * @param {object} mav  the loaded `node-mavlink` module
 * @param {object} bundle  dialect bundle
 * @param {Buffer|null} key  signing key for inbound verification
 * @returns {Wire}
 */
function buildWire(mav, bundle, key) {
  const registry = buildRegistry(mav, bundle);
  const byName = indexByName(registry);

  // Custom-dialect messages have no generated class: synthesize them from the
  // bundle's compiled metadata (wire-classes.js) and extend both lookup maps
  // and the splitter's CRC_EXTRA table, so custom messages frame, encode, and
  // decode exactly like bundled ones. Generated classes win on collisions.
  const synthesized = synthesizeWireClasses(mav, bundle, {
    names: new Set(Object.keys(byName)),
    ids: new Set(Object.keys(registry).map(Number)),
    byName,
  });
  // node-mavlink re-exports mavlink-mappings' CRC_EXTRA table at the package
  // root (verified: 336 entries). Seed from that, then overlay synthesized.
  const magicNumbers = Object.assign({}, mav.MSG_ID_MAGIC_NUMBER);
  for (const cls of synthesized) {
    registry[cls.MSG_ID] = cls;
    byName[cls.MSG_NAME] = cls;
    magicNumbers[cls.MSG_ID] = cls.MAGIC_NUMBER;
  }

  // One persistent split/parse pipeline; drained synchronously per datagram in
  // paused mode via `read()` rather than a flowing `data` listener, so each
  // frame is returned to the caller with the datagram still in scope.
  const splitter = new mav.MavLinkPacketSplitter({}, { magicNumbers });
  const parser = splitter.pipe(new mav.MavLinkPacketParser());

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

    decode(buffer) {
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
          signatureValid: signaturePresent && key ? packet.signature.matches(key) : false,
          linkId: signaturePresent ? packet.signature.linkId : null,
          timestamp: signaturePresent ? packet.signature.timestamp : null,
        });
      }
      return frames;
    },
  };
}

/**
 * Assemble a msgid→class registry for one dialect: start empty, then merge
 * each module in the bundle's include chain (`bundle.files`, dependency-first).
 * Custom XML basenames that are not `node-mavlink` modules contribute nothing
 * here — {@link synthesizeWireClasses} fills those from compiled metadata.
 * There is no hardcoded MSC/ardupilotmega preload; two connections with
 * different profiles therefore hold independent registries.
 *
 * @param {object} mav
 * @param {object} bundle  dialect bundle (`files` = include chain)
 * @returns {Object<number, Function>}
 */
function buildRegistry(mav, bundle) {
  const registry = {};
  const files = (bundle && bundle.files) || [];
  for (const file of files) {
    // Bundled chains use bare module names (`common`); custom compile uses
    // XML basenames (`common.xml`). Lookup is case-insensitive to match
    // mavlink-mappings' lowercase exports (`uavionix` vs `uAvionix.xml`).
    const name = String(file).replace(/\.xml$/i, '').toLowerCase();
    const mod = mav[name];
    if (mod && mod.REGISTRY) Object.assign(registry, mod.REGISTRY);
  }
  return registry;
}

/**
 * @param {Object<number, Function>} registry
 * @returns {Object<string, Function>}
 */
function indexByName(registry) {
  const byName = {};
  for (const Clazz of Object.values(registry)) {
    if (Clazz && Clazz.MSG_NAME) byName[Clazz.MSG_NAME] = Clazz;
  }
  return byName;
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

module.exports = { createWire, snakeToCamel };
