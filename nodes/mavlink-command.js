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
 * Carrier (§9 "Coordinate frames"): the editor defaults to COMMAND_INT and
 * the operator can pick COMMAND_LONG instead. Positional params are always
 * entered in decimal degrees; the INT carrier scales them to
 * degE7 on the wire. A wrong-carrier ack still triggers the one-shot auto
 * resend in the other form (§9 "resend in the other form").
 *
 * Delivery tiers (§9 "Delivery tiers"):
 *   build    — construct the selected carrier message and emit on output 0;
 *              no send.
 *   send     — fire-and-forget; no acknowledgement waiting.
 *   confirm  — wait for COMMAND_ACK, handle retry/backoff for
 *              TEMPORARILY_REJECTED and — for presets that tolerate re-issue —
 *              bounded re-send on a silent window (#248/#249); only the final
 *              timeout triggers the peer-table check.
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
  carrierWantedBy,
  intCoordKinds,
  resolveFrame,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_RETRIES,
} = require('../lib/command');

const { DEFAULT_MAX_RESENDS } = require('../lib/command/ack');
const { loadMetadata } = require('../lib/metadata/load');
const {
  resolveDeliveryContext,
  applyConnectionStatus,
  dialectFromVehicleId,
  dialectFromConnection,
  numberOr,
} = require('../lib/addressing');
const {
  shouldSuppress,
  applyActionStatus,
  failInput,
} = require('../lib/delivery');
const { BAND } = require('../lib/connection/bands');

/** Lazy metadata for coordKinds — palette still registers when deps are missing. */
let _metadataApi;
function metadataApi() {
  if (_metadataApi !== undefined) return _metadataApi;
  _metadataApi = loadMetadata('mavlink-command').api;
  return _metadataApi;
}

/**
 * Return the command ID for the current node config (preset or advanced).
 *
 * @param {object} config  node config from editor
 * @returns {number|null}
 */
function resolveCommandId(config) {
  switch (config.mode) {
    case 'advanced':
      return Number(config.advancedCommand);
    case 'preset': {
      const preset = getPreset(config.preset);
      return preset ? preset.commandId : null;
    }
    default: break; // This space intentionally left blank (§5)
  }
  return NaN; // nothing matched: no behavior selected (§5)
}

