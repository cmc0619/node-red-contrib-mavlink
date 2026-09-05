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
 * degE7 on the wire. The ack, whatever it says, is the result.
 *
 * Delivery tiers (§9 "Delivery tiers"):
 *   build    — construct the selected carrier message and emit on output 0;
 *              no send.
 *   send     — fire-and-forget; no acknowledgement waiting.
 *   confirm  — wait for COMMAND_ACK; re-send on TEMPORARILY_REJECTED up to
 *              the editor's retry budget (a preset marked noAutoRetry
 *              forces 0); a silent window settles unconfirmed and triggers
 *              the peer-table check.
 *   complete — after ACCEPTED, poll peer table until completion condition met.
 *              Only offered for commands that have a completion condition (§9).
 *
 * Guard the input:
 *   msg.payload === false → suppress (§9 "What triggers an action node")
 */

const { makeStatusRecord } = require('../lib/command/status-record');
const { getPreset, presetGroups, buildParamArray } = require('../lib/command/presets');
const { mergeParams } = require('../lib/command/merge-params');
const { ackWaiterFor, ackRecordFields, cancelSlot } = require('../lib/command/ack');
const { checkCompletion, waitForCompletion } = require('../lib/command/completion');
const {
  buildCommandLong,
  buildCommandInt,
  CARRIER,
  intCoordKinds,
  resolveFrame,
} = require('../lib/command/carrier');

const {
  DO_SET_MODE,
  MODE_FLAG_CUSTOM_MODE_ENABLED,
  setModeParams,
} = require('../lib/vehicle/modes');
const { catalogFromBundle } = require('../lib/metadata/commands-list');
const { isBlank } = require('../lib/addressing/resolve');
const { dialectForTier } = require('../lib/addressing/dialect');
const { resolveDeliveryContext } = require('../lib/addressing/delivery-context');
const {
  shouldSuppress,
  applyActionStatus,
  failInput,
} = require('../lib/delivery');
const { BAND } = require('../lib/connection/bands');

/**
 * Return the command ID for the current node config, and the preset row when
 * Preset mode names one.
 *
 * @param {object} config  node config from editor
 * @returns {{commandId: number, preset: ?object}}
 */
function resolveCommand(config) {
  switch (config.mode) {
    case 'advanced':
      return { commandId: Number(config.advancedCommand), preset: null };
    case 'preset': {
      const preset = getPreset(config.preset);
      return { commandId: preset.commandId, preset };
    }
    default: break; // This space intentionally left blank (§5)
  }
  return { commandId: NaN, preset: null }; // nothing matched: no behavior selected (§5)
}

