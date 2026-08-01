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

/** @type {number} */
const BADGE_MAX = 24;

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

    // Rate limit: messages per second (0 = unlimited).
    const rateLimitHz = config.rateLimit ? Number(config.rateLimit) : 0;
    const rateLimitMs = rateLimitHz > 0 ? 1000 / rateLimitHz : 0;

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

      // Rate limit: drop if the minimum interval since last delivery has not elapsed.
      if (rateLimitMs > 0) {
        const last = lastDeliveryMs.get(key) || 0;
        if (now - last < rateLimitMs) return;
      }

      // Changed-only: drop if the fields are byte-for-byte identical to the last delivery.
      if (changedOnly) {
        // 64-bit fields decode as BigInt (node-mavlink); JSON.stringify throws
        // on those unless given a replacer. This only affects the comparison
        // key — msg.payload below still carries the original decoded.fields.
        const json = JSON.stringify(decoded.fields, (k, v) =>
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
      const badgeText = capBadge(decoded.name).slice(0, BADGE_MAX);
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
