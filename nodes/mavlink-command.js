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
 * Carrier (§9 "Coordinate frames"): the editor defaults to COMMAND_LONG and
 * the operator can pick COMMAND_INT explicitly. Positional params are always
 * entered in decimal degrees; the INT carrier scales them to
 * degE7 on the wire. The ack, whatever it says, is the result.
 *
 * Delivery tiers (§9 "Delivery tiers"):
 *   build    — construct the selected carrier message and emit on output 0;
 *              no send.
 *   send     — fire-and-forget; no acknowledgement waiting.
 *   confirm  — wait for COMMAND_ACK; re-send on TEMPORARILY_REJECTED and
 *              into a silent window, from one retry budget (a preset marked
 *              noAutoRetry forces 0); silence past the budget runs the
 *              peer-table check and otherwise settles unconfirmed.
 *   complete — after ACCEPTED, poll peer table until completion condition met.
 *              Only offered for commands that have a completion condition (§9).
 *
 * Guard the input:
 *   msg.payload === false → suppress (§9 "What triggers an action node")
 */

const { getPreset, presetGroups, buildParamArray } = require('../lib/command/presets');
const { mergeParams } = require('../lib/command/merge-params');
const { awaitAckWithBadge, cancelSlot, settleAck, SUPERSEDED } = require('../lib/command/ack');
const { checkCompletion, waitForCompletion } = require('../lib/command/completion');
const {
  buildCarrier,
  CARRIER,
  MAV_FRAME,
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
  makeStatusRecord,
  applyActionStatus,
  completeBuild,
  onActionInput,
} = require('../lib/delivery');
const { BAND } = require('../lib/connection/bands');

/**
 * The preset row this node sends: the named preset, or for Advanced a row
 * synthesized from the chosen MAV_CMD — every param exposed, and no pins,
 * blank sentinels, retry opt-out or completion condition — so both modes
 * run the same code.
 *
 * @param {object} config  node config from editor
 * @returns {import('../lib/command/presets').Preset|undefined}
 */
