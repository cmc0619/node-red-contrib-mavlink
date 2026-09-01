'use strict';

const { isBlank } = require('../addressing/resolve');
const { PARAM_TYPES, paramValueFromWire, paramValueToWire } = require('../codec');

const PARAM_TYPE = Object.fromEntries(
  Object.entries(PARAM_TYPES).map(([code, info]) => [info.name, Number(code)])
);

/** Wire values of {@link PARAM_TYPE}, for validating a type read off a frame. */
const PARAM_TYPE_VALUES = new Set(Object.values(PARAM_TYPE));

/**
 * True when a value read off the wire is one of the MAV_PARAM_TYPE codes this
 * module understands. `0` and absent are both "the frame did not tell us".
 *
 * @param {*} value  a raw `param_type` field
 * @returns {boolean}
 */
function isKnownParamType(value) {
  return PARAM_TYPE_VALUES.has(Number(value));
}

/**
 * How `param_value` (float) carries a typed parameter (DESIGN.md §11).
 * @enum {string}
 */
const PARAM_ENCODING = {
  /** Native bytes bit-cast into the float slot (PX4 / BYTEWISE capability). */
  BYTEWISE: 'bytewise',
  /** Numeric C cast to float (ArduPilot / C_CAST capability). */
  C_CAST: 'c-cast',
};

/** MAV_PROTOCOL_CAPABILITY_PARAM_ENCODE_BYTEWISE */
const CAP_PARAM_ENCODE_BYTEWISE = 16;
/** MAV_PROTOCOL_CAPABILITY_PARAM_ENCODE_C_CAST */
const CAP_PARAM_ENCODE_C_CAST = 131072;

/**
 * Build one Param protocol message. `set` is echo-confirmed by the caller with
 * PARAM_VALUE; MAVLink has no COMMAND_ACK for params.
 *
 * @param {object} input
 * @returns {{name:string, fields: object}}
 */
function buildParamMessage(input) {
  const target = input.target;
  switch (input.action) {
    case 'request-list':
      return {
        name: 'PARAM_REQUEST_LIST',
        fields: { target_system: target.sysid, target_component: target.compid },
      };
    case 'read': {
      const paramIndex = input.paramIndex === undefined ? -1 : Number(input.paramIndex);
      return {
        name: 'PARAM_REQUEST_READ',
        fields: {
          target_system: target.sysid,
          target_component: target.compid,
          // An index of 0 or more identifies the parameter on its own — the
          // field's own documentation is "Send -1 to use the param ID field as
          // identifier (else the param ID will be ignored)". So a read
          // addressed by index neither needs an id nor sends one.
          param_id: paramIndex >= 0 ? '' : trimParamId(input.paramId),
          param_index: paramIndex,
        },
      };
    }
    case 'set': {
      const paramType = resolveParamType(input.paramType);
      const encoding = resolveParamEncoding({
        encoding: input.encoding,
        capabilities: input.capabilities,
        firmware: input.firmware,
      });
      return {
        name: 'PARAM_SET',
        fields: {
          target_system: target.sysid,
          target_component: target.compid,
          param_id: trimParamId(input.paramId),
          param_value: encodeParamValue(input.value, paramType, encoding),
          param_type: paramType,
        },
      };
    }
    default: break; // This space intentionally left blank (§5)
  }
  return undefined; // nothing matched: no behavior selected (§5)
}

/**
 * @param {object} request
 * @param {object} decoded
 * @returns {boolean}
 */
