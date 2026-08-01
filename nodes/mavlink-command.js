'use strict';

/**
 * mavlink-command — palette node (DESIGN.md §3, §9, §12 step 6).
 *
 * Sends MAV_CMD commands via the two-output chain model (§9):
 *   output 0 = continue  (fires only on success)
 *   output 1 = status    (fires on every terminal outcome)
 *
 * Two entry modes:
 *   preset   — one of the named presets from §9 with pinned params and a
 *              friendly name; the form reshapes for the chosen preset.
 *   advanced — pick any MAV_CMD from the loaded dialect; all params exposed.
 *
 * Carrier (§9 "Coordinate frames"): the operator must pick COMMAND_INT or
 * COMMAND_LONG in the node config — a required field, no default. Positional
 * params are always entered in decimal degrees; the INT carrier scales them to
 * degE7 on the wire. A wrong-carrier ack still triggers the one-shot auto
 * resend in the other form (§9 "resend in the other form").
 *
 * Delivery tiers (§9 "Delivery tiers"):
 *   build    — construct the selected carrier message and emit on output 0;
 *              no send.
 *   send     — fire-and-forget; no acknowledgement waiting.
 *   confirm  — wait for COMMAND_ACK, handle retry/backoff for
 *              TEMPORARILY_REJECTED; timeout triggers peer-table check.
 *   complete — after ACCEPTED, poll peer table until completion condition met.
 *              Only offered for commands that have a completion condition (§9).
 *
 * Guard the input:
 *   msg.payload === false → suppress (§9 "What triggers an action node")
 */

const {
  makeStatusRecord,
  MAV_RESULT,
  RESULT_NAME,
  getPreset,
  buildParamArray,
  mergeParams,
  AckWaiter,
  checkCompletion,
  waitForCompletion,
  buildCommandLong,
  buildCommandInt,
  CARRIER,
  intCoordKinds,
  resolveFrame,
} = require('../lib/command');

/**
 * Lazy, failure-tolerant metadata access (§6): the palette must register even
 * when `mavlink-mappings` is missing, so the bundled-dialect lookup for
 * coordKinds degrades to null (historical scaling) instead of throwing.
 * @returns {object|false}
 */
let _metadataApi = null;
function metadataApi() {
  if (_metadataApi !== null) return _metadataApi;
  try {
    _metadataApi = require('../lib/metadata');
  } catch {
    _metadataApi = false;
  }
  return _metadataApi;
}

const {
  resolveActionTarget,
  profileFromVehicleNode,
} = require('../lib/addressing');

const {
  shouldSuppress,
} = require('../lib/delivery');

/** Band constant for outbound commands (CONTROL = 2). */
const BAND_CONTROL = 2;

/** Cap badge text at 24 characters with a single-glyph ellipsis (§6). */
function badge24(text) {
  if (text.length <= 24) return text;
  return text.slice(0, 23) + '\u2026';
}

/**
 * Return the command ID for the current node config (preset or advanced).
 *
 * @param {object} config  node config from editor
 * @returns {number|null}
 */
function resolveCommandId(config) {
  if (config.mode === 'advanced') {
    const id = Number(config.advancedCommand);
    return Number.isFinite(id) ? id : null;
  }
  const preset = getPreset(config.preset);
  return preset ? preset.commandId : null;
}

/**
 * Resolve the operator's required carrier choice from config, or null when it
 * is missing/invalid (§9). No default: a flow that never picked a carrier is
 * misconfigured and must red out at deploy, not silently pick a wire format.
 *
 * @param {object} config  node config from editor
 * @returns {'long'|'int'|null}
 */
function resolveCarrier(config) {
  if (config.carrier === CARRIER.INT) return CARRIER.INT;
  if (config.carrier === CARRIER.LONG) return CARRIER.LONG;
  return null;
}

/**
 * Given a wrong-carrier MAV_RESULT, return the carrier the vehicle is asking
 * for, or null when the code is not a carrier-mismatch (§9).
 *
 * @param {number} resultCode
 * @returns {'long'|'int'|null}
 */
