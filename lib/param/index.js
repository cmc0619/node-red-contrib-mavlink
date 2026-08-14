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
  if (input.action === 'request-list') {
    return {
      name: 'PARAM_REQUEST_LIST',
      fields: { target_system: target.sysid, target_component: target.compid },
    };
  }
  if (input.action === 'read') {
    const paramIndex = input.paramIndex === undefined ? -1 : Number(input.paramIndex);
    return {
      name: 'PARAM_REQUEST_READ',
      fields: {
        target_system: target.sysid,
        target_component: target.compid,
        // An index of 0 or more identifies the parameter on its own — the
        // field's own documentation is "Send -1 to use the param ID field as
        // identifier (else the param ID will be ignored)". So a read addressed
        // by index neither needs an id nor sends one; requiring it would make
        // the editor's Index mode, where the name field is hidden and empty,
        // fail every read.
        param_id: paramIndex >= 0 ? '' : normalizeParamId(input.paramId),
        param_index: paramIndex,
      },
    };
  }
  if (input.action !== 'set') throw new Error(`unknown param action ${JSON.stringify(input.action)}`);
  // A set requires a finite numeric value (§9, #258). The c-cast encode below
  // is a bare Number(value): a blank — editor-blessed, since blank defers to
  // the payload — with no payload value transmitted a silent 0
  // (Number('') === 0), and garbage went out as wire NaN which then
  // self-confirmed twice over — numericEqual(NaN, NaN) is true, and an
  // undefined value short-circuits the echo match in matchesParamEcho. Refuse
  // by name before anything is built, the voice the bytewise path always had
  // (lib/codec/param-union.js). String numerics ('1100') still coerce; an
  // explicit 0 is a value, not a blank.
  if (isBlank(input.value)) {
    throw new Error('param set requires a value, got blank');
  }
  if (!Number.isFinite(Number(input.value))) {
    throw new Error(`param set requires a finite numeric value, got ${describeValue(input.value)}`);
  }
  // No REAL32 default: guessing the type silently mis-encodes the value, and
  // resolveParamType already fails loud on an absent one (Codex, #222).
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
      param_id: normalizeParamId(input.paramId),
      param_value: encodeParamValue(input.value, paramType, encoding),
      param_type: paramType,
    },
  };
}

/**
 * @param {object} request
 * @param {object} decoded
 * @returns {boolean}
 */