function matchesParamEcho(request, decoded) {
  if (decoded.name !== 'PARAM_VALUE') return false;
  if (request.target && !echoTargetMatches(request.target, decoded)) return false;
  const fields = decoded.fields;
  if (trimParamId(fields.param_id) !== trimParamId(request.paramId)) return false;
  if (request.value === undefined) return true;
  // PARAM_VALUE carries the vehicle's own param_type, and its param_value bits
  // were encoded per *that* type — so that is the type the echo must be decoded
  // with. Preferring the request's type misreads the bytes whenever the two
  // disagree: an int parameter set through a REAL32-typed request decodes
  // bytewise as a denormal (1 arrives as 1.4e-45) and never matches, so a set
  // the vehicle actually applied reports "echo timeout". The request's type
  // governs how the outbound PARAM_SET is *encoded*; the vehicle is the
  // authority on its own parameter's type when reading the reply.
  const echoType = isKnownParamType(fields.param_type) ? fields.param_type : request.paramType;
  const type = resolveParamType(echoType);
  const encoding = resolveParamEncoding({
    encoding: request.encoding,
    capabilities: request.capabilities,
    firmware: request.firmware,
  });
  const actual = decodeParamValue(fields.param_value, type, encoding);
  const expected = Number(request.value);
  // A bytewise integer echo carries the vehicle's exact bits — nothing was
  // quantized in transit, so it must compare exactly. Float32 tolerance there
  // would confirm a *different* stored value: above 2^24 consecutive integers
  // collide under Math.fround, so a request for 16777217 would be "confirmed"
  // by a stored 16777216. Every other combination (REAL32, or any type sent
  // c-cast) does pass through a float32 on the wire, and needs the tolerance.
  const exactWire =
    encoding === PARAM_ENCODING.BYTEWISE && type !== PARAM_TYPE.MAV_PARAM_TYPE_REAL32;
  return numericEqual(actual, expected, { exactWire });
}

/**
 * Scope an echo to the addressed vehicle: on a multi-vehicle connection a
 * PARAM_VALUE from another system must not confirm this set. A broadcast
 * component target (0) accepts any source component.
 *
 * @param {{sysid?:number, compid?:number}} target
 * @param {object} decoded
 * @returns {boolean}
 */
function echoTargetMatches(target, decoded) {
  if (
    target.sysid !== undefined &&
    decoded.sysid !== undefined &&
    Number(decoded.sysid) !== Number(target.sysid)
  ) {
    return false;
  }
  if (
    target.compid !== undefined &&
    Number(target.compid) !== 0 &&
    decoded.compid !== undefined &&
    Number(decoded.compid) !== Number(target.compid)
  ) {
    return false;
  }
  return true;
}

/**
 * Wire-plane echo match for a replicated PARAM_SET (§10 Fan-out): the caller
 * holds only the built message, not the canonical request, so the comparison
 * happens where both sides genuinely live — the float32 `param_value` field.
 * Whatever the encoding convention (c-cast float or bytewise integer), a
 * vehicle that applied the set verbatim echoes the identical float32 bit
 * pattern, so `Object.is` on `Math.fround` of both sides is the invariant: it
 * treats NaN patterns (a bytewise integer whose bytes form a NaN) as equal to
 * themselves where `===` would not, and a clamped/rejected value mismatches.
 *
 * **On bytewise, the echo's type must equal the sent type.** A REAL32-typed set
 * landing on a bytewise integer parameter stores the float's bit pattern as a
 * garbage integer, then echoes those same bytes back: byte equality alone would
 * confirm that store, so the type gate declines it and the member honestly
 * reports unconfirmed. False failure over false success — the one outcome
 * echo-confirm exists to prevent (§ "Three kinds of confirmation", §14).
 *
 * **On c-cast there is no such store, so the gate does not apply.** SITL wire
 * capture (2026-08-18, Copter-4.7.0, PX4 control): ArduPilot c-casts the value,
 * ignores the `param_type` we send, and echoes its *own* table type — so a
 * REAL32-labelled set of an INT32 parameter stores correctly and comes back
 * typed INT32. The two cases are bit-identical on the wire; only the encoding
 * separates a garbage store from a good one, which is why this takes the
 * resolved encoding rather than inferring it from the frames.
 *
 * @param {{fields: object}} sent  built PARAM_SET message
 * @param {{sysid:number, compid:number}} target  addressed vehicle
 * @param {object} decoded  incoming frame
 * @param {*} encoding  as resolved by {@link resolveParamEncoding}
 * @returns {boolean}
 */
function matchesParamEchoWire(sent, target, decoded, encoding) {
  if (decoded.name !== 'PARAM_VALUE') return false;
  if (!echoTargetMatches(target, decoded)) return false;
  const echo = decoded.fields;
  const sentFields = sent.fields;
  if (trimParamId(echo.param_id) !== trimParamId(sentFields.param_id)) return false;
  // Tested as "not proven c-cast", not "is bytewise": an unresolved encoding
  // keeps the gate rather than dropping it, so the fallback is the strict
  // direction (§0 — it does not fall open).
  if (
    encoding !== PARAM_ENCODING.C_CAST &&
    Number(echo.param_type) !== Number(sentFields.param_type)
  ) {
    return false;
  }
  return Object.is(Math.fround(Number(echo.param_value)), Math.fround(Number(sentFields.param_value)));
}

