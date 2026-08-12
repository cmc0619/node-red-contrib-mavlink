'use strict';

const {
  buildMoveMessage,
  createMoveStream,
  streamLocks,
  buildRepositionMessage,
  positionFrom,
  velocityFrom,
  accelFrom,
  valueFrom,
  resolveMoveAction,
  frameForAltRef,
  frameForReference,
  deriveSteerMode,
} = require('../lib/move');
const { AckWaiter } = require('../lib/command');
const { DEFAULT_MAX_RESENDS } = require('../lib/command/ack');
const { BAND } = require('../lib/connection/bands');
const { firstDefined, isBlank, resolveDeliveryContext, applyConnectionStatus } = require('../lib/addressing');
const {
  shouldSuppress,
  makeStatusRecord,
  applyActionStatus,
  failInput,
} = require('../lib/delivery');

module.exports = function registerMavlinkMove(RED) {
  function MavlinkMoveNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    let stream = null;
    let streamKey = null;
    let releaseStream = null;
    // Reposition-carrier confirm transaction — at most one in flight per node,
    // like the Command node's waiter (§9).
    let activeWaiter = null;
    const delivery = config.delivery;
    const connAtDeploy = RED.nodes.getNode(config.connection);
    // Resolve the Vehicle Profile once, like the Connection (guideline:
    // config-node references resolve at deploy, not per input). Build-tier
    // body derivation reads firmware through it.
    const vehicleAtDeploy = config.vehicle ? RED.nodes.getNode(config.vehicle) : null;
    applyConnectionStatus(node, delivery !== 'build', connAtDeploy);

    // Stop the active stream and free its single-owner scope (#176). Every
    // stop the node causes — replacement, a non-stream input, an explicit
    // stop, close — routes through here so no path can leave the target
    // locked with nothing streaming to it. `brake` follows GCS practice
    // (§ "Move setpoint matrix"): the brake marks the end of control, so
    // replace/supersede handovers pass false — the new setpoint IS the next
    // command. The bookkeeping runs in `finally` because a brake send can
    // throw (dead link): the lock must come free even when the brake never
    // reached the wire, and each caller owns where that throw lands.
    function stopStream({ brake = true } = {}) {
      if (!stream) return null;
      try {
        return stream.stop({ brake });
      } finally {
        stream = null;
        releaseStream();
        releaseStream = null;
        streamKey = null;
      }
    }

    // Wait for the DO_REPOSITION COMMAND_ACK on the shared Command machinery
    // (§9): AckWaiter matches by (command, source), retries
    // TEMPORARILY_REJECTED, and re-arms on IN_PROGRESS. A goto re-sent is the
    // same goto, so auto-retry is safe. Every non-accepted terminal —
    // COMMAND_INT_ONLY (8) and UNSUPPORTED_MAV_FRAME (9) included — is a
    // failure with its MAV_RESULT name, never silence; Move does no carrier
    // swap, because DO_REPOSITION is COMMAND_INT-only by spec and ArduPilot.
    async function confirmReposition(message, target, identityId, connectionNode, send, done) {
      if (activeWaiter) {
        activeWaiter.cancel();
        activeWaiter = null;
      }
      applyActionStatus(node, 'sending', 'reposition…');
      const waiter = new AckWaiter({
        subscribe: (filter, handler) => connectionNode.subscribe(filter, handler),
        // COMMAND_INT has no confirmation byte, so the retry counter is unused.
        sendFn: () => connectionNode.send(message, { band: BAND.CONTROL, target, identityId }),
        commandId: message.fields.command,
        targetSystem: target.sysid,
        targetComponent: target.compid,
        // Ack attribution (§9): ignore an ack explicitly addressed to a
        // different GCS on a shared link.
        sourceIds: connectionNode.resolveSourceIds(identityId),
        // Blank inherits the AckWaiter default, like the Command node's field.
        timeoutMs: isBlank(config.ackTimeout) ? undefined : Number(config.ackTimeout),
        // A re-sent goto is the same goto, so this carrier opts into the
        // timeout re-send the library leaves off by default (#249).
        maxResends: DEFAULT_MAX_RESENDS,
        // A long reposition answers IN_PROGRESS repeatedly (§9); the badge
        // follows the vehicle's own progress instead of standing still.
        onInProgress: (progress) => {
          applyActionStatus(node, 'sending', progress === null ? 'reposition…' : `reposition ${progress}%…`);
        },
      });
      activeWaiter = waiter;
      let outcome;
      try {
        outcome = await waiter.start();
      } finally {
        if (activeWaiter === waiter) activeWaiter = null;
      }
      if (outcome.result === 'cancelled') {
        // A redeploy cancelled the wait (close() below): the node is being
        // torn down, so finish quietly — same rule as mavlink-command.
        done();
        return;
      }
      const shared = {
        message,
        resultCode: outcome.resultCode,
        resultParam2: outcome.resultParam2,
        retries: outcome.retries,
        elapsed: outcome.elapsed,
      };
      if (outcome.result === 'accepted') {
        completeResult(node, send, 'accepted', null, { ...shared, confirmedBy: 'ack' });
        done();
        return;
      }
      if (outcome.result === 'timeout') {
        // §9: a missing ack is not a failure — and not a verdict either. No
        // completion condition exists for a goto in this node, so a lost ack
        // reports exactly what the Command node reports: unconfirmed, with
        // nothing having confirmed it. Same word, same meaning, same machinery.
        applyActionStatus(node, 'error', 'reposition unconfirmed');
        send([null, statusRecord('unconfirmed', outcome.detail, { ...shared, confirmedBy: 'none' })]);
        done(new Error('Move reposition timed out waiting for COMMAND_ACK'));
        return;
      }
      // Terminal ack — the MAV_RESULT name IS the result ('denied',
      // 'command_int_only', 'command_unsupported_mav_frame', …), passed
      // through verbatim like mavlink-command's, because it is the same
      // AckWaiter outcome. One vocabulary, no translation layer to drift.
      applyActionStatus(node, 'error', `reposition ${outcome.result}`);
      send([null, statusRecord(outcome.result, outcome.detail, { ...shared, confirmedBy: 'ack' })]);
      done(new Error(`Move reposition ${outcome.result}`));
    }

    node.on('input', (msg, send, done) => {
      try {
        if (shouldSuppress(msg)) {
          done();
          return;
        }

        const payload = msg.payload ?? {};
        // Actions are handled before target resolution: a stop names no
        // target — it halts whatever this node is streaming — so nothing a
        // resolver could refuse may refuse an otherwise-valid stop. Runtime-
        // boundary data fails loud: an unknown action throws naming the valid
        // set, and only the stream tier owns streams.
        if (payload.action !== undefined) {
          if (payload.action !== 'stop') {
            throw new Error(
              `unknown Move action ${JSON.stringify(payload.action)} — expected one of: stop`
            );
          }
          if (delivery !== 'stream') {
            throw new Error('Move action "stop" requires stream delivery — only the stream tier owns streams');
          }
          if (stream) {
            const sent = stream.sent;
            // brake: true — an explicit stop is an end of control. A brake
            // send that throws routes to failInput below: that input
            // genuinely failed (the lock is still freed by stopStream).
            const stopMessage = stopStream();
            completeResult(node, send, 'stopped', null, { message: stopMessage, sent });
          } else {
            // A stop with nothing running completes with a distinguishing
            // detail — a stop control must not punish a second press
            // (§ "Move setpoint matrix").
            completeResult(node, send, 'stopped', 'no stream', {});
          }
          done();
          return;
        }
        // Move: companion hides both sysid and compid — no compidFromConfig.
        const { connectionNode, target, identityId } = resolveDeliveryContext(RED, {
          delivery,
          config,
          payload,
          connectionNode: connAtDeploy,
        });

        // Action × Delivery derives the wire (§6 redesign): the operator
        // states an intent; carrier, message name, frame number, and mask are
        // code.
        const action = resolveMoveAction(config.action);

        if (action === 'goto' && delivery !== 'stream') {
          // One-shot guided goto: DO_REPOSITION as COMMAND_INT, the acked
          // path. The altitude reference is the one frame choice that exists.
          const message = buildRepositionMessage({
            mode: 'position',
            frame: frameForAltRef(firstDefined(payload.altRef, config.altRef)),
            target,
            position: payload.position || positionFrom(config),
            speed: valueFrom(payload, config, 'speed'),
            radius: valueFrom(payload, config, 'radius'),
            yaw: valueFrom(payload, config, 'yaw'),
            yawRate: payload.yawRate,
            // CHANGE_MODE flies the vehicle into guided — an explicit boolean
            // opt-in (editor checkbox, payload override), never a truthy token.
            // Measured (§14 2026-08-12): the flag is the gate on both stacks;
            // without it, outside GUIDED (AP) / Hold (PX4), the answer is
            // DENIED (2).
            changeMode: firstDefined(payload.changeMode, config.changeMode),
          });
          if (delivery === 'build') {
            completeBuild(node, send, message);
          } else {
            if (!connectionNode) {
              throw new Error('mavlink-move requires a Connection for send/confirm delivery');
            }
            if (delivery === 'confirm') {
              // Broadcast + confirm: the ack matcher accepts any source at
              // sysid 0, so the first vehicle to answer would settle for the
              // fleet (#260, §9). Send stays broadcast-legal; the expected-set
              // aggregator is fan-out broadcast (§10).
              if (target.sysid === 0) {
                throw new Error(
                  'Move reposition confirm cannot target broadcast (sysid 0) — the first ' +
                  'vehicle to ack would answer for the whole fleet; use Send or ' +
                  'mavlink-fanout broadcast (per-vehicle acks)'
                );
              }
              // Async: the ack arrives later. done() is owned by the confirm
              // flow; a throw anywhere in it fails this input like any other.
              confirmReposition(message, target, identityId, connectionNode, send, done)
                .catch((err) => failInput(node, send, err, done));
              return;
            }
            // Send tier: commands ride the Control band, not Streaming.
            connectionNode.send(message, { band: BAND.CONTROL, target, identityId });
            completeResult(node, send, 'sent', null, { message });
          }
          done();
          return;
        }

        if (delivery === 'confirm') {
          // Setpoints carry no acknowledgement of any kind (§9) — there is
          // nothing for confirm to wait on. Only goto's command path confirms.
          throw new Error('Move setpoints carry no acknowledgement — Send & confirm exists on the Go to action only');
        }

        let moveInput;
        if (action === 'goto') {
          // goto + Stream: the same intent, streamed — position setpoints on
          // the global frame the altitude reference names. `speed`, `radius`,
          // `changeMode` and `yawRate` belong to the command path; a setpoint
          // has no field to carry them, so they are not read here. Ignoring a
          // key the wire has no room for is what the driver does with msg
          // (AGENTS.md, input trust) — it does not refuse over one.
          moveInput = {
            mode: 'position',
            frame: frameForAltRef(firstDefined(payload.altRef, config.altRef)),
            target,
            position: payload.position || positionFrom(config),
            yaw: valueFrom(payload, config, 'yaw'),
            timeBootMs: payload.timeBootMs,
          };
        } else {
          // steer: the reference picks the axes (body is firmware-derived and
          // fails closed on an unknown stack, §14); the mode derives from
          // which groups carry values — filling fields IS the mode.
          const position = payload.position || positionFrom(config);
          const velocity = payload.velocity || velocityFrom(config);
          const accel = payload.accel || accelFrom(config);
          const yaw = valueFrom(payload, config, 'yaw');
          const yawRate = valueFrom(payload, config, 'yawRate');
          moveInput = {
            mode: deriveSteerMode({ position, velocity, accel, yaw, yawRate }),
            frame: frameForReference(
              firstDefined(payload.reference, config.reference),
              firmwareFor(vehicleAtDeploy, connectionNode)
            ),
            target,
            position,
            velocity,
            accel,
            yaw,
            yawRate,
            timeBootMs: payload.timeBootMs,
          };
        }
        const message = buildMoveMessage(moveInput);

        if (delivery === 'build') {
          completeBuild(node, send, message);
        } else {
          if (!connectionNode) {
            throw new Error('mavlink-move requires a Connection for send/stream delivery');
          }
          if (delivery === 'stream') {
            // Validate the replacement fully before stopping the active
            // stream: a rejected input must leave the running stream running,
            // the same way a buildMoveMessage refusal above already does —
            // never stop it as a side effect of a failed replacement.
            // Payload overrides config (§6 runtime override of last resort);
            // the editor default guarantees config when the payload is silent.
            // Blank inherits the editor-validated config; anything else is
            // taken as given and coerced (AGENTS.md, input trust).
            const rateHz = Number(isBlank(payload.rateHz) ? config.rateHz : payload.rateHz);
            const ttlMs = Number(isBlank(payload.ttlMs) ? config.ttlMs : payload.ttlMs);
            // One stream per (connection, target) (#176): a second node
            // streaming to the same vehicle would alternate contradictory
            // setpoints — the vehicle oscillates while both nodes report
            // success. Fail closed, like the mission-transfer lock. This node
            // replacing its own stream keeps the lock it already holds — no
            // release/re-acquire, so no self-conflict window. A retarget
            // acquires its new scope first: a conflict (necessarily another
            // node's stream) refuses before the running stream is touched,
            // like any rejected input.
            const key = streamLocks.key(connectionNode.id, target);
            const sameKey = key === streamKey;
            let release = releaseStream;
            if (!sameKey) {
              release = streamLocks.acquire(connectionNode.id, target);
              if (!release) {
                throw new Error(
                  `a setpoint stream to ${target.sysid}.${target.compid} is already running on this connection — stop it first or target it from one node`
                );
              }
            }
            const next = createMoveStream({
              connection: connectionNode,
              message,
              target,
              identityId,
              rateHz,
              ttlMs,
              // TTL expiry is the only stop the flow did not cause, so it is
              // the only one it cannot observe: without this the node would
              // halt the vehicle and keep reporting "streaming" forever.
              // Async, so it uses node.send — the input that started the
              // stream was completed long ago. The stream stopped itself, so
              // only the bookkeeping is left: free the scope before telling
              // the flow. A replaced stream's timer is already cleared, so
              // this only ever fires for the stream currently in the slot.
              onExpire: (stopMessage, brakeError) => {
                const sent = next.sent;
                stream = null;
                releaseStream = null;
                streamKey = null;
                release();
                completeExpiry(node, stopMessage, sent, brakeError);
              },
              // A tick send that throws is contained in the stream — it
              // keeps cadence and retries (§ "Move setpoint matrix"). One
              // report per failure streak, status output only: the input
              // that started the stream completed long ago, same as expiry.
              onSendError: (err) => {
                applyActionStatus(node, 'error', err.message);
                node.send([null, statusRecord('failed', `setpoint send failed: ${err.message}`)]);
              },
              // First success after a failed streak restores the badge the
              // stream started with. No record — recovery is the absence of
              // failure, not an event.
              onSendRecovery: () => {
                applyActionStatus(node, 'ok', 'streaming');
              },
            });
            // The old stream keeps running until the handover setpoint is
            // accepted: start() sends synchronously, and a throw must leave
            // the vehicle with the retrying stream it already had, not
            // nothing (Codex, #240). Only a retarget's freshly acquired
            // scope needs freeing on the way out.
            try {
              next.start();
            } catch (err) {
              if (!sameKey) release();
              throw err;
            }
            // Handover after the new stream is live. Same target: no brake —
            // the setpoint just sent is the next command (§ "Move setpoint
            // matrix": MAVSDK/QGC never brake between consecutive targets).
            // A retarget ends control of the OLD target, so that one brakes;
            // a brake throw must not undo the already-running replacement
            // (warn, like close — the lock still frees via finally).
            if (stream) {
              const old = stream;
              stream = null;
              try {
                old.stop({ brake: !sameKey });
              } catch (err) {
                node.warn(`Move stream brake failed on retarget: ${err.message}`);
              } finally {
                // No truthiness guard: stream and releaseStream are assigned
                // and cleared together, so inside `if (stream)` the release
                // always exists — and if that invariant ever broke, throwing
                // here beats silently stranding the old target's lock.
                if (!sameKey) releaseStream();
              }
            }
            stream = next;
            streamKey = key;
            releaseStream = release;
            completeResult(node, send, 'streaming', null, { message });
          } else {
            // Send tier. No stopStream here: `delivery` is fixed per node, so
            // a send-delivery node can never own a stream — the guard would
            // protect an unreachable state (AGENTS "Proof-of-possibility").
            connectionNode.send(message, { band: BAND.STREAMING, target, identityId });
            completeResult(node, send, 'sent', null, { message });
          }
        }
        done();
      } catch (err) {
        failInput(node, send, err, done);
      }
    });

    node.on('close', (done) => {
      // An in-flight reposition confirm resolves 'cancelled' and finishes
      // quietly — a redeploy is not a failed command.
      if (activeWaiter) {
        activeWaiter.cancel();
        activeWaiter = null;
      }
      // Close is an end of control, so it brakes — but the brake is the last
      // thing this node ever sends, and a dead link at teardown must not stop
      // the teardown (the firmware's setpoint watchdog covers the vehicle).
      try {
        stopStream();
      } catch (err) {
        node.warn(`Move stream brake failed on close: ${err.message}`);
      }
      done();
    });
  }

  RED.nodes.registerType('mavlink-move', MavlinkMoveNode);
};