function matchesParamEcho(request, decoded) {
  if (!decoded || decoded.name !== 'PARAM_VALUE') return false;
  if (request.target && !echoTargetMatches(request.target, decoded)) return false;
  const fields = decoded.fields || {};
  if (trimParamId(fields.param_id) !== normalizeParamId(request.paramId)) return false;
  if (request.value === undefined) return true;
  // PARAM_VALUE carries the vehicle's own param_type, and its param_value bits
  // were encoded per *that* type — so that is the type the echo must be decoded
  // with. Preferring the request's type misreads the bytes whenever the two
  // disagree: an int parameter set through a REAL32-typed request decodes
  // bytewise as a denormal (1 arrives as 1.4e-45) and never matches, so a set
  // the vehicle actually applied reports "echo timeout". The request's type
  // governs how the outbound PARAM_SET is *encoded*; the vehicle is the
  // authority on its own parameter's type when reading the reply.
  // No typeless guard: the node path cannot produce a set-request without a
  // type (buildParamMessage throws before the subscription exists, #222), and
  // a direct caller's typeless request lands on resolveParamType's own loud
  // failure below rather than a silent declined match.
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
 * **The echo's type must equal the sent type.** The vehicle echoes its *own*
 * `param_type`; when that disagrees with the request's, identical bytes do not
 * mean an identical number — a REAL32-typed set landing on a bytewise integer
 * parameter stores the float's bit pattern as a garbage integer, then echoes
 * those same bytes back. Byte equality would confirm that store; the type gate
 * declines it, and the member honestly reports unconfirmed. False failure over
 * false success — the one outcome echo-confirm exists to prevent
 * (§ "Three kinds of confirmation", §14).
 *
 * @param {{fields: object}} sent  built PARAM_SET message
 * @param {{sysid:number, compid:number}} target  addressed vehicle
 * @param {object} decoded  incoming frame
 * @returns {boolean}
 */
function matchesParamEchoWire(sent, target, decoded) {
  if (!decoded || decoded.name !== 'PARAM_VALUE') return false;
  if (!echoTargetMatches(target, decoded)) return false;
  const echo = decoded.fields || {};
  const sentFields = sent.fields || {};
  if (trimParamId(echo.param_id) !== trimParamId(sentFields.param_id)) return false;
  if (Number(echo.param_type) !== Number(sentFields.param_type)) return false;
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
  if (!decoded || decoded.name !== 'PARAM_VALUE') return false;
  if (request.target && !echoTargetMatches(request.target, decoded)) return false;
  const fields = decoded.fields || {};
  const index = request.paramIndex === undefined ? -1 : Number(request.paramIndex);
  if (index >= 0) return Number(fields.param_index) === index;
  return trimParamId(fields.param_id) === normalizeParamId(request.paramId);
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
      if (!decoded || decoded.name !== 'PARAM_VALUE') return null;
      const fields = decoded.fields || {};
      const index = Number(fields.param_index);
      const count = Number(fields.param_count);
      if (!Number.isInteger(index) || index < 0 || !Number.isInteger(count) || count < 0) return null;
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
 * Resolve param wire encoding.
 *
 * Priority (DESIGN.md §11):
 *   1. explicit `encoding` (`bytewise` | `c-cast`) — present-but-invalid rejects
 *   2. AUTOPILOT_VERSION.capabilities bits
 *   3. named firmware — px4 → bytewise, ardupilot → c-cast. Anything else
 *      throws: absent firmware, an unrecognized token, and `custom` (which
 *      names a real, deployable firmware value but no encoding — see below).
 *
 * @param {object} [opts]
 * @param {string} [opts.encoding]
 * @param {number|null} [opts.capabilities]
 * @param {string} [opts.firmware]
 * @returns {'bytewise'|'c-cast'}
 */
function resolveParamEncoding(opts = {}) {
  // Dynamic msg override: only an absent value falls through. A present string
  // outside the two legal encodings is a caller error (do not silently pick
  // the opposite encoding via capabilities/firmware).
  if (opts.encoding != null && opts.encoding !== '') {
    const explicit = normalizeEncoding(opts.encoding);
    if (!explicit) {
      throw new Error(
        `unsupported param encoding ${JSON.stringify(String(opts.encoding))} (use bytewise or c-cast)`
      );
    }
    return explicit;
  }

  if (opts.capabilities != null && opts.capabilities !== '') {
    const caps = Number(opts.capabilities);
    if (Number.isFinite(caps)) {
      // Spec: a component sets one of these. Prefer bytewise if both appear.
      if ((caps & CAP_PARAM_ENCODE_BYTEWISE) !== 0) return PARAM_ENCODING.BYTEWISE;
      if ((caps & CAP_PARAM_ENCODE_C_CAST) !== 0) return PARAM_ENCODING.C_CAST;
    }
  }

  if (opts.firmware == null || opts.firmware === '') {
    throw new Error('param encoding unresolved: no override, capabilities, or firmware');
  }
  if (opts.firmware === 'px4') return PARAM_ENCODING.BYTEWISE;
  if (opts.firmware === 'ardupilot') return PARAM_ENCODING.C_CAST;
  // Named, but not one we have an encoding for — a typo/wrong-case token
  // (Vehicle Profile requires the editor's own spelling; a `msg.payload.firmware`
  // override does not), or `custom`, which the Vehicle Profile explicitly
  // documents as disabling firmware-specific behaviour including parameter
  // encoding (`FIRMWARE_TYPES`, lib/vehicle/index.js) — a real, deployable
  // value with no convention to guess. Bytewise and C-cast disagree on how an
  // integer rides the PARAM_VALUE float field, so picking either one hands
  // back a clean success report in what may be the *other* stack's convention
  // — the operator named a firmware and got the opposite one silently
  // (DESIGN.md ~1139: bytewise integer 1 read the other way is 1.4e-45).
  // There is no safe direction to fall to, so ask instead of guessing.
  throw new Error(
    `param encoding unresolved: firmware ${JSON.stringify(opts.firmware)} is not ardupilot or ` +
    'px4 (custom has no default encoding either) — set msg.payload.paramEncoding, or supply ' +
    'AUTOPILOT_VERSION.capabilities'
  );
}

/**
 * @param {*} encoding
 * @returns {'bytewise'|'c-cast'|null}
 */
function normalizeEncoding(encoding) {
  if (encoding === PARAM_ENCODING.BYTEWISE || encoding === PARAM_ENCODING.C_CAST) {
    return encoding;
  }
  return null;
}

/**
 * @param {*} value
 * @param {number} paramType
 * @param {'bytewise'|'c-cast'} encoding  as resolved by {@link resolveParamEncoding}
 * @returns {number}
 */
function encodeParamValue(value, paramType, encoding) {
  if (encoding === PARAM_ENCODING.BYTEWISE) return paramValueToWire(value, paramType);
  return Number(value);
}

/**
 * @param {*} value
 * @param {number} paramType
 * @param {'bytewise'|'c-cast'} encoding  as resolved by {@link resolveParamEncoding}
 * @returns {number}
 */
function decodeParamValue(value, paramType, encoding) {
  if (encoding === PARAM_ENCODING.BYTEWISE) return paramValueFromWire(value, paramType);
  return Number(value);
}

/**
 * @param {number|string} paramType
 * @returns {number}
 */
function resolveParamType(paramType) {
  if (typeof paramType === 'number') return paramType;
  const s = String(paramType).trim();
  if (/^\d+$/.test(s)) return Number(s);
  if (!PARAM_TYPE[s]) throw new Error(`unknown MAV_PARAM_TYPE ${JSON.stringify(paramType)}`);
  return PARAM_TYPE[s];
}

/**
 * A refused value, quoted the way it arrived: strings keep their quotes so
 * `'abc'` is visibly a string, while NaN prints as `NaN` rather than
 * JSON.stringify's misleading `null`.
 *
 * @param {*} value
 * @returns {string}
 */
function describeValue(value) {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

/**
 * @param {*} paramId
 * @returns {string}
 */
function normalizeParamId(paramId) {
  const id = trimParamId(paramId);
  if (!id) throw new Error('param id is required');
  if (id.length > 16) throw new Error(`param id '${id}' exceeds MAVLink PARAM_ID length 16`);
  return id;
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
  PARAM_ENCODING,
  CAP_PARAM_ENCODE_BYTEWISE,
  CAP_PARAM_ENCODE_C_CAST,
  buildParamMessage,
  matchesParamEcho,
  matchesParamEchoWire,
  matchesParamReadReply,
  createParamListCollector,
  resolveParamEncoding,
};
