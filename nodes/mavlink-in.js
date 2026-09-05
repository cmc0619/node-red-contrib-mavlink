'use strict';

/**
 * mavlink-in — Inbound MAVLink subscriber (DESIGN.md §3, §9, §12 step 5).
 *
 * Subscribes to decoded traffic on a Connection config node. Optional filters
 * narrow delivery by message name, sysid, and compid. Changed-only mode skips
 * a message whose fields are identical to the last delivery for that
 * (message, sysid, compid) key. Rate limiting keeps high-rate streams from
 * flooding downstream nodes.
 *
 * This is a **consumer** node, not an action node — it has one output and does
 * not follow the two-output chain model (§9). It fires whenever a matching
 * inbound message arrives.
 *
 * Output msg shape:
 *   msg.topic    — message name (e.g. `HEARTBEAT`)
 *   msg.payload  — decoded field values (snake_case object)
 *   msg.sysid    — source system id
 *   msg.compid   — source component id
 *   msg.trusted  — signing trust flag from the connection
 */

const { capBadge } = require('../lib/delivery');
const { isBlank } = require('../lib/addressing/resolve');

/**
 * Minimum interval (ms) between status-badge writes.
 * A high-rate stream (e.g. 50 Hz ATTITUDE) would otherwise rewrite the badge
 * 50×/s and flood the editor; the message rate limit above governs wire
 * delivery, not the badge (§6).
 *
 * The interval applies unconditionally — no exemption for a changed message
 * name, and none for changed badge text. Either would fire on essentially every
 * frame: the delivery count differs every time, and with a multi-message filter
 * (#211) so does the arriving name.
 *
 * A write suppressed inside a window is dropped: the badge names recent
 * traffic, nothing more.
 * @type {number}
 */
const STATUS_MIN_INTERVAL_MS = 250;

/**
 * Fields excluded from the changed-only comparison when `changedFields` is
 * blank. Every one advances on every frame, so comparing them makes each
 * message look changed and the filter delivers the whole stream — the exact
 * opposite of what changed-only is for, and the defect this set fixes (#300).
 * The names are the timestamp spellings actually used across the bundled
 * dialects, found by enumerating every field of every message (2026-08-14) —
 * an earlier version of this comment claimed four spellings and a reference
 * implementation neither of which survived checking. `time_boot_us` is
 * AUTOPILOT_STATE_FOR_GIMBAL_DEVICE's clock, streamed continuously by gimbal
 * devices; `uptime` is ONBOARD_COMPUTER_STATUS's, advancing every frame —
 * both reproduced the #300 defect under changed-only before joining the set.
 *
 * Deliberately NOT excluded: UTM_GLOBAL_POSITION's `time` (its position
 * fields march with it, so the exclusion would buy nothing) and
 * CAMERA_CAPTURE_STATUS's `recording_time_ms` (it stops when recording
 * stops — that edge is a state change an operator may be listening for).
 *
 * A message whose *only* fields are timestamps (SYSTEM_TIME) therefore
 * compares as an empty subject and delivers once. That is correct rather than
 * a corner: nothing but the clock moved, and an operator who wants the clock
 * names it in `changedFields`, which is compared verbatim.
 */
const TIMESTAMP_FIELDS = new Set([
  'time_boot_ms', 'time_boot_us', 'time_usec', 'time_unix_usec', 'timestamp', 'uptime',
]);

/**
 * The decoded fields minus the timestamps — the default changed-only subject.
 *
 * @param {object} fields  decoded message fields
 * @returns {object}
 */
function withoutTimestamps(fields) {
  const subject = {};
  for (const name of Object.keys(fields)) {
    if (!TIMESTAMP_FIELDS.has(name)) subject[name] = fields[name];
  }
  return subject;
}

