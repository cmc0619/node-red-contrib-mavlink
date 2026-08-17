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
const { applyConnectionStatus, isBlank } = require('../lib/addressing');

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
 * Writes suppressed inside a window are not lost: one trailing write is latched
 * for the end of it, so the badge settles on the true total within an interval
 * of the last delivery rather than freezing wherever the burst happened to be.
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

    // A consumer node with no inputs: when the Connection does not resolve
    // there is nothing to subscribe to and nothing to sink, so the badge-and-
    // return is the whole story here.
    const connectionNode = RED.nodes.getNode(config.connection);
    applyConnectionStatus(node, true, connectionNode);
    if (!connectionNode) return;

    // Message filters — an empty list means "match all" (#211). The editor
    // owns the shape: oneditsave trims each row and drops blanks and
    // duplicates, and the array red ring guards a hand-edited flow.
    const filterMessages = config.messages;
    const filterSysid = isBlank(config.sysid) ? null : Number(config.sysid);
    const filterCompid = isBlank(config.compid) ? null : Number(config.compid);

    const changedOnly = !!config.changedOnly;
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
    // editor"); the parse skips tokens it cannot read, same as fanout's
    // params JSON treating unparseable saved config as empty.
    const rate = parseRateLimit(config.rateLimit);

    /** @type {Map<string, string>} key → last JSON of fields */
    const lastFieldJson = new Map();
    // One warning per (message, absent-name) pair for the node's lifetime —
    // at stream rates a per-frame warn would bury the flow it exists to help.
    const warnedAbsentFields = new Set();
    /** @type {Map<string, number>} key → last delivery timestamp ms */
    const lastDeliveryMs = new Map();

    /** Badge throttling state (§6 — do not flood status on high-rate streams). */
    let lastStatusMs = 0;
    /** Pending trailing write, so a burst's last frames still reach the badge. */
    let flushTimer = null;
    /** Message name most recently delivered — what a trailing write names. */
    let lastName = null;
    /**
     * Messages this node has delivered since deploy, across every subscription.
     * A node-wide total, not per message name: with a multi-message filter the
     * badge names the message that just arrived and the count is the node's
     * throughput. Resets on deploy because the node is reconstructed.
     */
    let delivered = 0;

    node.status({ fill: 'grey', shape: 'ring', text: 'waiting' });

    /**
     * Write the badge and open a fresh throttle window.
     *
     * Count first: capBadge truncates the tail and §6 caps badges at 24
     * characters, so with a long name (GLOBAL_POSITION_INT is 19) a trailing
     * count would be exactly the part that got cut.
     *
     * @param {number} at  timestamp to treat as the write time
     */
    function paintBadge(at) {
      node.status({
        fill: 'green',
        shape: 'dot',
        text: capBadge(`${delivered} ${lastName}`),
      });
      lastStatusMs = at;
    }

    /**
     * Deliver one decoded message, subject to the field predicate, the rate
     * limit, and changed-only. Shared by every subscription this node holds.
     *
     * @param {object} decoded
     */
    const onDecoded = (decoded) => {
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
        const last = lastDeliveryMs.get(key) || 0;
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
        // A named field this message type does not carry is a config typo, and
        // silently it is a vicious one: every frame's subject stringifies
        // identically, so the stream delivers once and then never again, with
        // nothing to say why. Warn once per absent name; the comparison still
        // runs exactly as configured.
        if (changedFields) {
          for (const name of changedFields) {
            if (!(name in decoded.fields) && !warnedAbsentFields.has(`${key}:${name}`)) {
              warnedAbsentFields.add(`${key}:${name}`);
              node.warn(`changed-only: ${decoded.name} carries no field "${name}" — with every named field absent, the message delivers once and is then suppressed`);
            }
          }
        }
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

      delivered += 1;

      lastName = decoded.name;

      // Rate-limit status writes to STATUS_MIN_INTERVAL_MS, unconditionally.
      //
      // No "refresh immediately when the name changes" exemption: with a
      // multi-message filter (#211) the arriving name alternates on nearly
      // every frame, so that exemption fired every time and the throttle never
      // engaged — two 50 Hz streams wrote the badge 100×/s. Measured at 200 of
      // 200 deliveries before that came out.
      //
      // Suppressed writes are not simply dropped: one trailing write is latched
      // for the end of the window, so when a burst stops the badge lands on the
      // true total instead of whatever it happened to show mid-burst.
      if (now - lastStatusMs >= STATUS_MIN_INTERVAL_MS) {
        paintBadge(now);
      } else if (flushTimer === null) {
        // Latched, not rescheduled per delivery: at 50 Hz a per-message
        // clear+set would be ~100 timer operations a second to avoid ~46 status
        // writes — more work than it saves. One timer per window is four a
        // second, and later deliveries in the window ride the timer already set.
        flushTimer = setTimeout(() => {
          flushTimer = null;
          paintBadge(Date.now());
        }, STATUS_MIN_INTERVAL_MS - (now - lastStatusMs));
        flushTimer.unref();
      }
    };

    // One subscription per message name. The registry keys subscribers by id
    // and matches each filter independently, so N names are N subscriptions
    // sharing one handler — no change to the matcher, and a name can never
    // match twice. An empty list is a single unfiltered subscription, which is
    // what a blank message filter always meant.
    const target = {
      sysid: filterSysid !== null ? filterSysid : undefined,
      compid: filterCompid !== null ? filterCompid : undefined,
    };
    const unsubscribes = filterMessages.length
      ? filterMessages.map((name) => connectionNode.subscribe({ ...target, message: name }, onDecoded))
      : [connectionNode.subscribe(target, onDecoded)];

    node.on('close', () => {
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      for (const unsubscribe of unsubscribes) unsubscribe();
    });
  }

  RED.nodes.registerType('mavlink-in', MavlinkInNode);
};