/**
 * Match a PARAM_VALUE reply to a confirm-tier PARAM_REQUEST_READ: the same
 * target scoping as the set echo, then identity by whichever field the request
 * put on the wire — the index when one was sent (>= 0), the name otherwise
 * (buildParamMessage sends an empty param_id on an index read, so the id
 * cannot identify that reply). No value compare: the reply *is* the value.
 *
 * @param {object} request
 * @param {object} decoded
 * @returns {boolean}
 */
function matchesParamReadReply(request, decoded) {
  if (decoded.name !== 'PARAM_VALUE') return false;
  if (request.target && !echoTargetMatches(request.target, decoded)) return false;
  const fields = decoded.fields;
  const index = request.paramIndex === undefined ? -1 : Number(request.paramIndex);
  if (index >= 0) return Number(fields.param_index) === index;
  return trimParamId(fields.param_id) === trimParamId(request.paramId);
}

/**
 * Collect a PARAM_REQUEST_LIST's PARAM_VALUE stream into one ordered snapshot.
 *
 * The FIRST advertised `param_count` is pinned as the completion target: the
 * count is a property of the vehicle's table, so a mid-stream frame that
 * disagrees is that frame's defect, and letting it move the target would let
 * one bad frame complete — or forever un-complete — the collect. Index 65535
 * marks a PARAM_VALUE outside the indexed list (a set echo interleaving with
 * the collect) and is skipped as a member, though it still carries the true
 * count. An index at or past the pinned count is never stored either — a
 * stored out-of-range frame would inflate `byIndex.size` and satisfy the
 * completion check while a real index was still missing.
 *
 * `accept` reports what it did with the frame, because a caller watching the
 * stream for life must tell a kept frame from an ignored one: the snapshot
 * array once the collect completes (`[]` for count 0), `true` for an in-range
 * member stored without completing, `null` for an ignored frame.
 *
 * @param {{warn?: (text: string) => void}} [options]  out-of-range warn,
 *   deduped per index so a refill re-delivering the same frame warns once
 * @returns {{accept: (decoded: object) => (object[]|true|null),
 *            missing: () => number[]}}
 */
function createParamListCollector(options = {}) {
  const warn = options.warn || (() => {});
  const byIndex = new Map();
  const warned = new Set();
  let expected = null;
  return {
    accept(decoded) {
      if (decoded.name !== 'PARAM_VALUE') return null;
      const fields = decoded.fields;
      const index = Number(fields.param_index);
      const count = Number(fields.param_count);
      if (expected === null) expected = count;
      // An empty table has nothing to stream — the frame advertising count 0
      // is itself the whole answer.
      if (expected === 0) return [];
      if (index === 65535) return null;
      if (index >= expected) {
        if (!warned.has(index)) {
          warned.add(index);
          warn(`PARAM_VALUE index ${index} is outside the advertised count ${expected} — ignored`);
        }
        return null;
      }
      byIndex.set(index, {
        paramId: trimParamId(fields.param_id),
        value: fields.param_value,
        paramType: fields.param_type,
        index,
        count,
      });
      if (byIndex.size < expected) return true;
      return [...byIndex.values()].sort((a, b) => a.index - b.index);
    },
    /**
     * Indexes advertised but not yet received — the refill targets. Empty
     * until a count is known: with no frame yet there is nothing to name.
     */
    missing() {
      if (expected === null) return [];
      const out = [];
      for (let index = 0; index < expected; index++) {
        if (!byIndex.has(index)) out.push(index);
      }
      return out;
    },
  };
}

/**
 * Resolve the param wire encoding token — a resolution order, not a
 * dispatcher: the token it returns is what `encodeParamValue` /
 * `decodeParamValue` dispatch on.
 *
 * Priority (DESIGN.md §11):
 *   1. explicit `encoding` (`bytewise` | `c-cast`), passed through as given
 *   2. AUTOPILOT_VERSION.capabilities bits
 *   3. named firmware — px4 → bytewise, ardupilot → c-cast
 *
 * @param {object} [opts]
 * @param {string} [opts.encoding]
 * @param {number|null} [opts.capabilities]
 * @param {string} [opts.firmware]
 * @returns {string|undefined}
 */