function resolveCommand(config) {
  switch (config.mode) {
    case 'advanced': {
      const commandId = Number(config.advancedCommand);
      return {
        command: `MAV_CMD(${commandId})`,
        name: `#${commandId}`,
        commandId,
        exposedParams: [1, 2, 3, 4, 5, 6, 7],
      };
    }
    case 'preset':
      return getPreset(config.preset);
    default: break; // This space intentionally left blank (§5)
  }
  return undefined; // nothing matched: no behavior selected (§5)
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
    const preset = resolveCommand(config);
    const { commandId, name: displayName, completionKey } = preset;

    const connNode = RED.nodes.getNode(config.connection);
    // Configured params are deploy-constant: parse the JSON once, not per
    // input (mavlink-mission's items pattern). The editor saves valid JSON.
    const configParams = JSON.parse(config.params);

    const delivery = config.delivery;

    // A checkbox: settleAck fires output 0 on `unconfirmed` when it is set.
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
      const userParams = mergeParams(configParams, payload);
      applyModeName(userParams, payload, resolution);
      // Two views of one request. `wire` is what transmits — zero-filled, so a
      // blank lat/lon becomes 0,0, a legal coordinate the vehicle will fly to;
      // the editor is what stops that being configured (mavlink-command.html
      // `params`), and on the payload path it is trusted and rides (AGENTS.md,
      // input trust). `requested` keeps the holes: completion verifies what
      // was asked for, and the wire filler is indistinguishable from a real 0
      // there (custom_mode 0 is ArduPilot STABILIZE).
      const requested = [1, 2, 3, 4, 5, 6, 7].map((i) => userParams[i]);
      return { wire: buildParamArray(preset, userParams), requested };
    }

    async function handleInput(msg, send, done) {
      // The editor's `sendAs` select is the vocabulary (mavlink-command.html);
      // buildCarrier dispatches it affirmatively.
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

      /** The command and target every record of this input names. */
      const recordFields = { command: preset.command, commandId, target };

      /**
       * This input's status record on the Build and Send tiers: the command,
       * target and elapsed time since the input arrived, with the ack fields
       * a wire tier's record carries left null.
       */
      function makeRecord(fields) {
        return makeStatusRecord(node.type, {
          resultCode: null,
          resultParam2: null,
          retries: 0,
          detail: null,
          ...recordFields,
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
       * The wire message on the operator's configured carrier (lib/command
       * buildCarrier). Only the INT carrier reads `coordKinds` — how param5/6
       * ride per the dialect XML (§9 "ask the XML") — so the dialect is
       * looked up (commandByValue indexes it once per bundle) only when it
       * is asked; a dialect that cannot be loaded throws, and that throw is
       * the input's failure (§0).
       *
       * @returns {{name: string, fields: object}|undefined}
       */
      function buildCarrierMessage() {
        return buildCarrier(configuredCarrier, commandId, target, paramArray, {
          frame,
          get coordKinds() {
            return intCoordKinds(dialectForTier(RED, delivery, config, connNode), commandId);
          },
        });
      }

      // ── Delivery ──────────────────────────────────────────────────────────
      // Build and Send finish here; Confirm and Complete share the ack waiter
      // below and differ in what an ACCEPTED ack hands off to.
      switch (delivery) {
        case 'build':
          completeBuild(node, send, buildCarrierMessage(), displayName, makeRecord({}));
          done();
          return;
        case 'send': {
          const message = buildCarrierMessage();
          applyActionStatus(node, 'sending', `sending ${displayName}\u2026`);
          connNode.send(message, { band: BAND.CONTROL, target, identityId });
          applyActionStatus(node, 'ok', `sent ${displayName}`);
          send([{ payload: message }, makeRecord({ result: 'sent' })]);
          done();
          return;
        }
        case 'confirm':
          await confirmTier();
          return;
        case 'complete':
          await confirmTier(pollCompletion);
          return;
        default: break; // This space intentionally left blank (§5)
      }
      // No tier matched, so nothing ran — no send, no ack wait, no record. The
      // input is still completed, because a message left hanging is worse than
      // one that did nothing (mavlink-mission precedent).
      done();
      return;

      /**
       * Completion's TAKEOFF datum follows the stack. ArduPilot reads a
       * takeoff altitude relative to home on both carriers and denies any INT
       * frame but 3 (§14.74), so the INT frame is the datum there and
       * COMMAND_LONG (no frame on the wire) reads as relative. PX4 reads
       * param7 as AMSL on both carriers — `mavlink_receiver` copies `z` to
       * `param7` with no frame conversion and `navigator` takes it as the
       * loiter altitude AMSL (§14.79) — so completion compares against what
       * that vehicle flies to, whatever frame the operator saved (471#49).
       *
       * @returns {number|undefined}
       */
      function completionFrame() {
        switch (profile.firmware) {
          case 'px4': return MAV_FRAME.GLOBAL;
          case 'ardupilot':
            switch (configuredCarrier) {
              case CARRIER.INT: return frame;
              default: break; // This space intentionally left blank (§5)
            }
            break;
          default: break; // This space intentionally left blank (§5)
        }
        return undefined; // nothing matched: no behavior selected (§5)
      }

      /**
       * Send under the ack waiter and settle on its COMMAND_ACK (settleAck);
       * an ACCEPTED hands off to the tier's continuation when there is one.
       * Rejections propagate to handleInput's caller, which routes them to
       * failInput like any other send failure.
       *
       * @param {(ackRecord: object, ackOutcome: object, myGen: number) => Promise<void>} [onAccepted]
       */
      async function confirmTier(onAccepted) {
        // ── Delivery: Confirm / Complete ────────────────────────────────────
        // slot.run below cancels whatever wait the previous input left.
        const myGen = ++_generation;

        // The operator's configured carrier (§9): a required choice, so the
        // wire format is stated intent — never a guess. The ack it earns,
        // wrong-carrier codes included, is the result.
        let ackOutcome = await awaitAckWithBadge(node, slot, connNode, buildCarrierMessage(), displayName, {
          target,
          identityId,
          timeoutMs,
          maxRetries: preset.noAutoRetry ? 0 : maxRetries,
        });

        // A lost ack is checked against the peer table (§9): state that
        // already shows the condition means the ack was lost on the return
        // leg and the command ran.
        if (ackOutcome.result === 'timeout') {
          const stateCheck = checkCompletion(
            completionKey,
            requestedParams,
            connNode.peerTable,
            target.sysid,
            target.compid,
            completionFrame(),
            profile.firmware
          );
          if (stateCheck.done) {
            ackOutcome = {
              ...ackOutcome,
              result: 'accepted',
              confirmedBy: 'state',
              detail: `ack timeout but ${stateCheck.detail}`,
            };
          }
        }

        await settleAck(node, send, done, ackOutcome, {
          label: displayName,
          fields: recordFields,
          continueUnconfirmed: unconfirmedContinue,
          onAccepted: onAccepted && ((ackRecord) => onAccepted(ackRecord, ackOutcome, myGen)),
        });
      }

      /**
       * Complete tier: poll the peer table for the completion condition after
       * an ACCEPTED ack.
       *
       * @param {object} ackRecord  the accepted ack's status record
       * @param {object} ackOutcome
       * @param {number} myGen  the run's generation, for the stale-run check
       */
      async function pollCompletion(ackRecord, ackOutcome, myGen) {
        applyActionStatus(node, 'sending', `${displayName} completing\u2026`);
        // Component 0 addresses every component of the system; the one that
        // acked is the one whose state settles completion. No peer advertises
        // compid 0, so looking it up would never find a row.
        const completionCompid = target.compid === 0 ? ackOutcome.compid : target.compid;
        const completionWait = waitForCompletion({
          completionKey,
          params: requestedParams,
          peerTable: connNode.peerTable,
          sysid: target.sysid,
          compid: completionCompid,
          frame: completionFrame(),
          firmware: profile.firmware,
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
        const compOutcome = await completionWait.promise.finally(() => slot.release(completionWait));

        // A newer input superseded the wait: the command already ran, so
        // report it on output 1 like a superseded ack wait (settleAck).
        // A redeploy cancelled it (close() calls the completion cancel),
        // or the wait settled before any cancel could land —
        // waitForCompletion polls once at creation, so an already-satisfied
        // completion resolves synchronously and the settle-once cancel()
        // becomes a no-op. Either way this run is stale: finish quietly,
        // same rule as a redeploy-cancelled ack wait (§14.47).
        if (compOutcome.cancelled && compOutcome.detail === SUPERSEDED) {
          send([null, {
            ...ackRecord,
            result: 'cancelled',
            resultCode: null,
            confirmedBy: undefined,
            elapsed: Date.now() - startMs,
            detail: SUPERSEDED,
          }]);
        }
        if (compOutcome.cancelled || myGen !== _generation) {
          done();
          return;
        }

        if (compOutcome.success) {
          const rec = {
            ...ackRecord,
            // 'state' when the peer table confirmed; 'ack' when the
            // condition was unverifiable and the accepted ack is the
            // whole evidence (base-only SET_MODE).
            confirmedBy: compOutcome.confirmedBy,
            elapsed: Date.now() - startMs,
            detail: compOutcome.detail,
          };
          applyActionStatus(node, 'ok', `${displayName} done`);
          send([{ payload: rec }, rec]);
        } else {
          // This branch is gated on an ACCEPTED ack: the vehicle answered,
          // then the state never arrived. The ack's resultParam2 and
          // retry count ride through; its resultCode does not — null is
          // the record's "no terminal verdict" — and neither does its
          // confirmedBy: an accepted ack is not the completion.
          const rec = {
            ...ackRecord,
            result: 'timeout',
            resultCode: null,
            confirmedBy: undefined,
            elapsed: Date.now() - startMs,
            detail: compOutcome.detail,
          };
          applyActionStatus(node, 'error', `${displayName} timeout`);
          send([null, rec]);
          done();
          return;
        }
        done();
        return;
      }
    }

    onActionInput(node, handleInput);

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