function carrierWantedBy(resultCode) {
  if (resultCode === MAV_RESULT.COMMAND_INT_ONLY) return CARRIER.INT;
  if (resultCode === MAV_RESULT.COMMAND_LONG_ONLY) return CARRIER.LONG;
  return null;
}

module.exports = function registerMavlinkCommand(RED) {
  function MavlinkCommandNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    // Active transaction tracker — at most one in flight per node.
    let _activeWaiter = null;

    /** Validate configuration at deploy time. */
    const commandId = resolveCommandId(config);
    // Carrier is a required choice (§9): no default, so a node deployed
    // without one — including flows saved before the field existed — reds out
    // exactly like a missing command.
    const configuredCarrier = resolveCarrier(config);
    if (commandId === null || configuredCarrier === null) {
      node.status({ fill: 'red', shape: 'ring', text: 'invalid config' });
      node.on('input', (_msg, _send, done) => {
        done && done();
      });
      node.on('close', (done) => done());
      return;
    }

    const preset =
      config.mode !== 'advanced' ? getPreset(config.preset) : null;
    const commandName =
      preset ? preset.command : `MAV_CMD(${commandId})`;
    const displayName = preset ? preset.name : `#${commandId}`;
    const noAutoRetry = preset ? preset.noAutoRetry : false;
    const completionKey = preset ? preset.completionKey : null;
    const requiresConfirmation = preset ? preset.requiresConfirmation : false;

    const connNode = config.connection ? RED.nodes.getNode(config.connection) : null;

    const delivery = config.delivery;

    /**
     * How this command's param5/6 ride the INT carrier, per the dialect XML
     * (§9 "ask the XML"): scaled lat/lon, natively degE7, or raw non-location
     * values. Resolved lazily — the wire tier's vehicle bundle attaches at
     * connection start — and null (historical scaling) when no bundle exists.
     * @returns {{5: string, 6: string}|null}
     */
    let _coordKinds;
    let _coordKindsResolved = false;
    function coordKinds() {
      if (_coordKindsResolved) return _coordKinds;
      _coordKindsResolved = true;
      let bundle = null;
      if (delivery === 'build') {
        if (config.dialect === '__vehicle') {
          const vehicleNode = config.vehicle ? RED.nodes.getNode(config.vehicle) : null;
          if (vehicleNode && typeof vehicleNode.getDialect === 'function') {
            try { bundle = vehicleNode.getDialect(); } catch { bundle = null; }
          }
        } else if (config.dialect) {
          const api = metadataApi();
          if (api) {
            try { bundle = api.loadBundled(config.dialect); } catch { bundle = null; }
          }
        }
      } else if (connNode && connNode.vehicle) {
        // The connection's public vehicle snapshot deliberately carries no
        // compiled bundle — only the profile node id. Per the snapshot's own
        // contract (nodes/mavlink-connection.js): resolve the profile node
        // and call getDialect(); never loadBundled, which would break custom
        // XML profiles. (Codex review on #61 — the .bundle read was dead.)
        const profileNode = connNode.vehicle.id ? RED.nodes.getNode(connNode.vehicle.id) : null;
        if (profileNode && typeof profileNode.getDialect === 'function') {
          try { bundle = profileNode.getDialect(); } catch { bundle = null; }
        }
      }
      _coordKinds = bundle ? intCoordKinds(bundle, commandId) : null;
      return _coordKinds;
    }

    const timeoutMs = config.timeout ? Number(config.timeout) : 10000;
    const maxRetries = config.maxRetries !== undefined ? Number(config.maxRetries) : 3;
    const unconfirmedContinue = !!config.unconfirmedContinue;

    // A send/confirm/complete tier needs a Connection. When one is not bound
    // the node must not silently degrade into Build and report a phantom
    // success (§9): flag it at deploy (§6 "misconfigured at deploy") and fail
    // every trigger with a status record naming the problem.
    const needsConnection = delivery !== 'build';
    if (needsConnection && !connNode) {
      node.status({ fill: 'red', shape: 'ring', text: 'invalid config' });
    } else {
      node.status({});
    }

    /**
     * Build the 7-element param array for this send, merging config + payload.
     *
     * @param {*} payload
     * @returns {number[]}
     */
    function getParams(payload) {
      const userParams = mergeParams(config, payload);
      if (preset) {
        return buildParamArray(preset, userParams);
      }
      // Advanced: build a full 7-element array from userParams, default 0.
      return [1, 2, 3, 4, 5, 6, 7].map((i) =>
        userParams[i] !== undefined ? userParams[i] : 0
      );
    }

    /**
     * Emit a status record on output 1 and optionally on output 0.
     *
     * Output 1 receives the status record at the message root. Output 0
     * (continue) still wraps its trigger under `msg.payload`.
     *
     * @param {object} record  status record for output 1
     * @param {Function} sendFn  Node-RED send function
     * @param {boolean} continueOut  whether to also fire output 0
     * @param {*} [send0Payload]  payload for output 0 when continuing
     */
    function emitStatus(record, sendFn, continueOut, send0Payload) {
      if (continueOut) {
        sendFn([{ payload: send0Payload || record }, record]);
      } else {
        sendFn([null, record]);
      }
    }

    async function handleInput(msg, send, done) {
      // § Suppress: msg.payload === false → do nothing.
      if (shouldSuppress(msg)) {
        done && done();
        return;
      }

      const paramArray = getParams(msg.payload);
      const payloadTarget =
        (msg.payload && typeof msg.payload === 'object') ? msg.payload.target : undefined;
      const identityId =
        (msg.payload && typeof msg.payload === 'object' && msg.payload.identityId != null
          ? msg.payload.identityId
          : config.identity) || '';

      let target;
      if (delivery === 'build') {
        // Build tier: profile only for the explicit `__vehicle` dialect escape.
        const useVehicle = config.dialect === '__vehicle';
        const vehicleNode = useVehicle && config.vehicle ? RED.nodes.getNode(config.vehicle) : null;
        target = resolveActionTarget({
          payloadTarget,
          configSysid: config.targetSysid,
          configCompid: config.targetCompid,
          profile: profileFromVehicleNode(vehicleNode),
        });
      } else {
        // Wire tiers: profile comes from the bound connection's vehicle context.
        const identityNode = identityId ? RED.nodes.getNode(identityId) : null;
        target = resolveActionTarget({
          payloadTarget,
          configSysid: config.targetSysid,
          configCompid: config.targetCompid,
          identityNode,
          profile: connNode ? connNode.vehicle : null,
        });
      }

      const startMs = Date.now();

      function makeRecord(fields) {
        return makeStatusRecord({
          command: commandName,
          commandId,
          target,
          ...fields,
        });
      }

      function failDone(detail) {
        done(new Error(`mavlink-command: ${detail}`));
      }

      // ── Safety preset confirmation check ──────────────────────────────────
      // Runs before Build as well as send tiers: a built Flight Termination
      // envelope on output 0 can be forwarded straight to mavlink-out, so the
      // gate must block construction without an explicit boolean confirm
      // (§9 safety — requiresConfirmation presets).
      // Truthy tokens like the string "false" or 1 must NOT pass.
      if (requiresConfirmation && msg.confirmed !== true) {
        const rec = makeRecord({
          result: 'unconfirmed',
          confirmedBy: 'none',
          elapsed: Date.now() - startMs,
          detail: 'safety command requires msg.confirmed = true',
        });
        node.status({ fill: 'red', shape: 'ring', text: badge24(`confirm ${displayName}`) });
        emitStatus(rec, send, false);
        failDone('safety command blocked — set msg.confirmed = true');
        return;
      }

      // ── Missing connection on a send/confirm/complete tier ────────────────
      // Do not silently build and pretend success — a chosen send tier with no
      // connection is a misconfiguration (§9). Fail loud on output 1 only.
      if (delivery !== 'build' && !connNode) {
        const rec = makeRecord({
          result: 'failed',
          resultCode: null,
          confirmedBy: 'none',
          elapsed: Date.now() - startMs,
          detail: `no connection configured for ${delivery} delivery`,
        });
        node.status({ fill: 'red', shape: 'ring', text: badge24('invalid config') });
        emitStatus(rec, send, false);
        failDone(`${displayName} has no connection for ${delivery} delivery`);
        return;
      }

      // Frame for the COMMAND_INT carrier (§9 "Coordinate frames"): shared
      // precedence chain — msg.mavFrame beats node config, blank falls to the
      // carrier module's documented default (GLOBAL). Resolved here so every
      // delivery tier — build included — honours it.
      const frame = resolveFrame(msg.mavFrame, config.frame);

      /**
       * Build the wire message for a carrier at a given confirmation counter.
       * COMMAND_INT has no confirmation byte, so it is ignored there; the
       * canonical params are always degrees, scaled per carrier by the
       * carrier module (§9).
       *
       * @param {'long'|'int'} carrier
       * @param {number} confirmation
       * @returns {{name: string, fields: object}}
       */
      function buildCarrierMessage(carrier, confirmation) {
        if (carrier === CARRIER.INT) {
          return buildCommandInt(commandId, target.sysid, target.compid, paramArray, {
            frame,
            coordKinds: coordKinds() || undefined,
          });
        }
        return buildCommandLong(commandId, target.sysid, target.compid, paramArray, confirmation);
      }

      // ── Delivery: Build ───────────────────────────────────────────────────
      if (delivery === 'build') {
        const message = buildCarrierMessage(configuredCarrier, 0);
        node.status({ fill: 'yellow', shape: 'dot', text: badge24(`build ${displayName}`) });
        // Output 1 reports every terminal outcome, success included (§9); a
        // successful build emits a 'built' status record for status/debug
        // consumers, consistent with the other action nodes.
        const rec = makeRecord({
          result: 'built',
          resultCode: null,
          confirmedBy: 'none',
          elapsed: Date.now() - startMs,
          detail: 'build tier: message constructed, not sent',
        });
        emitStatus(rec, send, true, message);
        done && done();
        return;
      }

      // ── Delivery: Send (fire-and-forget) ──────────────────────────────────
      if (delivery === 'send') {
        const message = buildCarrierMessage(configuredCarrier, 0);
        node.status({ fill: 'blue', shape: 'dot', text: badge24(`sending ${displayName}\u2026`) });
        connNode.send(message, { band: BAND_CONTROL, target, identityId });
        const rec = makeRecord({ result: 'sent', confirmedBy: 'none', elapsed: 0 });
        node.status({ fill: 'green', shape: 'dot', text: badge24(`sent ${displayName}`) });
        emitStatus(rec, send, true, message);
        done && done();
        return;
      }

      // ── Delivery: Confirm / Complete ──────────────────────────────────────
      // Cancel any in-flight waiter for this node before starting a new one.
      if (_activeWaiter) {
        _activeWaiter.cancel();
        _activeWaiter = null;
      }

      node.status({ fill: 'blue', shape: 'dot', text: badge24(`${displayName}\u2026`) });

      /**
       * Run one AckWaiter transaction in the given carrier and resolve with its
       * outcome. Registers itself as the node's active waiter for cancellation.
       *
       * @param {'long'|'int'} carrier
       * @returns {Promise<object>} AckResult
       */
      async function runWaiter(carrier) {
        const waiter = new AckWaiter({
          subscribe: (filter, handler) => connNode.subscribe(filter, handler),
          sendFn: (confirmation) => {
            connNode.send(buildCarrierMessage(carrier, confirmation), { band: BAND_CONTROL, target, identityId });
          },
          commandId,
          targetSysid: target.sysid,
          targetCompid: target.compid,
          timeoutMs,
          maxRetries: noAutoRetry ? 0 : maxRetries,
          noAutoRetry,
        });
        _activeWaiter = waiter;
        try {
          return await waiter.start();
        } finally {
          if (_activeWaiter === waiter) _activeWaiter = null;
        }
      }

      // First attempt is the operator's configured carrier (§9): a required
      // choice, so the wire format is stated intent — never a guess.
      let carrier = configuredCarrier;
      let ackOutcome = await runWaiter(carrier);

      // ── Carrier auto-resend (§9 "resend in the other form") ───────────────
      // At most ONE swap per transaction. When the vehicle acks INT_ONLY (8) or
      // LONG_ONLY (7) it will only accept the other carrier: warn and resend
      // once in that form. A second wrong-carrier ack (the same code again, or
      // a contradictory one) is failed loudly — no further silent retry.
      const wanted = carrierWantedBy(ackOutcome.resultCode);
      if (wanted && wanted !== carrier) {
        const from = carrier;
        carrier = wanted;
        node.warn(
          `mavlink-command: ${displayName} rejected as ` +
            `${RESULT_NAME[ackOutcome.resultCode]} — resending as ` +
            `COMMAND_${carrier === CARRIER.INT ? 'INT' : 'LONG'} (§9 carrier swap)`
        );
        node.status({
          fill: 'blue',
          shape: 'dot',
          text: badge24(`retry ${carrier === CARRIER.INT ? 'INT' : 'LONG'} ${displayName}\u2026`),
        });
        ackOutcome = await runWaiter(carrier);

        // Second attempt is the last: a repeated wrong-carrier ack cannot be
        // resolved by another swap, so fail loud (§9 user requirement).
        if (carrierWantedBy(ackOutcome.resultCode) !== null) {
          const rec = makeRecord({
            result: RESULT_NAME[ackOutcome.resultCode],
            resultCode: ackOutcome.resultCode,
            confirmedBy: 'ack',
            retries: ackOutcome.retries,
            elapsed: Date.now() - startMs,
            detail:
              `carrier swap ${from}\u2192${carrier} still rejected as ` +
              `${RESULT_NAME[ackOutcome.resultCode]} — no carrier satisfies the vehicle`,
          });
          node.status({ fill: 'red', shape: 'ring', text: badge24(`wrong carrier ${displayName}`) });
          emitStatus(rec, send, false);
          failDone(rec.detail);
          return;
        }
      } else if (wanted) {
        // The vehicle asked for the carrier we already sent — a contradiction we
        // cannot resolve by swapping. Fail loud rather than loop (§9).
        const rec = makeRecord({
          result: RESULT_NAME[ackOutcome.resultCode],
          resultCode: ackOutcome.resultCode,
          confirmedBy: 'ack',
          retries: ackOutcome.retries,
          elapsed: Date.now() - startMs,
          detail:
            `vehicle demands COMMAND_${carrier === CARRIER.INT ? 'INT' : 'LONG'} ` +
            `but that carrier was already sent`,
        });
        node.status({ fill: 'red', shape: 'ring', text: badge24(`wrong carrier ${displayName}`) });
        emitStatus(rec, send, false);
        failDone(rec.detail);
        return;
      }

      // From here the outcome may be from either the configured or swapped
      // carrier; note a completed swap in the success/failure detail below.
      const carrierSwapped = carrier !== configuredCarrier;
      const carrierLabel = `COMMAND_${carrier === CARRIER.INT ? 'INT' : 'LONG'}`;

      // Timeout: check peer table for completion condition.
      if (ackOutcome.result === 'timeout') {
        if (completionKey && connNode.peerTable) {
          const stateCheck = checkCompletion(
            completionKey,
            paramArray,
            connNode.peerTable,
            target.sysid,
            target.compid
          );
          if (stateCheck.done) {
            // Ack was lost on the return leg; the command ran.
            const rec = makeRecord({
              result: 'accepted',
              resultCode: null,
              confirmedBy: 'state',
              retries: ackOutcome.retries,
              elapsed: Date.now() - startMs,
              detail: `ack timeout but ${stateCheck.detail}`,
            });
            node.status({ fill: 'green', shape: 'dot', text: badge24(`${displayName} accepted`) });
            emitStatus(rec, send, true, rec);
            done && done();
            return;
          }
        }

        // Genuinely unknown — report unconfirmed.
        const rec = makeRecord({
          result: 'unconfirmed',
          resultCode: null,
          confirmedBy: 'none',
          retries: ackOutcome.retries,
          elapsed: Date.now() - startMs,
          detail: ackOutcome.detail,
        });
        node.status({ fill: 'red', shape: 'ring', text: badge24(`timeout ${displayName}`) });
        const cont = unconfirmedContinue;
        emitStatus(rec, send, cont, cont ? rec : undefined);
        failDone(`${displayName} timed out`);
        return;
      }

      // Terminal ack result.
      if (ackOutcome.result === 'accepted') {
        // ── Complete tier: poll peer table for actual completion. ──────────
        if (delivery === 'complete' && completionKey && connNode.peerTable) {
          node.status({ fill: 'blue', shape: 'dot', text: badge24(`${displayName} climbing\u2026`) });
          const compOutcome = await waitForCompletion({
            completionKey,
            params: paramArray,
            peerTable: connNode.peerTable,
            sysid: target.sysid,
            compid: target.compid,
            timeoutMs: config.completionTimeout ? Number(config.completionTimeout) : 60000,
          });

          if (compOutcome.success) {
            const rec = makeRecord({
              result: 'accepted',
              resultCode: MAV_RESULT.ACCEPTED,
              confirmedBy: 'state',
              retries: ackOutcome.retries,
              elapsed: Date.now() - startMs,
              detail: compOutcome.detail,
            });
            node.status({ fill: 'green', shape: 'dot', text: badge24(`${displayName} done`) });
            emitStatus(rec, send, true, rec);
          } else {
            const rec = makeRecord({
              result: 'timeout',
              resultCode: null,
              confirmedBy: 'none',
              retries: ackOutcome.retries,
              elapsed: Date.now() - startMs,
              detail: compOutcome.detail,
            });
            node.status({ fill: 'red', shape: 'ring', text: badge24(`${displayName} timeout`) });
            emitStatus(rec, send, false);
            failDone(`${displayName} completion timeout`);
            return;
          }
          done && done();
          return;
        }

        // Confirm tier or complete tier with no condition: accepted is complete.
        const rec = makeRecord({
          result: 'accepted',
          resultCode: MAV_RESULT.ACCEPTED,
          confirmedBy: 'ack',
          retries: ackOutcome.retries,
          elapsed: Date.now() - startMs,
          detail: carrierSwapped ? `accepted after ${carrierLabel} carrier swap (§9)` : null,
        });
        node.status({ fill: 'green', shape: 'dot', text: badge24(`${displayName} accepted`) });
        emitStatus(rec, send, true, rec);
        done && done();
        return;
      }

      // Any other terminal failure.
      const rec = makeRecord({
        result: ackOutcome.result,
        resultCode: ackOutcome.resultCode,
        confirmedBy: ackOutcome.confirmedBy,
        retries: ackOutcome.retries,
        elapsed: Date.now() - startMs,
        detail: carrierSwapped
          ? `${ackOutcome.detail || RESULT_NAME[ackOutcome.resultCode] || 'failed'} (after ${carrierLabel} carrier swap, §9)`
          : ackOutcome.detail,
      });
      node.status({ fill: 'red', shape: 'ring', text: badge24(`${displayName} ${ackOutcome.result}`) });
      emitStatus(rec, send, false);
      failDone(`${displayName} ${ackOutcome.result}`);
    }

    // Wrap the async handler so any throw or rejection becomes a terminal
    // status record on output 1 and one Catch-compatible error report.
    // Node-RED does not await async input handlers, so an uncaught rejection
    // would otherwise crash the process or silently drop the flow.
    node.on('input', (msg, send, done) => {
      Promise.resolve()
        .then(() => handleInput(msg, send, done))
        .catch((err) => {
          const rec = makeStatusRecord({
            result: 'failed',
            resultCode: null,
            confirmedBy: 'none',
            command: commandName,
            commandId,
            detail: `command handler error: ${err && err.message ? err.message : String(err)}`,
          });
          node.status({ fill: 'red', shape: 'ring', text: badge24(`error ${displayName}`) });
          try {
            send([null, rec]);
          } catch {
            /* send may be unavailable if the runtime already tore down */
          }
          done(err);
        });
    });

    node.on('close', (done) => {
      if (_activeWaiter) {
        _activeWaiter.cancel();
        _activeWaiter = null;
      }
      done();
    });
  }

  /**
   * Admin endpoints for editor dropdowns (§6 "Register with needsPermission").
   * Registered once per process. Metadata load is isolated so a missing
   * `mavlink-mappings` install still registers the palette type (flows can
   * open); the catalog routes then return 503 until deps are installed.
   */
  if (!MavlinkCommandNode._routeRegistered) {
    const { presetGroups } = require('../lib/command');
    let catalogApi = null;
    let catalogLoadError = null;
    try {
      catalogApi = require('../lib/metadata');
    } catch (err) {
      catalogLoadError = err;
      if (RED.log && typeof RED.log.error === 'function') {
        RED.log.error(`[mavlink-command] catalog unavailable: ${err.message}`);
      }
    }

    RED.httpAdmin.get(
      '/mavlink/command/presets',
      RED.auth.needsPermission('mavlink.read'),
      (_req, res) => {
        res.json({ groups: presetGroups() });
      }
    );

    /**
     * Advanced-mode catalog: every MAV_CMD plus param specs and the enum
     * tables those params reference (§6 / §9).
     *
     * Prefer `?vehicle=<id>` so a custom Vehicle Profile's compiled bundle is
     * used when the config node is deployed. Otherwise `?dialect=` must be an
     * allow-listed bundled name (never a filesystem path).
     */
    RED.httpAdmin.get(
      '/mavlink/command/commands',
      RED.auth.needsPermission('mavlink.read'),
      (req, res) => {
        if (!catalogApi) {
          return res.status(503).json({
            error: catalogLoadError
              ? catalogLoadError.message
              : 'command catalog unavailable',
          });
        }
        const {
          listCommandsCatalog,
          catalogFromBundle,
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
            // Treat the id as an opaque key into the live node table — never as
            // a path segment (§6 editor endpoints).
            const vehicleNode = RED.nodes.getNode(vehicleId);
            if (vehicleNode && typeof vehicleNode.getDialect === 'function') {
              const bundle = vehicleNode.getDialect();
              const dialect = (vehicleNode.dialect || bundle.dialect || 'custom');
              return res.json(catalogFromBundle(bundle, dialect));
            }
            // Referenced profile is not deployed. Serve a bundled dialect only
            // when the editor also names an allow-listed one — never invent
            // ardupilotmega under a vehicle: key (wrong commands would cache).
            if (!requested || requested === 'custom') {
              return res.status(404).json({
                error: 'Vehicle Profile not found or not deployed; Deploy the flow, or pass a bundled ?dialect=',
                dialects: knownDialects(),
              });
            }
            return res.json(listCommandsCatalog(requested));
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
          res.json(listCommandsCatalog(requested));
        } catch (err) {
          res.status(400).json({
            error: err.message,
            dialects: catalogApi.knownDialects(),
          });
        }
      }
    );

    MavlinkCommandNode._routeRegistered = true;
  }

  RED.nodes.registerType('mavlink-command', MavlinkCommandNode);
};