module.exports = function registerMavlinkIn(RED) {
  /**
   * @param {object} config  Node-RED node config from the editor
   */
  function MavlinkInNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    // A consumer node with no inputs: the Connection resolves once here, and
    // an unresolvable one craters on the subscribe below — loud in the deploy
    // log, per the flow that shipped the bad reference (§0).
    const connectionNode = RED.nodes.getNode(config.connection);

    // Message filters — an empty list means "match all" (#211). The editor
    // owns the shape: oneditsave trims each row and drops blanks and
    // duplicates, and the array red ring guards a hand-edited flow.
    const filterMessages = config.messages;
    const filterSysid = isBlank(config.sysid) ? undefined : Number(config.sysid);
    const filterCompid = isBlank(config.compid) ? undefined : Number(config.compid);

    // Unknown frames are opt-in. A msgid the dialect does not carry arrives as
    // UNKNOWN_<id> (#344); that is a diagnostic, not traffic a working flow
    // asked for, so an In node stays quiet about it until the box is ticked.
    const showUnknown = config.showUnknown;

    const changedOnly = config.changedOnly;
    // Changed-only field subset: compare only these fields when set, so a
    // hot timestamp does not make every frame look "changed".
    const changedFields = parseNameList(config.changedFields);

    // Field predicate: pass only frames where `fieldName` exists — and, when a
    // value is given, string-equals it (enums and BigInts compare naturally).
    const fieldName = config.fieldName ? String(config.fieldName).trim() : null;
    const fieldValue = isBlank(config.fieldValue) ? null : String(config.fieldValue).trim();

    // Rate limit: one Hz for everything, or per-message `NAME=Hz` pairs with
    // an optional bare Hz default for unlisted names. The editor validator is
    // the loud-failure point for this shape (§2 config trust, AGENTS
    // "Runtime code MUST NOT duplicate validation already performed by the
    // editor").
    const rate = parseRateLimit(config.rateLimit);

    /** @type {Map<string, string>} key → last JSON of fields */
    const lastFieldJson = new Map();
    /** @type {Map<string, number>} key → last delivery timestamp ms */
    const lastDeliveryMs = new Map();

    /** Badge throttling state (§6 — do not flood status on high-rate streams). */
    let lastStatusMs = 0;

    node.status({ fill: 'grey', shape: 'ring', text: 'waiting' });

    /**
     * Deliver one decoded message, subject to the field predicate, the rate
     * limit, and changed-only. Shared by every subscription this node holds.
     *
     * @param {object} decoded
     */
    const onDecoded = (decoded) => {
      // Ahead of every other filter: an unwanted unknown should not consume a
      // rate-limit slot or seed the changed-only map for a name that will
      // never be delivered.
      if (!showUnknown && isUnknownName(decoded.name)) return;

      const key = `${decoded.name}\u0000${decoded.sysid}\u0000${decoded.compid}`;
      const now = Date.now();

      // Field predicate: absent field never passes; a configured value must
      // string-equal the decoded one.
      if (fieldName) {
        const value = decoded.fields[fieldName];
        if (value === undefined) return;
        if (fieldValue !== null && String(value) !== fieldValue) return;
      }

      // Rate limit: drop if the minimum interval since last delivery has not
      // elapsed — per message name when a pair names it, else the default.
      const limitMs = rate.perMessageMs.has(decoded.name)
        ? rate.perMessageMs.get(decoded.name)
        : rate.defaultMs;
      if (limitMs > 0) {
        const last = lastDeliveryMs.get(key);
        if (now - last < limitMs) return;
      }

      // Changed-only: drop if the compared fields are byte-for-byte identical
      // to the last delivery. `changedFields` restricts the comparison; blank
      // means every field *except* the timestamps, which is what makes the
      // feature work at all — comparing decoded.fields wholesale meant any
      // message carrying time_boot_ms differed on every frame, so changed-only
      // silently passed the entire stream (#300). The comment here used to
      // describe that exclusion while the code did not implement it.
      if (changedOnly) {
        // A named field the message does not carry reads as undefined on
        // every frame, so with every name absent the stream delivers once
        // and is then suppressed — the natural reading of the saved list
        // (the editor rings its shape; the catalog is not re-checked here).
        const subject = changedFields
          ? Object.fromEntries(changedFields.map((name) => [name, decoded.fields[name]]))
          : withoutTimestamps(decoded.fields);
        // 64-bit fields decode as BigInt (node-mavlink); JSON.stringify throws
        // on those unless given a replacer. This only affects the comparison
        // key — msg.payload below still carries the original decoded.fields.
        const json = JSON.stringify(subject, (k, v) =>
          typeof v === 'bigint' ? v.toString() : v
        );
        if (lastFieldJson.get(key) === json) return;
        lastFieldJson.set(key, json);
      }

      lastDeliveryMs.set(key, now);

      node.send({
        topic: decoded.name,
        payload: decoded.fields,
        sysid: decoded.sysid,
        compid: decoded.compid,
        trusted: decoded.trusted,
      });

      // Rate-limit status writes to STATUS_MIN_INTERVAL_MS, unconditionally.
      //
      // No "refresh immediately when the name changes" exemption: with a
      // multi-message filter (#211) the arriving name alternates on nearly
      // every frame, so that exemption fired every time and the throttle never
      // engaged — two 50 Hz streams wrote the badge 100×/s. Measured at 200 of
      // 200 deliveries before that came out.
      //
      // A suppressed write is simply dropped (owner ruling, 2026-08-18): the
      // badge names recent traffic, nothing more. The delivered counter and
      // the latched trailing write went with that ruling — the counter grew
      // until it was the only thing the 24-character cap kept, and the flush
      // existed to land the badge on a total nobody needed.
      if (now - lastStatusMs >= STATUS_MIN_INTERVAL_MS) {
        node.status({ fill: 'green', shape: 'dot', text: capBadge(decoded.name) });
        lastStatusMs = now;
      }
    };

    // One subscription per message name. The registry keys subscribers by id
    // and matches each filter independently, so N names are N subscriptions
    // sharing one handler — no change to the matcher, and a name can never
    // match twice. An empty list is a single unfiltered subscription, which is
    // what a blank message filter always meant.
    const target = { sysid: filterSysid, compid: filterCompid };
    const unsubscribes = filterMessages.length
      ? filterMessages.map((name) => connectionNode.subscribe({ ...target, message: name }, onDecoded))
      : [connectionNode.subscribe(target, onDecoded)];

    // A name filter is a whitelist, and an unknown id cannot be whitelisted —
    // its name is the thing you do not know yet. So with both a name filter
    // and Show unknown, one more subscription carries the unknowns alongside
    // the named ones. Unfiltered nodes need nothing extra: their single
    // subscription already sees every frame, and onDecoded does the gating.
    if (showUnknown && filterMessages.length) {
      unsubscribes.push(connectionNode.subscribe(target, (decoded) => {
        if (isUnknownName(decoded.name)) onDecoded(decoded);
      }));
    }

    node.on('close', () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    });
  }

  RED.nodes.registerType('mavlink-in', MavlinkInNode);
};