function resolveParamEncoding(opts = {}) {
  if (!isBlank(opts.encoding)) return opts.encoding;
  // Spec: a component sets one of these. Prefer bytewise if both appear.
  // A blank or unparseable capabilities word masks to 0 and falls through.
  const caps = Number(opts.capabilities);
  if ((caps & CAP_PARAM_ENCODE_BYTEWISE) !== 0) return PARAM_ENCODING.BYTEWISE;
  if ((caps & CAP_PARAM_ENCODE_C_CAST) !== 0) return PARAM_ENCODING.C_CAST;
  switch (opts.firmware) {
    case 'px4': return PARAM_ENCODING.BYTEWISE;
    case 'ardupilot': return PARAM_ENCODING.C_CAST;
    default: break; // This space intentionally left blank (§5)
  }
  return undefined; // nothing matched: no behavior selected (§5)
}

/**
 * @param {*} value
 * @param {number} paramType
 * @param {*} encoding  as resolved by {@link resolveParamEncoding}
 * @returns {number|undefined}
 */
function encodeParamValue(value, paramType, encoding) {
  switch (encoding) {
    case PARAM_ENCODING.BYTEWISE: return paramValueToWire(value, paramType);
    case PARAM_ENCODING.C_CAST: return Number(value);
    default: break; // This space intentionally left blank (§5)
  }
  return NaN; // nothing matched: no behavior selected (§5)
}

/**
 * @param {*} value
 * @param {number} paramType
 * @param {*} encoding  as resolved by {@link resolveParamEncoding}
 * @returns {number|undefined}
 */
function decodeParamValue(value, paramType, encoding) {
  switch (encoding) {
    case PARAM_ENCODING.BYTEWISE: return paramValueFromWire(value, paramType);
    case PARAM_ENCODING.C_CAST: return Number(value);
    default: break; // This space intentionally left blank (§5)
  }
  return NaN; // nothing matched: no behavior selected (§5)
}

/**
 * @param {number|string} paramType
 * @returns {number}
 */
function resolveParamType(paramType) {
  if (typeof paramType === 'number') return paramType;
  const s = String(paramType).trim();
  if (/^\d+$/.test(s)) return Number(s);
  return PARAM_TYPE[s];
}

/**
 * @param {*} value
 * @returns {string}
 */
function trimParamId(value) {
  return String(value || '').replace(/\u0000+$/g, '').trim();
}

/**
 * @param {number} a
 * @param {number} b
 * @param {object} [options]
 * @param {boolean} [options.exactWire]  true when the wire carried the value
 *   without float32 quantization (a bytewise integer parameter), so distinct
 *   values must stay distinct rather than collapsing under `Math.fround`.
 * @returns {boolean}
 */
function numericEqual(a, b, options = {}) {
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.isNaN(a) && Number.isNaN(b);
  // An exact wire (bytewise integer) preserves the vehicle's bits verbatim —
  // no quantization to forgive — so any difference is a different stored value,
  // and past 2^24 granting tolerance would confirm one (Math.fround collides
  // consecutive integers). YAGNIDiA (YAGNI, doing it anyway): ordering this
  // ahead of the epsilon changes nothing reachable today, because the codec
  // rejects a non-integer value for an integer type at encode time, so both
  // sides here are always integers and never within epsilon unless equal. Kept
  // strict anyway so the flag's meaning doesn't depend on that distant
  // guarantee.
  if (options.exactWire) return a === b;
  if (Math.abs(a - b) <= 1e-6) return true;
  // Otherwise the value passed through a float32 on the wire, so the echo is the
  // float32 quantization of what was sent — not the float64 the operator typed.
  // 47.9 comes back as 47.900001525878906, which is 1.5e-6 away and outside the
  // absolute tolerance, so a set the vehicle applied reports "echo timeout".
  // Compare at the precision the wire actually carries.
  return Math.fround(a) === Math.fround(b);
}

module.exports = {
        buildParamMessage,
  matchesParamEcho,
  matchesParamEchoWire,
  matchesParamReadReply,
  createParamListCollector,
  resolveParamEncoding,
};
