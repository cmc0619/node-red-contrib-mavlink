'use strict';

/**
 * mavlink-build — MAVLink message builder with Delivery tiers
 * (DESIGN.md §3, §9, §12 step 5).
 *
 * Builds any message from the loaded dialect, optionally sends it via the
 * Connection, and optionally repeats at a configured interval. Follows the
 * chain model (§9) with two outputs.
 *
 * **Field resolution** (lowest to highest priority):
 *   1. Node config `fields` (JSON string of default field values)
 *   2. `msg.payload` object fields — overrides per-key if payload is an object
 *
 * **Delivery tiers** (§9):
 *   - Build  (always available): encode fields, emit the message on output 0;
 *     the downstream can inspect, modify, or forward to `mavlink-out`.
 *   - Send   (requires a Connection): encode + enqueue fire-and-forget;
 *     output 0 carries the input msg as a pass-through trigger.
 *
 * **Repeat interval**: when `repeatMs > 0` the node fires independently of
 * inbound triggers at the configured interval. The actual achieved rate (Hz)
 * is shown in the status badge alongside the configured rate.
 *
 * Chain model (§9):
 *   output 0  — continue: built message (Build tier) or pass-through (Send)
 *   output 1  — status:   fires on every terminal outcome
 *
 * Suppression (§9):
 *   `msg.payload === false`   → silent suppress; neither output fires
 */

const { encodeMessage } = require('../lib/codec');
const { BAND } = require('../lib/connection');
const {
  TIER,
  makeStatusRecord,
  shouldSuppress,
  applyActionStatus,
} = require('../lib/delivery');
const { dialectFromVehicleId, dialectFromConnection } = require('../lib/addressing');
const { loadMetadata } = require('../lib/metadata/load');
const { registerDialectCatalogRoute } = require('../lib/metadata/admin-catalog');

/** Module-scope guard — the constructor is recreated each factory call. */
let messagesRouteRegistered = false;