function completeBuild(node, send, message) {
  applyActionStatus(node, 'ok', 'built move');
  send([{ payload: message }, statusRecord('built', null, { message })]);
}

/**
 * A completed input: badge, output 0 trigger, status record — one shape for
 * every good outcome. One input, one trigger (§9): a stop that completed
 * fires output 0 like any other completed input; its 'no stream' detail
 * distinguishes the second press.
 *
 * The result IS the outcome, one meaning per word, shared with
 * mavlink-command wherever the meaning is shared: 'sent' (on the wire,
 * nobody answers), 'streaming' (setpoints flowing at rate), 'stopped'
 * (stream ended by the flow), 'accepted' (the vehicle agreed — reposition
 * confirm only). 'succeeded' is banned from this node: it once meant both
 * "on the wire" and "the vehicle agreed", and a word with two meanings is
 * how 27/30 measured silence as success.
 *
 * @param {object} node
 * @param {Function} send
 * @param {string} result  'sent' | 'streaming' | 'stopped' | 'accepted'
 * @param {?string} detail  qualifier within the result ('no stream'), or null
 * @param {object} fields  payload/record fields (message, `sent` on stops,
 *   resultCode/retries/elapsed/confirmedBy on reposition confirms)
 */
function completeResult(node, send, result, detail, fields) {
  applyActionStatus(node, 'ok', detail || result);
  send([{ payload: { result, ...fields } }, statusRecord(result, detail, fields)]);
}

