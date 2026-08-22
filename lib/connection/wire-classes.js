'use strict';

/**
 * Synthesize live `node-mavlink` message classes from a compiled dialect
 * bundle (§4), so custom XML dialects encode and decode like bundled ones.
 *
 * `node-mavlink` serializes through generated classes (`MavLinkData`
 * subclasses carrying FIELDS / MAGIC_NUMBER / PAYLOAD_LENGTH), and its packet
 * splitter validates CRCs against a msgid→CRC_EXTRA table — both generated
 * from the official XML and shipped in `mavlink-mappings`. A custom dialect
 * has neither. This module builds both at runtime from the §4 compiler's
 * metadata, which already carries everything MAVLink's wire layout is derived
 * from: field wire types, array lengths, and extension flags in declaration
 * order.
 *
 * Two MAVLink rules define the layout, mirrored from the generator:
 *
 * - **Wire order**: non-extension fields sorted by element size, largest
 *   first — a stable sort, so equal sizes keep XML declaration order — with
 *   extension fields appended afterwards in declaration order.
 * - **CRC_EXTRA**: the x25 hash of `"NAME "` then, for each non-extension
 *   field in wire order, `"type name "` (the scalar type, arrays hashed as
 *   their element type) plus one length byte for arrays; folded to
 *   `(crc & 0xff) ^ (crc >> 8)`.
 *
 * Correctness is pinned by test, not trust: the suite synthesizes classes for
 * every message of every bundled dialect and requires byte-identical layout
 * (magic number, payload length, per-field offset/size/length/extension)
 * against the `mavlink-mappings` generated classes.
 */

const { typeInfo, normalizeType, is64BitKind } = require('../codec/types');

/**
 * Memoized: wire.js calls this per field on every decode and serialize, and
 * the name universe (dialect field and message names) is small and fixed per
 * process, so the cache is bounded by the bundle, not by traffic.
 *
 * @param {string} snake
 * @returns {string}
 */
const camelByName = new Map();
function snakeToCamel(snake) {
  let camel = camelByName.get(snake);
  if (camel === undefined) {
    camel = snake.replace(/_([a-z0-9])/g, (_m, c) => c.toUpperCase());
    camelByName.set(snake, camel);
  }
  return camel;
}

/**
 * @param {object} field  bundle field metadata
 * @returns {number} element size in bytes
 * @throws {Error} unknown wire type — a compiler bug or corrupt bundle,
 *   surfaced loudly (§2)
 */
function elementSize(field) {
  const info = typeInfo(field.type);
  if (!info) throw new Error(`unknown MAVLink wire type '${field.type}' on field '${field.name}'`);
  return info.size;
}

/**
 * Wire-order a message's fields (see module doc).
 *
 * @param {object[]} fields  bundle field metadata in declaration order
 * @returns {object[]}
 */
function wireOrder(fields) {
  const base = fields.filter((f) => !f.extension);
  const ext = fields.filter((f) => f.extension);
  // Array.prototype.sort is stable (ES2019), so equal sizes keep XML order.
  base.sort((a, b) => elementSize(b) - elementSize(a));
  return base.concat(ext);
}

/**
 * Compute a message's CRC_EXTRA (the "magic number").
 *
 * @param {object} mav  loaded `node-mavlink` module (for x25crc)
 * @param {object} message  bundle message metadata
 * @param {object[]} ordered  the message's fields in wire order
 * @returns {number}
 */
function crcExtra(mav, message, ordered) {
  const parts = [`${message.name} `];
  for (const f of ordered) {
    if (f.extension) continue; // extensions are excluded from the CRC seed
    parts.push(`${normalizeType(f.type)} ${f.name} `);
    if (f.arrayLength) parts.push(String.fromCharCode(f.arrayLength));
  }
  const crc = mav.x25crc(Buffer.from(parts.join(''), 'ascii'));
  // CRC fold is inherently bitwise; the no-bitwise gate is codec-only (§13).
  return (crc & 0xff) ^ (crc >> 8);
}

/**
 * Turn one bundle message into a `MavLinkData` subclass matching the shape of
 * `mavlink-mappings`' generated classes.
 *
 * @param {object} mav  loaded `node-mavlink` module
 * @param {object} message  bundle message metadata
 * @returns {Function}
 */