module.exports = function registerMavlinkBuild(RED) {
  /**
   * @param {object} config  Node-RED node config from the editor
   */
  function MavlinkBuildNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    // Connection is optional — needed for Send tier.
    const connectionNode = config.connection ? RED.nodes.getNode(config.connection) : null;

    // The operator's tier, as configured. A missing Connection does not mean
    // they chose Build — silently rewriting a chosen Send into a Build emits a
    // constructed message on output 0 and reports success for something that
    // was never transmitted, which is the degrade §9 forbids everywhere else.
    // A Send with no Connection is a misconfiguration; it says so at deploy and
    // fails loud per message.
    const tier = config.tier || TIER.SEND;

    const messageName = config.messageName || 'HEARTBEAT';
    const defaultBand = config.band !== undefined && config.band !== null && config.band !== ''
      ? Number(config.band)
      : BAND.CONTROL;

    // Default field values from node config. The editor validates this, so the
    // runtime just reads it.
    const configFields = JSON.parse(config.fields || '{}');

    // Repeat interval.
    const repeatMs = Number(config.repeatMs);
    let repeatTimer = null;
    let rateWindowStart = 0;
    let rateWindowCount = 0;

    /** @type {import('../lib/metadata').DialectBundle|null} */
    let bundle = null;

    // Resolve the dialect bundle per the role × tier matrix (§6).
    //   Build + plain dialect name → load from the bundled registry (no vehicle needed).
    //   Build + '__vehicle' → vehicle node's bundle.
    //   Wire tier → the connection's bound profile node's bundle (custom-safe).
    if (tier === TIER.BUILD) {
      // Editor requires dialect on Build (§6) — trust config.dialect.
      const dialectName = config.dialect;
      if (dialectName === '__vehicle') {
        try {
          bundle = dialectFromVehicleId(RED, config.vehicle, { rethrow: true });
        } catch (err) {
          applyActionStatus(node, 'invalid', 'dialect unavailable');
          node.error(`mavlink-build: ${err.message}`);
          return;
        }
        if (!bundle) {
          applyActionStatus(node, 'invalid', 'invalid config');
          return;
        }
      } else {
        const { api } = loadMetadata('mavlink-build', RED);
        if (!api) {
          applyActionStatus(node, 'invalid', 'dialect unavailable');
          return;
        }
        bundle = api.loadBundled(dialectName);
      }
    } else {
      // Wire tier: Connection's bound profile governs (§6 hidden-is-not-honored).
      try {
        bundle = dialectFromConnection(RED, connectionNode, { rethrow: true });
      } catch (err) {
        applyActionStatus(node, 'invalid', 'dialect unavailable');
        node.error(`mavlink-build: ${err.message}`);
        return;
      }
      if (!bundle) {
        applyActionStatus(node, 'invalid', 'invalid config');
        return;
      }
    }

    const messageMeta = bundle.messages[messageName];
    if (!messageMeta) {
      applyActionStatus(node, 'invalid', `unknown: ${messageName}`);
      return;
    }

    // No idle "ready" badge — the label already names the message (§6: action
    // nodes report last activity; pre-trigger status is only for misconfig).
    //
    // Clearing is not the same as badging, and it is required. Every bail
    // above writes a red badge and returns; the runtime only publishes a
    // status clear when a node is *removed* (@node-red/runtime
    // flows/Flow.js:395-399), not when it is modified and restarted, and the
    // editor just replays whatever status events arrive. So a node that was
    // misconfigured, then fixed and redeployed, would keep displaying the dead
    // badge until a message happened to flow through. Reaching here means the
    // config resolved, so say so once. A wire tier reaching here necessarily
    // has a working Connection — the dialect comes from its bound profile, so
    // the branch above already bailed otherwise — which is why this is a plain
    // clear rather than the shared applyConnectionStatus the senders use.
    node.status({});

    /**
     * Core action: merge fields, encode, and emit based on the tier.
     *
     * @param {object|null} triggerMsg  the inbound Node-RED msg, or null when
     *   fired from the repeat timer
     * @param {Function|undefined} done  input-handler done callback, when this
     *   execution came from an inbound message
     * @returns {boolean} true when execution completed successfully
     */
    function execute(triggerMsg, done) {
      // Merge config defaults with any per-message overrides from the trigger.
      const overrides =
        triggerMsg &&
        triggerMsg.payload !== null &&
        typeof triggerMsg.payload === 'object' &&
        !Array.isArray(triggerMsg.payload)
          ? triggerMsg.payload
          : {};
      const rawFields = { ...configFields, ...overrides };

      // Encode: apply the field codec to produce wire-ready values.
      let encodedFields;
      try {
        encodedFields = encodeMessage(messageMeta, rawFields, { enums: bundle.enums });
      } catch (err) {
        const sr = makeStatusRecord({
          result: 'failed',
          reason: err.message,
          message: messageName,
          timestamp: Date.now(),
        });
        applyActionStatus(node, 'error', err.message);
        node.send([null, sr]);
        if (triggerMsg) {
          done(new Error(`mavlink-build encode: ${err.message}`));
        } else {
          node.error(`mavlink-build encode: ${err.message}`, {});
        }
        return false;
      }

      const builtMessage = { name: messageName, fields: encodedFields };

      if (tier === TIER.BUILD) {
        // Build tier: emit the message on output 0 for downstream processing.
        const outMsg = triggerMsg ? { ...triggerMsg } : {};
        outMsg.payload = { message: builtMessage, messageName, tier: TIER.BUILD };

        const sr = makeStatusRecord({
          result: 'built',
          message: messageName,
          tier: TIER.BUILD,
          timestamp: Date.now(),
        });
        applyActionStatus(node, 'ok', messageName);
        node.send([outMsg, sr]);
        return true;
      }

      // Send tier: enqueue on the connection queue.
      const band = (triggerMsg && triggerMsg.band !== undefined)
        ? Number(triggerMsg.band)
        : defaultBand;
      const target = (triggerMsg && triggerMsg.target) || null;
      const identityId = (triggerMsg && triggerMsg.identityId) || undefined;

      // The queue send can throw synchronously (full Control band, unknown
      // identity, disabled connection). Input-triggered failures go through the
      // handler's Catch path; timer-triggered failures have no input `done`, so
      // they use the legacy node.error path rather than escaping.
      try {
        connectionNode.send(builtMessage, { band, target, identityId });
      } catch (err) {
        const sr = makeStatusRecord({
          result: 'failed',
          reason: err.message,
          message: messageName,
          tier: TIER.SEND,
          band,
          timestamp: Date.now(),
        });
        applyActionStatus(node, 'error', err.message);
        node.send([null, sr]);
        if (triggerMsg) {
          done(new Error(`mavlink-build send: ${err.message}`));
        } else {
          node.error(`mavlink-build send: ${err.message}`, {});
        }
        return false;
      }

      // Track achieved rate.
      const now = Date.now();
      rateWindowCount += 1;
      if (now - rateWindowStart >= 1000) {
        rateWindowStart = now;
        rateWindowCount = 1;
      }

      // §9: on the Send tier, output 0 is a pass-through trigger, not a Build
      // envelope — a downstream node advances on success and never inspects the
      // payload. Preserve the inbound msg unchanged; a timer-fired send has no
      // upstream trigger, so it emits the fire-and-forget result instead.
      const outMsg = triggerMsg
        ? { ...triggerMsg }
        : { payload: { result: 'sent', messageName, tier: TIER.SEND } };

      const sr = makeStatusRecord({
        result: 'sent',
        message: messageName,
        tier: TIER.SEND,
        band,
        timestamp: now,
      });

      applyActionStatus(node, 'ok', repeatMs > 0
        ? `${messageName} ${rateWindowCount}/${Math.round(1000 / repeatMs)}Hz`
        : messageName);
      node.send([outMsg, sr]);
      return true;
    }

    // Input handler.
    node.on('input', (msg, _send, done) => {
      if (shouldSuppress(msg)) {
        done();
        return;
      }

      // execute() returns false exactly on the paths where it already called
      // done(err), so a true return is the only one still owing a done().
      if (execute(msg, done)) done();
    });

    // Repeat timer.
    if (repeatMs > 0) {
      rateWindowStart = Date.now();
      repeatTimer = setInterval(() => {
        execute(null);
      }, repeatMs);
    }

    node.on('close', (done) => {
      if (repeatTimer) {
        clearInterval(repeatTimer);
        repeatTimer = null;
      }
      done();
    });
  }

  /**
   * Admin endpoint for the Build editor's message dropdown (§6). Registered
   * once per process and isolated from metadata-load failures so the palette
   * node still registers when `mavlink-mappings` is absent.
   */
  if (!messagesRouteRegistered) {
    registerDialectCatalogRoute(RED, {
      path: '/mavlink/build/messages',
      logLabel: 'mavlink-build',
      unavailableMessage: 'message catalog unavailable',
      fromBundle: (api, bundle, dialect) => api.catalogMessagesFromBundle(bundle, dialect),
      fromDialect: (api, dialect) => api.listMessagesCatalog(dialect),
    });
    messagesRouteRegistered = true;
  }

  RED.nodes.registerType('mavlink-build', MavlinkBuildNode);
};
