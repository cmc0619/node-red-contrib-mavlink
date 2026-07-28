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
 * Delivery tiers (§9 "Delivery tiers"):
 *   build    — construct COMMAND_LONG and emit on output 0; no send.
 *   send     — fire-and-forget; no acknowledgement waiting.
 *   confirm  — wait for COMMAND_ACK, handle retry/backoff for
 *              TEMPORARILY_REJECTED; timeout triggers peer-table check.
 *   complete — after ACCEPTED, poll peer table until completion condition met.
 *              Only offered for commands that have a completion condition (§9).
 *
 * Guard the input:
 *   msg.payload === false → suppress (§9 "What triggers an action node")
 *   isStatusRecord(msg)  → emit miswire on output 1, do not act (§9)
 */

const {
  makeStatusRecord,
  isStatusRecord,
  MAV_RESULT,
  RESULT_NAME,
  getPreset,
  buildParamArray,
  AckWaiter,
  checkCompletion,
  waitForCompletion,
  buildCommandLong,
  buildCommandInt,
} = require('../lib/command');

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
 * Resolve the target (sysid, compid) from config and connection vehicle
 * defaults.
 *
 * @param {object} config
 * @param {object} connNode  Connection config node
 * @returns {{sysid: number, compid: number}}
 */
function resolveTarget(config, connNode) {
  const sysid =
    config.targetSysid && Number(config.targetSysid) > 0
      ? Number(config.targetSysid)
      : connNode.connection.peerTable._opts && connNode.connection._vehicle
        ? connNode.connection._vehicle.targetSysid
        : 1;
  const compid =
    config.targetCompid && Number(config.targetCompid) > 0
      ? Number(config.targetCompid)
      : connNode.connection._vehicle
        ? connNode.connection._vehicle.targetCompid
        : 1;
  return { sysid, compid };
}

/**
 * Merge node-configured params with any override in msg.payload.
 *
 * If msg.payload is a plain object with numeric string keys, those values
 * override the configured params for the same indices.
 *
 * @param {object} config
 * @param {*} payload
 * @returns {Object<number, number>}  index (1–7) → value
 */
function mergeParams(config, payload) {
  let base = {};
  try {
    if (config.params) base = JSON.parse(config.params);
  } catch { /* invalid saved JSON → start from empty */ }

  if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
    for (const [k, v] of Object.entries(payload)) {
      const idx = Number(k);
      if (Number.isInteger(idx) && idx >= 1 && idx <= 7) {
        base[idx] = Number(v);
      }
    }
  }
  return base;
}

/**
 * Carrier forms a command may be sent in (§9 "resend in the other form").
 * @enum {string}
 */