/**
 * Comma-separated name list → array, or null when blank (= all).
 *
 * @param {string} value  editor-owned comma list; the field red ring owns the shape
 * @returns {string[]|null}
 */
function parseNameList(value) {
  const names = value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  return names.length ? names : null;
}

/**
 * Parse the rate-limit config: blank/0 = unlimited; a bare number is the Hz
 * for every message; `NAME=Hz` comma pairs limit named messages, and a bare
 * number among the pairs sets the default for unlisted names. `NAME=0` means
 * that message is unlimited. The editor validator is the loud-failure point
 * for the shape (§2 config trust); tokens that still cannot be read — only
 * reachable via hand-edited flow JSON — are skipped.
 *
 * @param {*} value
 * @returns {{defaultMs: number, perMessageMs: Map<string, number>}}
 */
function parseRateLimit(value) {
  const result = { defaultMs: 0, perMessageMs: new Map() };
  const raw = String(value).trim();
  if (!raw) return result;
  for (const token of raw.split(',')) {
    const part = token.trim();
    if (!part) continue;
    const eq = part.indexOf('=');
    if (eq === -1) {
      const hz = Number(part);
      if (Number.isFinite(hz) && hz > 0) result.defaultMs = 1000 / hz;
      continue;
    }
    const name = part.slice(0, eq).trim();
    const rawHz = part.slice(eq + 1).trim();
    // `Number('')` is 0, and 0 is the *explicit* "unlimited" value — so a
    // blank (`ATTITUDE=`) would silently delete the limit the operator asked
    // for, and a second blank token would clobber a good earlier one. An
    // unreadable value is skipped instead, leaving the message on the default
    // limit: the node keeps skipping rather than falling open.
    const hz = rawHz === '' ? NaN : Number(rawHz);
    if (name && Number.isFinite(hz) && hz >= 0) {
      result.perMessageMs.set(name, hz > 0 ? 1000 / hz : 0);
    }
  }
  return result;
}
