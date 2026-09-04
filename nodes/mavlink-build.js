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
 * Field values are raw wire values — the numbers `mavlink-in` emits and the
 * editor saves. The one shape JSON cannot carry is a 64-bit integer, so a
 * string on a `uint64_t`/`int64_t` field is read as the BigInt the writer takes.
 *
 * **Delivery tiers** (§9):
 *   - Build  (always available): merge fields, emit the message on output 0;
 *     the downstream can inspect, modify, or forward to `mavlink-out`.
 *   - Send   (requires a Connection): merge + enqueue fire-and-forget;
 *     output 0 carries the input msg as a pass-through trigger.
 *
 * **Repeat interval**: when `repeatMs > 0` the node fires independently of
 * inbound triggers at the configured interval; the status badge names the
 * configured rate.
 *
 * Chain model (§9):
 *   output 0  — continue: built message (Build tier) or pass-through (Send)
 *   output 1  — status:   fires on every terminal outcome
 *
 * Suppression (§9):
 *   `msg.payload === false`   → silent suppress; neither output fires
 */

const {
  makeStatusRecord,
  shouldSuppress,
  applyActionStatus,
} = require('../lib/delivery');
const { dialectForTier } = require('../lib/addressing/dialect');
const { catalogMessagesFromBundle, listMessagesCatalog } = require('../lib/metadata/messages-list');
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
    const connectionNode = RED.nodes.getNode(config.connection);

    const tier = config.tier;

    // No `|| 'HEARTBEAT'`: an absent name leaves messageMeta null, and the
    // fields read below throws at deploy. Building a heartbeat nobody asked
    // for is the phantom §9 forbids (#222).
    const messageName = config.messageName;
    // The editor owns the default ('2' = Control) — just convert it.
    const defaultBand = Number(config.band);

    // Default field values from node config. The editor validates this and
    // blesses blank ("no config-level defaults"); the blank branch spells that
    // one state. An absent key is not blank — it craters here, blaming the
    // malformed flow (§0).
    const configFields = config.fields.trim() ? JSON.parse(config.fields) : {};

    // Repeat interval.
    const repeatMs = Number(config.repeatMs);
    let repeatTimer = null;

    /** @type {import('../lib/metadata/compile').DialectBundle} */
    const bundle = dialectForTier(RED, tier, config, connectionNode);
    const messageMeta = bundle.messages[messageName];
    const bigIntFields = messageMeta.fields
      .filter((f) => f.type === 'uint64_t' || f.type === 'int64_t')
      .map((f) => f.name);

    /**
     * Core action: merge fields and emit based on the tier.
     *
     * @param {object|null} triggerMsg  the inbound Node-RED msg, or null when
     *   fired from the repeat timer
     * @param {Function|undefined} send  input-handler send callback, when this
     *   execution came from an inbound message
     * @param {Function|undefined} done  input-handler done callback, when this
     *   execution came from an inbound message
     * @returns {boolean} true when execution completed successfully
     */
    function execute(triggerMsg, send, done) {
      const emit = triggerMsg ? send : node.send.bind(node);
      /**
       * Terminal failure for this execution: badge, status record, and the
       * routed error — done(err) for a triggered run, node.error for a timer
       * run, which has no done. Always returns false so callers can
       * tail-return it.
       */
      function failRun(err, extra = {}) {
        applyActionStatus(node, 'error', err.message);
        emit([null, makeStatusRecord(node.type, {
          result: 'failed',
          detail: err.message,
          message: messageName,
          ...extra,
        })]);
        if (triggerMsg) {
          done(new Error(`mavlink-build: ${err.message}`));
        } else {
          node.error(`mavlink-build: ${err.message}`, {});
        }
        return false;
      }

      // Merge config defaults with any per-message overrides from the trigger.
      const overrides = triggerMsg ? triggerMsg.payload : {};
      const fields = { ...configFields, ...overrides };
      try {
        for (const name of bigIntFields) {
          if (typeof fields[name] === 'string') fields[name] = BigInt(fields[name]);
        }
      } catch (err) {
        // BigInt's own refusal of a string it cannot read, on the run's error
        // path: a repeat-timer run has no input handler above it to catch it.
        return failRun(err);
      }

      const builtMessage = { name: messageName, fields };

      switch (tier) {
        case 'build': {
          const outMsg = triggerMsg ? { ...triggerMsg } : {};
          outMsg.payload = { message: builtMessage, messageName, tier: 'build' };
          const sr = makeStatusRecord(node.type, {
            result: 'built',
            message: messageName,
            tier: 'build',
          });
          applyActionStatus(node, 'ok', messageName);
          emit([outMsg, sr]);
          return true;
        }
        case 'send': {
          const band = triggerMsg?.band === undefined ? defaultBand : triggerMsg.band;
          const target = triggerMsg?.target;
          const identityId = triggerMsg?.identityId;
          try {
            connectionNode.send(builtMessage, { band, target, identityId });
          } catch (err) {
            return failRun(new Error(`send: ${err.message}`), { tier: 'send', band });
          }

          const outMsg = triggerMsg
            ? { ...triggerMsg }
            : { payload: { result: 'sent', messageName, tier: 'send' } };
          const sr = makeStatusRecord(node.type, {
            result: 'sent',
            message: messageName,
            tier: 'send',
            band,
          });
          applyActionStatus(node, 'ok', repeatMs > 0
            ? `${messageName} ${Math.round(1000 / repeatMs)}Hz`
            : messageName);
          emit([outMsg, sr]);
          return true;
        }
        default: break; // This space intentionally left blank (§5)
      }
      if (done) done();
      return false;
    }

    // Input handler.
    node.on('input', (msg, send, done) => {
      if (shouldSuppress(msg)) {
        done();
        return;
      }

      // execute() returns false exactly on the paths where it already called
      // done(err), so a true return is the only one still owing a done().
      if (execute(msg, send, done)) done();
    });

    if (repeatMs > 0) {
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
   * once per process.
   */
  if (!messagesRouteRegistered) {
    registerDialectCatalogRoute(RED, {
      path: '/mavlink/build/messages',
      fromBundle: catalogMessagesFromBundle,
      fromDialect: listMessagesCatalog,
    });
    messagesRouteRegistered = true;
  }

  RED.nodes.registerType('mavlink-build', MavlinkBuildNode);
};