/**
 * A stream reached its TTL: the vehicle already has the stop packet, and this
 * is what tells the flow.
 *
 * **Status port only.** Output 0 is a trigger, not a report (§9): one input
 * fires it at most once, and a consumer never inspects the payload to decide
 * whether to proceed. Starting the stream already fired it, so emitting again
 * here would run the whole downstream chain a second time — the setpoint's own
 * "then do X" would fire at t=0 as well as at expiry. Expiry is a lifecycle
 * update, and lifecycle updates ride output 1, the same way Mission and Param
 * progress does. Branch on it with a switch for `result === 'expired'`.
 *
 * @param {object} node
 * @param {object|null} message  the zero-velocity brake that was sent, or null when its send threw
 * @param {number} sent  setpoints the connection accepted (not wire deliveries — the streaming band coalesces under backpressure)
 * @param {Error} [brakeError]  set when the expiry brake send threw
 */
function completeExpiry(node, message, sent, brakeError) {
  applyActionStatus(node, 'ok', 'stream expired');
  // `result` is the documented discriminator (`result === 'expired'`) and
  // must survive a brake failure — the one moment downstream recovery matters
  // most is exactly when the switch must still match (Codex, #240). The
  // failure rides its own field instead.
  const extra = { message, sent };
  if (brakeError) extra.brakeError = brakeError.message;
  node.send([null, statusRecord('expired', null, extra)]);
}

function statusRecord(result, detail, extra = {}) {
  return makeStatusRecord({ node: 'mavlink-move', result, detail, ...extra });
}

/**
 * Firmware for the body-reference derivation: the connection's bound Vehicle
 * Profile on the wire tiers, the node's own Vehicle Profile (resolved once at
 * deploy) on Build. Returns undefined when neither names one — the body
 * derivation fails closed on that, and world never asks.
 *
 * @param {object|null} vehicleNode  the node's own Vehicle Profile, from deploy
 * @param {object|null} connectionNode
 * @returns {string|undefined}
 */
function firmwareFor(vehicleNode, connectionNode) {
  return connectionNode?.vehicle?.firmware ?? vehicleNode?.firmware;
}

