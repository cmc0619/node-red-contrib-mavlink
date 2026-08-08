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
 * Minimum interval (ms) between status-badge writes for an unchanged badge.
 * A high-rate stream (e.g. 50 Hz ATTITUDE) would otherwise rewrite the same
 * badge 50×/s and flood the editor; the message rate limit above governs wire
 * delivery, not the badge (§6). The badge still updates immediately whenever
 * its text changes so it never lags behind the actual traffic.
 * @type {number}
 */
const STATUS_MIN_INTERVAL_MS = 250;

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

    // Message filters — an empty list means "match all" (#211).
    const filterMessages = (Array.isArray(config.messages) ? config.messages : [])
      .map((name) => String(name).trim())
      .filter(Boolean);
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
    /** @type {Map<string, number>} key → last delivery timestamp ms */
    const lastDeliveryMs = new Map();

    /** Badge throttling state (§6 — do not flood status on high-rate streams). */
    let lastStatusText = null;
    let lastStatusMs = 0;

    node.status({ fill: 'grey', shape: 'ring', text: 'waiting' });

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
        const value = decoded.fields ? decoded.fields[fieldName] : undefined;
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
      // to the last delivery; `changedFields` restricts the comparison so a
      // hot timestamp does not make every frame look "changed".
      if (changedOnly) {
        const subject = changedFields
          ? Object.fromEntries(changedFields.map((name) => [name, decoded.fields ? decoded.fields[name] : undefined]))
          : decoded.fields;
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

      // Rate-limit status writes: refresh only when the badge text changes or
      // after the minimum interval, so a steady high-rate stream does not
      // rewrite an identical badge on every frame.
      const badgeText = capBadge(decoded.name);
      if (badgeText !== lastStatusText || now - lastStatusMs >= STATUS_MIN_INTERVAL_MS) {
        node.status({ fill: 'green', shape: 'dot', text: badgeText });
        lastStatusText = badgeText;
        lastStatusMs = now;
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
      for (const unsubscribe of unsubscribes) unsubscribe();
    });
  }

  RED.nodes.registerType('mavlink-in', MavlinkInNode);
};

/**
 * Comma-separated name list → array, or null when blank (= all).
 *
 * @param {*} value
 * @returns {string[]|null}
 */
function parseNameList(value) {
  const names = String(value || '')
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
  const raw = String(value === undefined || value === null ? '' : value).trim();
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