module.exports = function registerMavlinkCommand(RED) {
  function MavlinkCommandNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    // The one in-flight transaction per node — the ack wait, then on Complete
    // the completion wait that follows it (lib/command cancelSlot). The two
    // never coexist: the completion wait starts only after the ack settled.
    const slot = cancelSlot();
    // Bumped by close and by each new input: a run that resumes from its ack
    // await into a stale generation was swept before it could record its
    // completion handle, and must not start (or keep) a live wait.
    let _generation = 0;

    // The editor guarantees both (§6, ruled 2026-08-12): a node missing its
    // command or its wire message wears Node-RED's red triangle, and there is
    // no deploy-time badge or refusing input handler restating it here.
    const { commandId, preset } = resolveCommand(config);
    const commandName =
      preset ? preset.command : `MAV_CMD(${commandId})`;
    const displayName = preset ? preset.name : `#${commandId}`;
    const noAutoRetry = preset ? preset.noAutoRetry : false;
    const completionKey = preset ? preset.completionKey : null;

    const connNode = RED.nodes.getNode(config.connection);

    const delivery = config.delivery;

    /**
     * How this command's param5/6 ride the INT carrier, per the dialect XML
     * (§9 "ask the XML"): scaled lat/lon, natively degE7, or raw non-location
     * values. Resolved lazily — the wire tier's vehicle bundle attaches at
     * connection start. A dialect that cannot be loaded throws here, and that
     * throw is the input's failure (§0).
     * @returns {{5: string, 6: string}|null}
     */
    let _coordKinds;
    let _coordKindsResolved = false;
    function coordKinds() {
      if (_coordKindsResolved) return _coordKinds;
      _coordKinds = intCoordKinds(dialectForTier(RED, delivery, config, connNode), commandId);
      _coordKindsResolved = true;
      return _coordKinds;
    }

    // Read as saved; the per-input dispatch below selects on it (§5), so a
    // hand-edited token is a per-message no-op, never a throw at deploy.
    const unconfirmedContinue = config.unconfirmedContinue;

    /**
     * Mode-name resolution context for this send (lib/vehicle/modes.js
     * ModeContext). Wire tiers resolve against the addressed peer component
     * (the vehicle-published cache) plus the bound profile's firmware/family
     * and bundle; Build resolves through the Vehicle Profile escape only — a
     * concrete Build dialect has no firmware axis on this node, so shipped
     * tables cannot pick and an unmatched name rides to the NaN tail. A tier
     * the editor's delivery select cannot save composes only the firmware
     * axis (§5), so name resolution falls to that same NaN tail — and the
     * tier dispatch in handleInput sends nothing anyway.
     *
     * @param {{target: {sysid: number, compid: number}, profile: object|null}} resolution
     * @returns {import('../lib/vehicle/modes').ModeContext}
     */
    function modeContext(resolution) {
      const profile = resolution.profile || {};
      const context = {
        firmware: profile.firmware,
        vehicleFamily: profile.vehicleFamily,
        bundle: dialectForTier(RED, delivery, config, connNode),
      };
      // The wire tiers also resolve against the addressed peer component.
      switch (delivery) {
        case 'send':
        case 'confirm':
        case 'complete':
          context.component = connNode.peerTable.getComponent(
            resolution.target.sysid,
            resolution.target.compid
          );
          break;
        default: break; // This space intentionally left blank (§5)
      }
      return context;
    }

    /**
     * Fold a payload `mode` name into DO_SET_MODE's params through the
     * mode-name ladder. Presence rules unchanged: an explicit numeric payload
     * param keeps winning over the name; the name beats configured params.
     * param1 gains MAV_MODE_FLAG_CUSTOM_MODE_ENABLED — without it the
     * autopilot ignores the custom mode (the preset's help text) — OR-ed into
     * whatever base-mode flags were already supplied. An unresolvable name is
     * NaN in param2: loud at the wire choke, never a silent mode 0.
     *
     * @param {Object<number, number>} userParams  mergeParams output, mutated
     * @param {*} payload
     * @param {object} resolution  { target, profile } from resolveDeliveryContext
     */
    function applyModeName(userParams, payload, resolution) {
      if (commandId !== DO_SET_MODE) return;
      if (isBlank(payload.mode)) return;
      const modeParams = setModeParams(payload.mode, modeContext(resolution));
      // A resolved mode is one indivisible answer, so an explicit number wins
      // over the *whole* of it, never half. PX4's answer is a pair — param2
      // main_mode, param3 sub_mode — and filling one side from the name while
      // the flow supplied the other commands a mode nobody asked for:
      // `{ mode: 'Hold', 2: 5 }` would send main 5 with Hold's sub 3, a
      // combination that maps to no mode at all and fails silently as a
      // wrong one. If any index the resolution would write is
      // already supplied, the name selects nothing — including param1's bit,
      // because a flow spelling out custom-mode numbers owns base_mode too.
      if (Object.keys(modeParams).some((idx) => !isBlank(payload[idx]))) return;
      for (const [idx, value] of Object.entries(modeParams)) {
        userParams[idx] = value;
      }
      userParams[1] |= MODE_FLAG_CUSTOM_MODE_ENABLED;
    }

    /**
     * Build the 7-element param array for this send, merging config + payload.
     *
     * @param {*} payload
     * @param {object} resolution  { target, profile } for the mode-name ladder
     * @returns {{wire: number[], requested: Array<number|undefined>}}  what
     *   transmits, and the request with its holes kept
     */
    function getParams(payload, resolution) {
      const userParams = mergeParams(config, payload);
      applyModeName(userParams, payload, resolution);
      // Two views of one request. `wire` is what transmits — zero-filled, so a
      // blank lat/lon becomes 0,0, a legal coordinate the vehicle will fly to;
      // the editor is what stops that being configured (mavlink-command.html
      // `params`), and on the payload path it is trusted and rides (AGENTS.md,
      // input trust). `requested` keeps the holes: completion verifies what
      // was asked for, and the wire filler is indistinguishable from a real 0
      // there (custom_mode 0 is ArduPilot STABILIZE).
      const requested = [1, 2, 3, 4, 5, 6, 7].map((i) => userParams[i]);
      if (preset) {
        return { wire: buildParamArray(preset, userParams), requested };
      }
      return { wire: requested.map((v) => (v !== undefined ? v : 0)), requested };
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

      // The editor owns the defaults and the number rings.
      const timeoutMs = Number(config.timeoutMs);
      const maxRetries = Number(config.maxRetries);
      // Complete's poll timeout resolves here too, before the send: by the
      // post-ack continuation the vehicle has already begun executing the
      // command. Only the Complete tier reads it.
      const completionTimeoutMs = Number(config.completionTimeout);

      const payload = msg.payload;
      const { target, identityId, profile } = resolveDeliveryContext(RED, {
        delivery,
        config,
        payload,
        connectionNode: connNode,
      });

      const startMs = Date.now();

      /**
       * This input's status record: command, target and the elapsed time
       * since the input arrived, which an ack outcome's own measure or a
       * completion wait overrides through `fields`.
       */
      function makeRecord(fields) {
        return makeStatusRecord(node.type, {
          command: commandName,
          commandId,
          target,
          elapsed: Date.now() - startMs,
          ...fields,
        });
      }

      // Frame for the COMMAND_INT carrier (§9 "Coordinate frames"):
      // msg.mavFrame beats node config, and the editor owns the saved frame's
      // vocabulary. The ±90/±180 degree check is the editor's too; here it is
      // the frame the COMMAND_INT builder scales param5/6 by, nothing more.
      const frame = resolveFrame(msg.mavFrame, config.frame);
      const { wire: paramArray, requested: requestedParams } = getParams(payload, { target, profile });

      /**
       * Build the wire message for a carrier. The LONG carrier's confirmation
       * byte is stamped per (re-)send by the ack waiter's sendFn (lib/command
       * sendFnFor); the canonical params are always degrees, scaled per
       * carrier by the carrier module (§9).
       *
       * @param {'long'|'int'} carrier
       * @returns {{name: string, fields: object}}
       */
      function buildCarrierMessage(carrier) {
        switch (carrier) {
          case CARRIER.INT:
            return buildCommandInt(commandId, target.sysid, target.compid, paramArray, {
              frame,
              coordKinds: coordKinds() || undefined,
            });
          case CARRIER.LONG:
            return buildCommandLong(commandId, target.sysid, target.compid, paramArray, 0);
          default: break; // This space intentionally left blank (§5)
        }
        return undefined; // nothing matched: no behavior selected (§5)
      }

      // ── Delivery ──────────────────────────────────────────────────────────
      // Build and Send finish here; Confirm and Complete share the ack waiter
      // below, where `delivery === 'complete'` adds the completion poll.
      switch (delivery) {
        case 'build': {
          const message = buildCarrierMessage(configuredCarrier);
          applyActionStatus(node, 'preview', `build ${displayName}`);
          // Output 1 reports every terminal outcome, success included (§9); a
          // successful build emits a 'built' status record for status/debug
          // consumers, consistent with the other action nodes.
          const rec = makeRecord({
            result: 'built',
            detail: 'build tier: message constructed, not sent',
          });
          emitStatus(rec, send, true, message);
          done();
          return;
        }
        case 'send': {
          const message = buildCarrierMessage(configuredCarrier);
          applyActionStatus(node, 'sending', `sending ${displayName}\u2026`);
          connNode.send(message, { band: BAND.CONTROL, target, identityId });
          const rec = makeRecord({ result: 'sent' });
          applyActionStatus(node, 'ok', `sent ${displayName}`);
          emitStatus(rec, send, true, message);
          done();
          return;
        }
        case 'confirm':
        case 'complete':
          await confirmTier();
          return;
        default: break; // This space intentionally left blank (§5)
      }
      // No tier matched, so nothing ran — no send, no ack wait, no record. The
      // input is still completed, because a message left hanging is worse than
      // one that did nothing (mavlink-mission precedent).
      done();
      return;

      /**
       * Send under the ack waiter and settle on its COMMAND_ACK; on Complete,
       * poll the peer table for the completion condition after an ACCEPTED.
       * Rejections propagate to handleInput's caller, which routes them to
       * failInput like any other send failure.
       */
      async function confirmTier() {
        // ── Delivery: Confirm / Complete ────────────────────────────────────
        // slot.run below cancels whatever wait the previous input left.
        const myGen = ++_generation;

        applyActionStatus(node, 'sending', `${displayName}\u2026`);

        // The operator's configured carrier (§9): a required choice, so the
        // wire format is stated intent — never a guess. The ack it earns,
        // wrong-carrier codes included, is the result.
        const ackOutcome = await slot.run(ackWaiterFor(connNode, buildCarrierMessage(configuredCarrier), {
          band: BAND.CONTROL,
          target,
          identityId,
          timeoutMs,
          maxRetries: noAutoRetry ? 0 : maxRetries,
          noAutoRetry,
          // Same badge channel: a takeoff answers IN_PROGRESS for seconds (§9),
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
        }));

        // A redeploy cancelled the wait (close() cancels the waiter slot).
        // The node is being torn down, so finish quietly: emitting or raising
        // here would trip a Catch node wired for "command failed → failsafe" on
        // a mere deploy, which is the same rule mavlink-mission already follows.
        if (ackOutcome.result === 'cancelled') {
          done();
          return;
        }

        // Completion's TAKEOFF datum is frame-aware, but only COMMAND_INT carries
        // a frame on the wire — COMMAND_LONG has none: pass it for INT, withhold
        // it for LONG so completion uses the relative datum instead of AMSL math
        // against a frame the vehicle never saw.
        const completionFrame = configuredCarrier === CARRIER.INT ? frame : undefined;

        // Timeout: check peer table for completion condition.
        if (ackOutcome.result === 'timeout') {
          if (completionKey) {
            const stateCheck = checkCompletion(
              completionKey,
              requestedParams,
              connNode.peerTable,
              target.sysid,
              target.compid,
              completionFrame
            );
            if (stateCheck.done) {
              // Ack was lost on the return leg; the command ran.
              const rec = makeRecord({
                result: 'accepted',
                confirmedBy: 'state',
                retries: ackOutcome.retries,
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
            retries: ackOutcome.retries,
            detail: ackOutcome.detail,
          });
          applyActionStatus(node, 'error', `timeout ${displayName}`);
          const cont = unconfirmedContinue;
          emitStatus(rec, send, cont, cont ? rec : undefined);
          done();
          return;
        }

        // Terminal ack result.
        if (ackOutcome.result === 'accepted') {
          // ── Complete tier: poll peer table for actual completion. ────────
          if (delivery === 'complete' && completionKey) {
            applyActionStatus(node, 'sending', `${displayName} climbing\u2026`);
            const completionWait = waitForCompletion({
              completionKey,
              params: requestedParams,
              peerTable: connNode.peerTable,
              sysid: target.sysid,
              compid: target.compid,
              frame: completionFrame,
              timeoutMs: completionTimeoutMs,
            });
            if (myGen === _generation) {
              slot.active = completionWait;
            } else {
              // The ack settled and a close or new input ran in the same
              // synchronous stack: the sweep fired before this continuation
              // could record its handle, so nothing else can cancel the wait
              // it just created — cancel it here. Also keeps a
              // stale run from clobbering the newer run's handle.
              completionWait.cancel();
            }
            let compOutcome;
            try {
              compOutcome = await completionWait.promise;
            } finally {
              slot.release(completionWait);
            }

            // A redeploy cancelled the wait (close() calls the completion
            // cancel), or the wait settled before any cancel could land —
            // waitForCompletion polls once at creation, so an already-satisfied
            // completion resolves synchronously and the settle-once cancel()
            // becomes a no-op. Either way this run is stale:
            // finish quietly, same rule as the ack cancel above (M1).
            if (compOutcome.cancelled || myGen !== _generation) {
              done();
              return;
            }

            if (compOutcome.success) {
              const rec = makeRecord({
                ...ackRecordFields(ackOutcome),
                // 'state' when the peer table confirmed; 'ack' when the
                // condition was unverifiable and the accepted ack is the
                // whole evidence (base-only SET_MODE).
                confirmedBy: compOutcome.confirmedBy,
                elapsed: Date.now() - startMs,
                detail: compOutcome.detail,
              });
              applyActionStatus(node, 'ok', `${displayName} done`);
              emitStatus(rec, send, true, rec);
            } else {
              // This branch is gated on an ACCEPTED ack: the vehicle answered,
              // then the state never arrived. The ack's resultParam2 and
              // retry count ride through; its resultCode does not — null is
              // the record's "no terminal verdict".
              const rec = makeRecord({
                ...ackRecordFields(ackOutcome),
                result: 'timeout',
                resultCode: null,
                confirmedBy: 'none',
                elapsed: Date.now() - startMs,
                detail: compOutcome.detail,
              });
              applyActionStatus(node, 'error', `${displayName} timeout`);
              emitStatus(rec, send, false);
              done();
              return;
            }
            done();
            return;
          }

          // Confirm tier or complete tier with no condition: accepted is
          // complete, and the waiter's own elapsed (first send to terminal
          // ack) is the record's.
          const rec = makeRecord(ackRecordFields(ackOutcome));
          applyActionStatus(node, 'ok', `${displayName} accepted`);
          emitStatus(rec, send, true, rec);
          done();
          return;
        }

        // Any other terminal failure.
        const rec = makeRecord(ackRecordFields(ackOutcome));
        applyActionStatus(node, 'error', `${displayName} ${ackOutcome.result}`);
        emitStatus(rec, send, false);
        done();
      }
    }

    // Node-RED does not await async input handlers, so an uncaught rejection
    // would otherwise crash the process — route it like every other sender.
    node.on('input', (msg, send, done) => {
      handleInput(msg, send, done).catch((err) => failInput(node, send, err, done));
    });

    node.on('close', (done) => {
      _generation += 1;
      slot.cancel();
      done();
    });
  }

  /**
   * Admin endpoints for editor dropdowns (§6 "Register with needsPermission").
   * Registered with the type; Node-RED calls this factory once per process.
   */
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
    fromBundle: catalogFromBundle,
  });

  RED.nodes.registerType('mavlink-command', MavlinkCommandNode);
};