const CARRIER = { LONG: 'long', INT: 'int' };

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
    if (commandId === null) {
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

    const delivery = config.delivery || 'confirm';
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
      /** Show idle badge once after a reasonable delay. */
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
     * The status record is emitted as the top-level message on output 1 (its
     * own marker at the message root), matching how `mavlink-out` and
     * `mavlink-build` emit records via `lib/delivery`. This keeps the shared
     * marker on the object that `isStatusRecord(msg)` inspects, so wiring
     * output 1 back into any action node's input is refused as a miswire
     * rather than executed (§9 "A status record is refused").
     *
     * Output 0 (continue) still wraps its trigger under `msg.payload`.
     *
     * @param {object} record  status record carrying the delivery marker
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
      if (msg.payload === false) {
        done && done();
        return;
      }

      // § Miswire guard: refuse a status record.
      if (isStatusRecord(msg)) {
        const miswire = makeStatusRecord({
          result: 'miswire',
          resultCode: null,
          confirmedBy: 'none',
          command: commandName,
          commandId,
          detail: 'input is a status record — check wiring (output 1 must not feed input)',
        });
        node.status({ fill: 'red', shape: 'ring', text: badge24('miswire') });
        node.error('mavlink-command: received a status record on input (miswire)', msg);
        emitStatus(miswire, send, false);
        done && done();
        return;
      }

      const paramArray = getParams(msg.payload);
      const target = connNode ? resolveTarget(config, connNode) : { sysid: 1, compid: 1 };
      const startMs = Date.now();

      function makeRecord(fields) {
        return makeStatusRecord({
          command: commandName,
          commandId,
          target,
          ...fields,
        });
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
        node.error('mavlink-command: safety command blocked — set msg.confirmed = true', msg);
        emitStatus(rec, send, false);
        done && done();
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
        node.error(`mavlink-command: ${displayName} has no connection for ${delivery} delivery`, msg);
        emitStatus(rec, send, false);
        done && done();
        return;
      }

      // ── Delivery: Build ───────────────────────────────────────────────────
      if (delivery === 'build') {
        const message = buildCommandLong(
          commandId,
          target.sysid,
          target.compid,
          paramArray,
          0
        );
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
        const message = buildCommandLong(
          commandId,
          target.sysid,
          target.compid,
          paramArray,
          0
        );
        node.status({ fill: 'blue', shape: 'dot', text: badge24(`sending ${displayName}\u2026`) });
        connNode.send(message, { band: BAND_CONTROL, target });
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

      // Frame for a COMMAND_INT resend (§9 "Coordinate frames"). The vehicle
      // needs the right MAV_FRAME to read x/y/z; prefer a per-message override,
      // then node config, else the carrier module's documented default (GLOBAL).
      const frame =
        msg.mavFrame !== undefined && msg.mavFrame !== null && msg.mavFrame !== ''
          ? Number(msg.mavFrame)
          : config.frame !== undefined && config.frame !== null && config.frame !== ''
            ? Number(config.frame)
            : undefined;

      /**
       * Build the wire message for a carrier at a given confirmation counter.
       * COMMAND_INT has no confirmation byte, so it is ignored there; the
       * params are converted from the LONG form by the carrier module (§9).
       *
       * @param {'long'|'int'} carrier
       * @param {number} confirmation
       * @returns {{name: string, fields: object}}
       */
      function buildCarrierMessage(carrier, confirmation) {
        if (carrier === CARRIER.INT) {
          return buildCommandInt(commandId, target.sysid, target.compid, paramArray, { frame });
        }
        return buildCommandLong(commandId, target.sysid, target.compid, paramArray, confirmation);
      }

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
            connNode.send(buildCarrierMessage(carrier, confirmation), { band: BAND_CONTROL, target });
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

      // First attempt is always COMMAND_LONG (§9 default carrier).
      let carrier = CARRIER.LONG;
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
          node.error(`mavlink-command: ${rec.detail}`, msg);
          emitStatus(rec, send, false);
          done && done();
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
        node.error(`mavlink-command: ${rec.detail}`, msg);
        emitStatus(rec, send, false);
        done && done();
        return;
      }

      // From here the outcome may be from either the original or swapped
      // carrier; note a completed swap in the success/failure detail below.
      const carrierSwapped = carrier !== CARRIER.LONG;

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
        node.error(`mavlink-command: ${displayName} timed out`, msg);
        const cont = unconfirmedContinue;
        emitStatus(rec, send, cont, cont ? rec : undefined);
        done && done();
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
            node.error(`mavlink-command: ${displayName} completion timeout`, msg);
            emitStatus(rec, send, false);
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
          detail: carrierSwapped ? 'accepted after COMMAND_INT carrier swap (§9)' : null,
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
          ? `${ackOutcome.detail || RESULT_NAME[ackOutcome.resultCode] || 'failed'} (after COMMAND_INT carrier swap, §9)`
          : ackOutcome.detail,
      });
      node.status({ fill: 'red', shape: 'ring', text: badge24(`${displayName} ${ackOutcome.result}`) });
      node.error(`mavlink-command: ${displayName} ${ackOutcome.result}`, msg);
      emitStatus(rec, send, false);
      done && done();
    }

    // Wrap the async handler so any throw or rejection becomes a terminal
    // status record on output 1 plus done(err), never an unhandled promise
    // rejection. Node-RED does not await async input handlers, so an uncaught
    // rejection would otherwise crash the process or silently drop the flow.
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
          node.error(err, msg);
          if (done) done(err);
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

          const dialect = requested || 'ardupilotmega';
          if (dialect === 'custom') {
            return res.status(400).json({
              error: 'custom dialect requires a deployed Vehicle Profile (?vehicle=id)',
              dialects: knownDialects(),
            });
          }
          res.json(listCommandsCatalog(dialect));
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
