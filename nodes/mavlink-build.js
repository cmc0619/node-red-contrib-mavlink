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
  capBadge,
  reportDoneError,
} = require('../lib/delivery');

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
    const hasConnection = connectionNode && typeof connectionNode.send === 'function';

    // Effective tier: clamp to Build when no connection is configured.
    const tier = (hasConnection && config.tier !== TIER.BUILD) ? (config.tier || TIER.SEND) : TIER.BUILD;

    const messageName = config.messageName || 'HEARTBEAT';
    const defaultBand = config.band !== undefined && config.band !== null && config.band !== ''
      ? Number(config.band)
      : BAND.CONTROL;

    // Default field values from node config (JSON string). Malformed JSON here
    // is a config error, not a reason to abort the whole deploy with an
    // uncaught throw from the constructor — surface it as an invalid-config
    // badge (§6) and stop, so sibling flows keep loading.
    let configFields = {};
    if (config.fields && typeof config.fields === 'string' && config.fields.trim()) {
      try {
        configFields = JSON.parse(config.fields);
      } catch (err) {
        node.status({ fill: 'red', shape: 'ring', text: 'invalid config' });
        node.error(`mavlink-build: invalid fields JSON — ${err.message}`);
        return;
      }
    }

    // Repeat interval.
    const repeatMs = config.repeatMs ? Number(config.repeatMs) : 0;
    let repeatTimer = null;
    let lastFireMs = 0;
    let fireCount = 0;
    let rateWindowStart = 0;
    let rateWindowCount = 0;

    /** @type {import('../lib/metadata').DialectBundle|null} */
    let bundle = null;

    // Resolve the dialect bundle per the role × tier matrix (§6).
    //   Build + plain dialect name → load from the bundled registry (no vehicle needed).
    //   Build + '__vehicle' or legacy (vehicle set, no dialect) → vehicle node's bundle.
    //   Wire tier → the connection's bound profile node's bundle (custom-safe).
    if (tier === TIER.BUILD) {
      const dialectName = config.dialect;
      if (dialectName && dialectName !== '__vehicle') {
        bundle = require('../lib/metadata').loadBundled(dialectName);
      } else {
        const vehicleNode = RED.nodes.getNode(config.vehicle);
        if (!vehicleNode || typeof vehicleNode.getDialect !== 'function') {
          node.status({ fill: 'red', shape: 'ring', text: 'invalid config' });
          return;
        }
        try {
          bundle = vehicleNode.getDialect();
        } catch (err) {
          node.status({ fill: 'red', shape: 'ring', text: 'dialect unavailable' });
          node.error(`mavlink-build: ${err.message}`);
          return;
        }
      }
    } else {
      // Wire tier: the connection's bound profile governs — hidden is not
      // honored, so a stale config.vehicle cannot override it (§6). Resolve the
      // profile node and call getDialect(): that is the one invocation that
      // works for bundled and custom XML dialects alike; loadBundled(name)
      // would break custom profiles.
      const profileId = connectionNode.vehicle && connectionNode.vehicle.id;
      const profileNode = profileId ? RED.nodes.getNode(profileId) : null;
      if (!profileNode || typeof profileNode.getDialect !== 'function') {
        node.status({ fill: 'red', shape: 'ring', text: 'invalid config' });
        return;
      }
      try {
        bundle = profileNode.getDialect();
      } catch (err) {
        node.status({ fill: 'red', shape: 'ring', text: 'dialect unavailable' });
        node.error(`mavlink-build: ${err.message}`);
        return;
      }
    }

    const messageMeta = bundle.messages[messageName];
    if (!messageMeta) {
      node.status({ fill: 'red', shape: 'ring', text: capBadge(`unknown: ${messageName}`) });
      return;
    }

    if (!hasConnection && tier !== TIER.BUILD) {
      node.status({ fill: 'red', shape: 'ring', text: 'no connection for Send' });
      return;
    }

    // No idle "ready" badge — the label already names the message (§6: action
    // nodes report last activity; pre-trigger status is only for misconfig).

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
        applyActionStatus(node, 'error', capBadge(err.message));
        node.send([null, sr]);
        if (triggerMsg) {
          reportDoneError(node, new Error(`mavlink-build encode: ${err.message}`), triggerMsg, done);
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
        applyActionStatus(node, 'ok', capBadge(messageName));
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
        applyActionStatus(node, 'error', capBadge(err.message));
        node.send([null, sr]);
        if (triggerMsg) {
          reportDoneError(node, new Error(`mavlink-build send: ${err.message}`), triggerMsg, done);
        } else {
          node.error(`mavlink-build send: ${err.message}`, {});
        }
        return false;
      }

      // Track achieved rate.
      const now = Date.now();
      fireCount += 1;
      rateWindowCount += 1;
      if (now - rateWindowStart >= 1000) {
        rateWindowStart = now;
        rateWindowCount = 1;
      }
      lastFireMs = now;

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

      const rateLabel = repeatMs > 0
        ? capBadge(`${messageName} ${rateWindowCount}/${Math.round(1000 / repeatMs)}Hz`)
        : capBadge(messageName);
      applyActionStatus(node, 'ok', rateLabel);
      node.send([outMsg, sr]);
      return true;
    }

    // Input handler.
    node.on('input', (msg, _send, done) => {
      if (shouldSuppress(msg)) {
        if (done) done();
        return;
      }

      if (execute(msg, done) && done) done();
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
      void fireCount;
      void lastFireMs;
      done();
    });
  }

  /**
   * Admin endpoint for the Build editor's message dropdown (§6). Registered
   * once per process and isolated from metadata-load failures so the palette
   * node still registers when `mavlink-mappings` is absent.
   */
  if (!messagesRouteRegistered) {
    let catalogApi = null;
    let catalogLoadError = null;
    try {
      catalogApi = require('../lib/metadata');
    } catch (err) {
      catalogLoadError = err;
      if (RED.log && typeof RED.log.error === 'function') {
        RED.log.error(`[mavlink-build] message catalog unavailable: ${err.message}`);
      }
    }

    RED.httpAdmin.get(
      '/mavlink/build/messages',
      RED.auth.needsPermission('mavlink.read'),
      (req, res) => {
        if (!catalogApi) {
          return res.status(503).json({
            error: catalogLoadError
              ? catalogLoadError.message
              : 'message catalog unavailable',
          });
        }
        const {
          listMessagesCatalog,
          catalogMessagesFromBundle,
          knownDialects,
        } = catalogApi;
        try {
          const vehicleId = typeof req.query.vehicle === 'string'
            ? req.query.vehicle.trim()
            : '';
          const requested = typeof req.query.dialect === 'string' && req.query.dialect.trim()
            ? req.query.dialect.trim()
            : '';

          if (vehicleId) {
            const vehicleNode = RED.nodes.getNode(vehicleId);
            if (vehicleNode && typeof vehicleNode.getDialect === 'function') {
              const bundle = vehicleNode.getDialect();
              const dialect = vehicleNode.dialect || bundle.dialect || 'custom';
              return res.json(catalogMessagesFromBundle(bundle, dialect));
            }
            if (!requested || requested === 'custom') {
              return res.status(404).json({
                error: 'Vehicle Profile not found or not deployed; Deploy the flow, or pass a bundled ?dialect=',
                dialects: knownDialects(),
              });
            }
            return res.json(listMessagesCatalog(requested));
          }

          if (!requested) {
            return res.status(400).json({
              error: 'dialect is required',
              dialects: knownDialects(),
            });
          }
          if (requested === 'custom') {
            return res.status(400).json({
              error: 'custom dialect requires a deployed Vehicle Profile (?vehicle=id)',
              dialects: knownDialects(),
            });
          }
          res.json(listMessagesCatalog(requested));
        } catch (err) {
          res.status(400).json({
            error: err.message,
            dialects: catalogApi.knownDialects(),
          });
        }
      }
    );

    messagesRouteRegistered = true;
  }

  RED.nodes.registerType('mavlink-build', MavlinkBuildNode);
};