function buildMessageClass(mav, message) {
  const ordered = wireOrder(message.fields);
  const fields = [];
  let offset = 0;
  for (const f of ordered) {
    const size = elementSize(f);
    const length = f.arrayLength || 0;
    fields.push(
      new mav.MavLinkPacketField(
        f.name,
        snakeToCamel(f.name),
        offset,
        Boolean(f.extension),
        size,
        length ? `${f.type}[]` : f.type,
        f.units || '',
        length
      )
    );
    offset += size * (length || 1);
  }

  // Constructor defaults mirror the generated classes: char arrays are '',
  // other arrays a fresh [], 64-bit integers BigInt(0), everything else 0.
  // Without them, serializing a message with an omitted field crashes on
  // undefined instead of emitting the zero the generated class would.
  const inits = ordered.map((f) => {
    const kind = typeInfo(f.type).kind;
    const name = snakeToCamel(f.name);
    if (kind === 'char') return { name, kind: 'string' };
    if (f.arrayLength) return { name, kind: 'array' };
    if (is64BitKind(kind)) return { name, kind: 'bigint' };
    return { name, kind: 'zero' };
  });

  const cls = class extends mav.MavLinkData {
    constructor() {
      super();
      for (const { name, kind } of inits) {
        if (kind === 'string') this[name] = '';
        else if (kind === 'array') this[name] = [];
        else if (kind === 'bigint') this[name] = BigInt(0);
        else this[name] = 0;
      }
    }
  };
  const pascal = snakeToCamel(message.name.toLowerCase());
  Object.defineProperty(cls, 'name', {
    value: pascal.charAt(0).toUpperCase() + pascal.slice(1),
    configurable: true,
  });
  cls.MSG_ID = message.id;
  cls.MSG_NAME = message.name;
  cls.PAYLOAD_LENGTH = offset;
  cls.MAGIC_NUMBER = crcExtra(mav, message, ordered);
  cls.FIELDS = fields;
  return cls;
}

/**
 * Synthesize wire classes for every bundle message not already covered by the
 * generated registry. A custom dialect that *includes* a bundled message
 * (same name and msgid, same layout) is skipped — the generated class is
 * ground truth. Any other collision (name-only, id-only, or same identity
 * with a different wire layout) fails loudly here; silently keeping the
 * bundled class would encode custom fields at the wrong offsets.
 *
 * @param {object} mav  loaded `node-mavlink` module
 * @param {object} bundle  compiled dialect bundle
 * @param {{names?: Set<string>, ids?: Set<number>, byName?: Object<string, Function>}} [taken]
 * @returns {Function[]}
 */
function synthesizeWireClasses(mav, bundle, taken) {
  const names = (taken && taken.names) || new Set();
  const ids = (taken && taken.ids) || new Set();
  const byName = (taken && taken.byName) || {};
  const classes = [];
  for (const message of Object.values(bundle.messages)) {
    const nameTaken = names.has(message.name);
    const idTaken = ids.has(message.id);
    if (!nameTaken && !idTaken) {
      classes.push(buildMessageClass(mav, message));
      continue;
    }
    const existing = byName[message.name];
    if (
      nameTaken && idTaken &&
      existing &&
      existing.MSG_NAME === message.name &&
      existing.MSG_ID === message.id
    ) {
      // Same identity as a bundled message (typical <include>). Keep the
      // generated class only when the wire layout matches.
      const candidate = buildMessageClass(mav, message);
      if (
        candidate.MAGIC_NUMBER === existing.MAGIC_NUMBER &&
        candidate.PAYLOAD_LENGTH === existing.PAYLOAD_LENGTH
      ) {
        continue;
      }
      throw new Error(
        `custom message '${message.name}' (id ${message.id}) redefines the bundled wire layout`
      );
    }
    throw new Error(
      `custom message '${message.name}' (id ${message.id}) collides with a bundled message ` +
        (nameTaken && idTaken ? 'identity' : nameTaken ? 'name' : 'id')
    );
  }
  return classes;
}

module.exports = { synthesizeWireClasses, buildMessageClass, snakeToCamel };
