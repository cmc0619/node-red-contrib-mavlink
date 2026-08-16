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
const {
  TIER,
  makeStatusRecord,
  shouldSuppress,
  applyActionStatus,
} = require('../lib/delivery');
const { resolveBand } = require('../lib/connection/bands');
const { dialectFromVehicleId, dialectFromConnection, applyConnectionStatus } = require('../lib/addressing');
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
    const connectionNode = RED.nodes.getNode(config.connection);

    // The operator's tier, as configured. A missing Connection does not mean
    // they chose Build — silently rewriting a chosen Send into a Build emits a
    // constructed message on output 0 and reports success for something that
    // was never transmitted, which is the degrade §9 forbids everywhere else.
    // A Send with no Connection is a misconfiguration; it says so at deploy and
    // fails loud per message. Membership is judged per-run (§14 selection-typo
    // cluster, the Move/Mission shape): `tier === TIER.BUILD` was the only
    // gate, so an unknown token — a typo'd hand-edit of 'build' included —
    // fell through to the Send side and put a real frame on the wire the
    // operator asked only to construct. Blank throws too: the editor's select
    // has no blank option. Known-ness is computed once here because the
    // repeat timer must also read it: refusing per-run stops the wire, but an
    // autonomous tick against a dead tier would flood output 1 with the
    // refusal at the configured rate (Gitar, #310) — the exact behavior the
    // timer's messageMeta guard already promises to avoid.
    const tier = config.tier;
    const tierKnown = tier === TIER.BUILD || tier === TIER.SEND;

    // No `|| 'HEARTBEAT'`: an absent name leaves messageMeta null, which
    // badges the node invalid at deploy and fails loud on input. Building a
    // heartbeat nobody asked for is the phantom §9 forbids (#222).
    const messageName = config.messageName;
    // The editor owns the default ('2' = Control) — just convert it.
    const defaultBand = Number(config.band);

    // Default field values from node config. The editor validates this, so the
    // runtime just reads it.
    const configFields = JSON.parse(config.fields || '{}');

    // Repeat interval.
    const repeatMs = Number(config.repeatMs);
    let repeatTimer = null;
    let rateWindowStart = 0;
    let rateWindowCount = 0;

    // Last unknown-key set warned, for per-streak dedup (the Move node's
    // lastAdvisory pattern): a repeat timer or stream feed re-presenting the
    // same typo would spam the debug sidebar, and noise gets ignored.
    let lastWarnedKeys = null;

    // Resolve the dialect bundle per the role × tier matrix (§6).
    //   Build + plain dialect name → load from the bundled registry (no vehicle needed).
    //   Build + '__vehicle' → vehicle node's bundle.
    //   Wire tier → the connection's bound profile node's bundle (custom-safe).
    // Null when any rung fails to resolve — badged below, refused per message.
    /** @type {import('../lib/metadata').DialectBundle|null} */
    let bundle;
    if (tier === TIER.BUILD) {
      if (config.dialect === '__vehicle') {
        bundle = dialectFromVehicleId(RED, config.vehicle);
      } else {
        const { api } = loadMetadata('mavlink-build', RED);
        bundle = api ? api.loadBundled(config.dialect) : null;
      }
    } else {
      bundle = dialectFromConnection(RED, connectionNode);
    }
    const messageMeta = bundle ? bundle.messages[messageName] : null;

    // §6 (ruled 2026-08-12): config validity is the editor's verdict — Node-RED
    // draws that as a red triangle on the node body, and the status line is for
    // external verdicts only. A wire tier whose Connection did not resolve is
    // one of those: no transport, the same badge every other sender publishes.
    applyConnectionStatus(node, tier !== TIER.BUILD, connectionNode);

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
      /**
       * Terminal failure for this execution: badge, status record, and the
       * routed error — done(err) for a triggered run, node.error for a timer
       * run, which has no done. Always returns false so callers can
       * tail-return it.
       */
      function failRun(err, extra = {}) {
        applyActionStatus(node, 'error', err.message);
        node.send([null, makeStatusRecord({
          node: node.type,
          result: 'failed',
          detail: err.message,
          message: messageName,
          timestamp: Date.now(),
          ...extra,
        })]);
        if (triggerMsg) {
          done(new Error(`mavlink-build: ${err.message}`));
        } else {
          node.error(`mavlink-build: ${err.message}`, {});
        }
        return false;
      }

      // A tier the `tier` select cannot save (RED.mavlink.oneOf,
      // mavlink-build.html) matches neither arm below, so nothing is emitted
      // and nothing is sent. `tierKnown` gates the repeat timer for the same
      // reason: an unresolved tier must not arm a loop that does nothing.
      if (!tierKnown) return false;

      if (!messageMeta) {
        return failRun(new Error('dialect or message unresolved — fix the node config and redeploy'));
      }

      // Merge config defaults with any per-message overrides from the trigger.
      const overrides =
        triggerMsg &&
        triggerMsg.payload !== null &&
        typeof triggerMsg.payload === 'object' &&
        !Array.isArray(triggerMsg.payload)
          ? triggerMsg.payload
          : {};
      const rawFields = { ...configFields, ...overrides };

      // Advisory, not refusal (#262): encodeMessage walks the dialect's field
      // list, so a key it does not name is silently dropped — which hid typos
      // (a misspelled field built a message missing it and reported success).
      // Refusing would be wrong too: dialect lag is a real scenario — a flow
      // written against a newer dialect than the one deployed should still
      // build what it can. rawFields carries field values only (band, target
      // and identityId ride the msg, not the payload), so every unknown key
      // is worth naming.
      const known = new Set(messageMeta.fields.map((f) => f.name));
      const unknown = Object.keys(rawFields).filter((key) => !known.has(key));
      if (unknown.length > 0) {
        // Sorted, because the dedup key must identify the *set*: Object.keys
        // follows insertion order, so the same two misspellings arriving in
        // the other order would read as a new set and warn again.
        const warnedKeys = unknown.slice().sort().join(', ');
        if (warnedKeys !== lastWarnedKeys) {
          node.warn(`mavlink-build: ${messageName} has no field ${warnedKeys} — ignored`);
        }
        lastWarnedKeys = warnedKeys;
      } else {
        lastWarnedKeys = null;
      }

      // Encode: apply the field codec to produce wire-ready values.
      let encodedFields;
      try {
        encodedFields = encodeMessage(messageMeta, rawFields, { enums: bundle.enums });
      } catch (err) {
        return failRun(new Error(`encode: ${err.message}`));
      }

      const builtMessage = { name: messageName, fields: encodedFields };

      switch (tier) {
      case TIER.BUILD: {
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
      }

      // Send tier: enqueue on the connection queue. Band membership is the
      // shared `resolveBand` — the twin of mavlink-out's site §14 flagged
      // ("the identical Number() coercion... not yet fixed"): `Number('')` is
      // 0, BAND.EMERGENCY, so a blank msg.band silently outranked every other
      // message on the link. Absent msg.band still falls back to the config
      // default the operator chose.
      let band;
      try {
        band = resolveBand(triggerMsg ? triggerMsg.band : undefined, defaultBand);
      } catch (err) {
        return failRun(err, { tier: TIER.SEND });
      }
      const target = (triggerMsg && triggerMsg.target) || null;
      const identityId = (triggerMsg && triggerMsg.identityId) || undefined;

      // The queue send can throw synchronously (full Control band, unknown
      // identity, disabled connection). A Send with no Connection never gets
      // here — its dialect resolves *through* the Connection, so it was
      // already refused above as unresolved config.
      try {
        connectionNode.send(builtMessage, { band, target, identityId });
      } catch (err) {
        return failRun(new Error(`send: ${err.message}`), { tier: TIER.SEND, band });
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

    // Repeat timer. Never armed for a config that already badged invalid —
    // an autonomous tick against a dead config would flood output 1 and every
    // Catch flow at the configured rate with the refusal the badge already
    // reports. Manual triggers still fail loudly through the input handler.
    if (repeatMs > 0 && messageMeta && tierKnown) {
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