module.exports = function registerMavlinkCommand(RED) {
  function MavlinkCommandNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    // Active transaction trackers — at most one in flight per node.
    let _activeWaiter = null;
    let _activeCompletion = null;
    // Bumped by close and by each new input: a run that resumes from its ack
    // await into a stale generation was swept before it could record its
    // completion handle, and must not start (or keep) a live wait.
    let _generation = 0;

    // The editor guarantees both (§6, ruled 2026-08-12): a node missing its
    // command or its wire message wears Node-RED's red triangle, and there is
    // no deploy-time badge or refusing input handler restating it here.
    const commandId = resolveCommandId(config);

    // Affirmative: only Preset mode reads the field, so a mode the editor
    // cannot save resolves no preset (and no command id above with it).
    const preset = config.mode === 'preset' ? getPreset(config.preset) : null;
    const commandName =
      preset ? preset.command : `MAV_CMD(${commandId})`;
    const displayName = preset ? preset.name : `#${commandId}`;
    const noAutoRetry = preset ? preset.noAutoRetry : false;
    const completionKey = preset ? preset.completionKey : null;
    const requiresConfirmation = preset ? preset.requiresConfirmation : false;

    const connNode = RED.nodes.getNode(config.connection);
    applyConnectionStatus(node, config.delivery !== 'build', connNode);

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
      let bundle = null;
      if (delivery === 'build') {
        if (config.dialect === '__vehicle') {
          bundle = dialectFromVehicleId(RED, config.vehicle, { rethrow: true });
        } else if (config.dialect) {
          const api = metadataApi();
          if (api) bundle = api.loadBundled(config.dialect);
        }
      } else {
        // Connection snapshot has no bundle — resolve the profile node (§7).
        bundle = dialectFromConnection(RED, connNode, { rethrow: true });
      }
      _coordKinds = bundle ? intCoordKinds(bundle, commandId) : null;
      _coordKindsResolved = true;
      return _coordKinds;
    }

    // Resolved per-input (below, like `resolveCarrier`) rather than here: a
    // throw at construction crashes the whole node's deploy, and a
    // hand-edited config is a per-message failure like any other resolver.
    const unconfirmedContinue = config.unconfirmedContinue;

    /**
     * Build the 7-element param array for this send, merging config + payload.
     *
     * @param {*} payload
     * @returns {number[]}
     */
    function getParams(payload) {
      const userParams = mergeParams(config, payload);
      if (preset) {
        // buildParamArray zero-fills a blank param, so a blank lat/lon becomes
        // 0,0 — a legal coordinate the vehicle will fly to. The editor is what
        // stops that being configured (mavlink-command.html `params`); on the
        // payload path it is trusted and rides (AGENTS.md, input trust).
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
        sendFn([{ payload: send0Payload }, record]);
      } else {
        sendFn([null, record]);
      }
    }

    async function handleInput(msg, send, done) {
      // § Suppress: msg.payload === false → do nothing.
      if (shouldSuppress(msg)) {
        done();
        return;
      }

      // The editor's `sendAs` select is the vocabulary (mavlink-command.html);
      // buildCarrierMessage dispatches it affirmatively.
      const configuredCarrier = config.sendAs;

      // Blank keeps the library default; the editor's number validator owns
      // the rest (§14: a finite-number check on operator input is a guardrail).
      const timeoutMs = numberOr(config.timeout, DEFAULT_TIMEOUT_MS);
      const maxRetries = numberOr(config.maxRetries, DEFAULT_MAX_RETRIES);
      // Complete's poll timeout resolves here too — before the send, not in
      // the post-ack continuation where it used to sit: by then the vehicle
      // has already accepted and begun executing the command, so a garbage
      // value refused after the fact (#309 review round). Gated on the tier
      // so a cleared value cannot red a Build/Send/Confirm node that never
      // reads it (the same liveOr rule the editors follow).
      const completionTimeoutMs = delivery === 'complete'
        ? numberOr(config.completionTimeout, 60000)
        : null;

      const payload = msg.payload ?? {};
      const { target, identityId } = resolveDeliveryContext(RED, {
        delivery,
        config,
        payload,
        connectionNode: connNode,
      });

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
        applyActionStatus(node, 'error', `confirm ${displayName}`);
        emitStatus(rec, send, false);
        failDone('safety command blocked — set msg.confirmed = true');
        return;
      }

      // Frame for the COMMAND_INT carrier (§9 "Coordinate frames"): shared
      // precedence chain — msg.mavFrame beats node config, blank falls to the
      // carrier module's documented default (GLOBAL_RELATIVE_ALT, §14). The
      // ±90/±180 degree check that used to read it here is the editor's now —
      // it is the frame the COMMAND_INT builder scales param5/6 by, nothing
      // more.
      const frame = resolveFrame(msg.mavFrame, config.frame);
      const paramArray = getParams(msg.payload);

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
        switch (carrier) {
          case CARRIER.INT:
            return buildCommandInt(commandId, target.sysid, target.compid, paramArray, {
              frame,
              coordKinds: coordKinds() || undefined,
            });
          case CARRIER.LONG:
            return buildCommandLong(commandId, target.sysid, target.compid, paramArray, confirmation);
          default: break; // This space intentionally left blank (§5)
        }
        return undefined; // nothing matched: no behavior selected (§5)
      }

      // ── Delivery ──────────────────────────────────────────────────────────
      // Build and Send finish here; Confirm and Complete share the ack waiter
      // below, where `delivery === 'complete'` adds the completion poll.
      switch (delivery) {
        case 'build': {
          const message = buildCarrierMessage(configuredCarrier, 0);
          applyActionStatus(node, 'preview', `build ${displayName}`);
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
          done();
          return;
        }
        case 'send': {
          const message = buildCarrierMessage(configuredCarrier, 0);
          applyActionStatus(node, 'sending', `sending ${displayName}\u2026`);
          connNode.send(message, { band: BAND.CONTROL, target, identityId });
          const rec = makeRecord({ result: 'sent', confirmedBy: 'none', elapsed: 0 });
          applyActionStatus(node, 'ok', `sent ${displayName}`);
          emitStatus(rec, send, true, message);
          done();
          return;
        }
        default: break; // This space intentionally left blank (§5)
      }

      // ── Delivery: Confirm / Complete ──────────────────────────────────────
      // Cancel any in-flight waiter for this node before starting a new one.
      if (_activeWaiter) {
        _activeWaiter.cancel();
        _activeWaiter = null;
      }
      if (_activeCompletion) {
        _activeCompletion.cancel();
        _activeCompletion = null;
      }
      const myGen = ++_generation;

      applyActionStatus(node, 'sending', `${displayName}\u2026`);

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
            connNode.send(buildCarrierMessage(carrier, confirmation), { band: BAND.CONTROL, target, identityId });
          },
          commandId,
          targetSystem: target.sysid,
          targetComponent: target.compid,
          // Ack attribution (§9): ignore an ack explicitly addressed to a
          // different GCS on a shared link.
          sourceIds: connNode.resolveSourceIds(identityId),
          timeoutMs,
          maxRetries: noAutoRetry ? 0 : maxRetries,
          noAutoRetry,
          // Timeout re-send is opt-in (#249). A preset that does not set
          // noAutoRetry is a curated statement that re-issuing this command is
          // safe. Advanced mode is a raw MAV_CMD id — nothing says whether a
          // second REBOOT_SHUTDOWN or MISSION_START is harmless, and a silent
          // window is the *normal* outcome for a rebooting vehicle — so it
          // passes nothing and inherits the library's no-resend default.
          maxResends: preset && !noAutoRetry ? DEFAULT_MAX_RESENDS : undefined,
          // Per-attempt telemetry on the badge only (#248) — same channel as
          // the carrier-swap retry; outputs stay terminal-only.
          onResend: (attempt, max) => {
            applyActionStatus(node, 'sending', `retrying (${attempt}/${max}) ${displayName}\u2026`);
          },
          // Same badge channel: a takeoff answers IN_PROGRESS for seconds (\u00a79),
          // and without this the operator watches an unchanging wait.
          onInProgress: (progress) => {
            applyActionStatus(
              node,
              'sending',
              progress === null
                ? `in progress ${displayName}\u2026`
                : `in progress ${progress}% ${displayName}\u2026`
            );
          },
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
        applyActionStatus(node, 'sending', `retry ${carrier === CARRIER.INT ? 'INT' : 'LONG'} ${displayName}\u2026`);
        ackOutcome = await runWaiter(carrier);

        // Second attempt is the last: a repeated wrong-carrier ack cannot be
        // resolved by another swap, so fail loud (§9 user requirement).
        if (carrierWantedBy(ackOutcome.resultCode) !== null) {
          const rec = makeRecord({
            result: RESULT_NAME[ackOutcome.resultCode],
            resultCode: ackOutcome.resultCode,
            resultParam2: ackOutcome.resultParam2,
            confirmedBy: 'ack',
            retries: ackOutcome.retries,
            elapsed: Date.now() - startMs,
            detail:
              `carrier swap ${from}\u2192${carrier} still rejected as ` +
              `${RESULT_NAME[ackOutcome.resultCode]} — no carrier satisfies the vehicle`,
          });
          applyActionStatus(node, 'error', `wrong carrier ${displayName}`);
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
          resultParam2: ackOutcome.resultParam2,
          confirmedBy: 'ack',
          retries: ackOutcome.retries,
          elapsed: Date.now() - startMs,
          detail:
            `vehicle demands COMMAND_${carrier === CARRIER.INT ? 'INT' : 'LONG'} ` +
            `but that carrier was already sent`,
        });
        applyActionStatus(node, 'error', `wrong carrier ${displayName}`);
        emitStatus(rec, send, false);
        failDone(rec.detail);
        return;
      }

      // A redeploy cancelled the wait (close() calls _activeWaiter.cancel()).
      // The node is being torn down, so finish quietly: emitting or raising
      // here would trip a Catch node wired for "command failed → failsafe" on
      // a mere deploy, which is the same rule mavlink-mission already follows.
      if (ackOutcome.result === 'cancelled') {
        done();
        return;
      }

      // From here the outcome may be from either the configured or swapped
      // carrier; note a completed swap in the success/failure detail below.
      const carrierSwapped = carrier !== configuredCarrier;
      const carrierLabel = `COMMAND_${carrier === CARRIER.INT ? 'INT' : 'LONG'}`;

      // Completion's TAKEOFF datum is frame-aware, but only COMMAND_INT carries
      // a frame on the wire — COMMAND_LONG has none. After a possible INT→LONG
      // carrier swap, the effective carrier decides whether a frame applies:
      // pass it for INT, withhold it for LONG so completion uses the relative
      // datum instead of AMSL math against a frame the vehicle never saw.
      const completionFrame = carrier === CARRIER.INT ? frame : undefined;

      // Timeout: check peer table for completion condition.
      if (ackOutcome.result === 'timeout') {
        if (completionKey && connNode.peerTable) {
          const stateCheck = checkCompletion(
            completionKey,
            paramArray,
            connNode.peerTable,
            target.sysid,
            target.compid,
            completionFrame
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
            applyActionStatus(node, 'ok', `${displayName} accepted`);
            emitStatus(rec, send, true, rec);
            done();
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
        applyActionStatus(node, 'error', `timeout ${displayName}`);
        const cont = unconfirmedContinue;
        emitStatus(rec, send, cont, cont ? rec : undefined);
        failDone(`${displayName} timed out`);
        return;
      }

      // Terminal ack result.
      if (ackOutcome.result === 'accepted') {
        // ── Complete tier: poll peer table for actual completion. ──────────
        if (delivery === 'complete' && completionKey && connNode.peerTable) {
          applyActionStatus(node, 'sending', `${displayName} climbing\u2026`);
          const completionWait = waitForCompletion({
            completionKey,
            params: paramArray,
            peerTable: connNode.peerTable,
            sysid: target.sysid,
            compid: target.compid,
            frame: completionFrame,
            timeoutMs: completionTimeoutMs,
          });
          if (myGen === _generation) {
            _activeCompletion = completionWait;
          } else {
            // The ack settled and a close or new input ran in the same
            // synchronous stack: the sweep fired before this continuation
            // could record its handle, so nothing else can cancel the wait
            // it just created — cancel it here (Codex, #236). Also keeps a
            // stale run from clobbering the newer run's handle.
            completionWait.cancel();
          }
          let compOutcome;
          try {
            compOutcome = await completionWait.promise;
          } finally {
            if (_activeCompletion === completionWait) _activeCompletion = null;
          }

          // A redeploy cancelled the wait (close() calls the completion
          // cancel), or the wait settled before any cancel could land —
          // waitForCompletion polls once at creation, so an already-satisfied
          // completion resolves synchronously and the settle-once cancel()
          // becomes a no-op (Codex, #236). Either way this run is stale:
          // finish quietly, same rule as the ack cancel above (M1).
          if (compOutcome.cancelled || myGen !== _generation) {
            done();
            return;
          }

          if (compOutcome.success) {
            const rec = makeRecord({
              result: 'accepted',
              resultCode: MAV_RESULT.ACCEPTED,
              resultParam2: ackOutcome.resultParam2,
              confirmedBy: 'state',
              retries: ackOutcome.retries,
              elapsed: Date.now() - startMs,
              detail: compOutcome.detail,
            });
            applyActionStatus(node, 'ok', `${displayName} done`);
            emitStatus(rec, send, true, rec);
          } else {
            const rec = makeRecord({
              result: 'timeout',
              resultCode: null,
              // This branch is gated on an ACCEPTED ack: the vehicle answered,
              // then the state never arrived. `null` is reserved for settles
              // with no ack at all, so the ack's field rides through here the
              // same way its retry count does (CodeRabbit).
              resultParam2: ackOutcome.resultParam2,
              confirmedBy: 'none',
              retries: ackOutcome.retries,
              elapsed: Date.now() - startMs,
              detail: compOutcome.detail,
            });
            applyActionStatus(node, 'error', `${displayName} timeout`);
            emitStatus(rec, send, false);
            failDone(`${displayName} completion timeout`);
            return;
          }
          done();
          return;
        }

        // Confirm tier or complete tier with no condition: accepted is complete.
        const rec = makeRecord({
          result: 'accepted',
          resultCode: MAV_RESULT.ACCEPTED,
          resultParam2: ackOutcome.resultParam2,
          confirmedBy: 'ack',
          retries: ackOutcome.retries,
          elapsed: Date.now() - startMs,
          detail: carrierSwapped ? `accepted after ${carrierLabel} carrier swap (§9)` : null,
        });
        applyActionStatus(node, 'ok', `${displayName} accepted`);
        emitStatus(rec, send, true, rec);
        done();
        return;
      }

      // Any other terminal failure.
      const rec = makeRecord({
        result: ackOutcome.result,
        resultCode: ackOutcome.resultCode,
        resultParam2: ackOutcome.resultParam2,
        confirmedBy: ackOutcome.confirmedBy,
        retries: ackOutcome.retries,
        elapsed: Date.now() - startMs,
        detail: carrierSwapped
          ? `${ackOutcome.detail || RESULT_NAME[ackOutcome.resultCode] || 'failed'} (after ${carrierLabel} carrier swap, §9)`
          : ackOutcome.detail,
      });
      applyActionStatus(node, 'error', `${displayName} ${ackOutcome.result}`);
      emitStatus(rec, send, false);
      failDone(`${displayName} ${ackOutcome.result}`);
    }

    // Node-RED does not await async input handlers, so an uncaught rejection
    // would otherwise crash the process — route it like every other sender.
    node.on('input', (msg, send, done) => {
      handleInput(msg, send, done).catch((err) => failInput(node, send, err, done));
    });

    node.on('close', (done) => {
      _generation += 1;
      if (_activeWaiter) {
        _activeWaiter.cancel();
        _activeWaiter = null;
      }
      if (_activeCompletion) {
        _activeCompletion.cancel();
        _activeCompletion = null;
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
    const { registerDialectCatalogRoute } = require('../lib/metadata/admin-catalog');

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
     */
    registerDialectCatalogRoute(RED, {
      path: '/mavlink/command/commands',
      logLabel: 'mavlink-command',
      unavailableMessage: 'command catalog unavailable',
      fromBundle: (api, bundle, dialect) => api.catalogFromBundle(bundle, dialect),
      fromDialect: (api, dialect) => api.listCommandsCatalog(dialect),
    });

    MavlinkCommandNode._routeRegistered = true;
  }

  RED.nodes.registerType('mavlink-command', MavlinkCommandNode);
};
