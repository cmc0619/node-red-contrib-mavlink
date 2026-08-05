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

    const connectionNode = RED.nodes.getNode(config.connection);
    if (!connectionNode || !connectionNode.subscribe) {
      node.status({ fill: 'red', shape: 'ring', text: 'invalid config' });
      return;
    }

    // Filter settings — null means "match all".
    const filterMessage = config.message ? String(config.message).trim() : null;
    const filterSysid =
      config.sysid !== undefined && config.sysid !== null && String(config.sysid).trim() !== ''
        ? Number(config.sysid)
        : null;
    const filterCompid =
      config.compid !== undefined && config.compid !== null && String(config.compid).trim() !== ''
        ? Number(config.compid)
        : null;

    const changedOnly = !!config.changedOnly;
    // Changed-only field subset: compare only these fields when set, so a
    // hot timestamp does not make every frame look "changed".
    const changedFields = parseNameList(config.changedFields);

    // Field predicate: pass only frames where `fieldName` exists — and, when a
    // value is given, string-equals it (enums and BigInts compare naturally).
    const fieldName = config.fieldName ? String(config.fieldName).trim() : null;
    const fieldValue =
      config.fieldValue === undefined || config.fieldValue === null || String(config.fieldValue).trim() === ''
        ? null
        : String(config.fieldValue).trim();

    // Rate limit: one Hz for everything, or per-message `NAME=Hz` pairs with
    // an optional bare Hz default for unlisted names. A filter that cannot
    // parse its own config must never silently pass everything — malformed
    // input fails closed at deploy.
    const rate = parseRateLimit(config.rateLimit);
    if (rate.error) {
      node.status({ fill: 'red', shape: 'ring', text: 'invalid config' });
      node.error(`mavlink-in: ${rate.error}`);
      return;
    }

    /** @type {Map<string, string>} key → last JSON of fields */
    const lastFieldJson = new Map();
    /** @type {Map<string, number>} key → last delivery timestamp ms */
    const lastDeliveryMs = new Map();

    /** Badge throttling state (§6 — do not flood status on high-rate streams). */
    let lastStatusText = null;
    let lastStatusMs = 0;

    const subscribeFilter = {
      message: filterMessage !== null ? filterMessage : undefined,
      sysid: filterSysid !== null ? filterSysid : undefined,
      compid: filterCompid !== null ? filterCompid : undefined,
    };

    node.status({ fill: 'grey', shape: 'ring', text: 'waiting' });

    const unsubscribe = connectionNode.subscribe(subscribeFilter, (decoded) => {
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
    });

    node.on('close', () => {
      unsubscribe();
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
 * that message is unlimited. Malformed tokens return an error — fail closed.
 *
 * @param {*} value
 * @returns {{defaultMs: number, perMessageMs: Map<string, number>, error?: string}}
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
      if (!Number.isFinite(hz) || hz < 0) {
        return { ...result, error: `rate limit ${JSON.stringify(part)} is not a Hz number or NAME=Hz pair` };
      }
      result.defaultMs = hz > 0 ? 1000 / hz : 0;
      continue;
    }
    const name = part.slice(0, eq).trim();
    const hz = Number(part.slice(eq + 1).trim());
    if (!name || !Number.isFinite(hz) || hz < 0) {
      return { ...result, error: `rate limit pair ${JSON.stringify(part)} must be NAME=Hz` };
    }
    result.perMessageMs.set(name, hz > 0 ? 1000 / hz : 0);
  }
  return result;
}