/**
 * True for the synthetic name `decode()` gives a msgid the bound dialect does
 * not carry (#344). Matched on the prefix the wire produces, not on a
 * registry lookup: by construction there is no definition to look up.
 *
 * @param {string} name  decoded message name
 * @returns {boolean}
 */
function isUnknownName(name) {
  return name.startsWith('UNKNOWN_');
}

/**
 * Comma-separated name list → array, or null when blank (= all).
 *
 * @param {string} value  editor-owned comma list; the field red ring owns the shape
 * @returns {string[]|null}
 */
function parseNameList(value) {
  return isBlank(value) ? null : value.split(',');
}

/**
 * Parse the rate-limit config: blank/0 = unlimited; a bare number is the Hz
 * for every message; `NAME=Hz` comma pairs limit named messages, and a bare
 * number among the pairs sets the default for unlisted names. `NAME=0` means
 * that message is unlimited. The editor owns the shape.
 *
 * @param {string} value  editor-owned; the field red ring owns the shape
 * @returns {{defaultMs: number, perMessageMs: Map<string, number>}}
 */
function parseRateLimit(value) {
  const result = { defaultMs: 0, perMessageMs: new Map() };
  for (const token of value.split(',')) {
    const part = token.trim();
    const eq = part.indexOf('=');
    if (eq === -1) {
      const hz = Number(part);
      result.defaultMs = hz > 0 ? 1000 / hz : 0;
      continue;
    }
    const name = part.slice(0, eq).trim();
    const hz = Number(part.slice(eq + 1).trim());
    result.perMessageMs.set(name, hz > 0 ? 1000 / hz : 0);
  }
  return result;
}
