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
  buildTurnMessage,
  buildSpeedMessage,
  buildAttitudeMessage,
  buildManualMessage,
  frameForAltRef,
  frameForReference,
  deriveSteerMode,
} = require('../lib/move');
const { ackWaiterFor, ackRecordFields, cancelSlot } = require('../lib/command');
const { BAND } = require('../lib/connection/bands');
const { resolveDeliveryContext } = require('../lib/addressing');
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
    // like the Command node's waiter (§9, lib/command cancelSlot).
    const waiterSlot = cancelSlot();
    const delivery = config.delivery;
    const connAtDeploy = RED.nodes.getNode(config.connection);
    // Resolve the Vehicle Profile once, like the Connection (guideline:
    // config-node references resolve at deploy, not per input). Build-tier
    // body derivation reads firmware through it.
    const vehicleAtDeploy = RED.nodes.getNode(config.vehicle);

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
    // failure with its MAV_RESULT name, never silence.
    async function confirmCommand(label, message, target, identityId, connectionNode, send, done) {
      applyActionStatus(node, 'sending', `${label}…`);
      const outcome = await waiterSlot.run(ackWaiterFor(connectionNode, message, {
        band: BAND.CONTROL,
        target,
        identityId,
        // The editor owns the default and the number ring.
        timeoutMs: Number(config.ackTimeout),
        // A long reposition answers IN_PROGRESS repeatedly (§9); the badge
        // follows the vehicle's own progress instead of standing still.
        onInProgress: (progress) => {
          applyActionStatus(node, 'sending', progress === null ? `${label}…` : `${label} ${progress}%…`);
        },
      }));
      if (outcome.result === 'cancelled') {
        // A redeploy cancelled the wait (close() below): the node is being
        // torn down, so finish quietly — same rule as mavlink-command.
        done();
        return;
      }
      const fields = { ...ackRecordFields(outcome), message };
      if (outcome.result === 'accepted') {
        completeResult(node, send, 'accepted', null, fields);
        done();
        return;
      }
      if (outcome.result === 'timeout') {
        // §9: a missing ack is not a failure — and not a verdict either. No
        // completion condition exists for a goto in this node, so a lost ack
        // reports exactly what the Command node reports: unconfirmed, with
        // nothing having confirmed it. Same word, same meaning, same machinery.
        applyActionStatus(node, 'error', `${label} unconfirmed`);
        send([null, makeStatusRecord(node.type, { ...fields, result: 'unconfirmed' })]);
        done();
        return;
      }
      // Every other terminal — a MAV_RESULT name ('denied',
      // 'command_int_only', 'command_unsupported_mav_frame', …) or a failed
      // re-send — is the AckWaiter outcome verbatim, `confirmedBy` included.
      // One vocabulary, no translation layer to drift.
      applyActionStatus(node, 'error', `${label} ${outcome.result}`);
      send([null, makeStatusRecord(node.type, fields)]);
      done();
    }

    /**
     * Deliver an acked MAV_CMD on the Build / Send / Send & confirm tiers.
     * Shared by every Move action that rides a command rather than a setpoint —
     * reposition, turn, speed — so there is one AckWaiter and one result
     * vocabulary across all of them (#276), not one per action.
     *
     * @param {string} label  the action word, used in status and error text
     * @returns {boolean} true when the async confirm flow has taken ownership
     *   of `done`; the caller must return without calling it
     */
    function deliverCommand(label, message, target, identityId, connectionNode, send, done) {
      switch (delivery) {
        case 'build':
          completeBuild(node, send, message);
          return false;
        case 'confirm':
          confirmCommand(label, message, target, identityId, connectionNode, send, done)
            .catch((err) => failInput(node, send, err, done));
          return true;
        case 'send':
          // Commands ride the Control band, not Streaming.
          connectionNode.send(message, { band: BAND.CONTROL, target, identityId });
          completeResult(node, send, 'sent', null, { message });
          return false;
        default: break; // This space intentionally left blank (§5)
      }
      return false;
    }

    node.on('input', (msg, send, done) => {
      try {
        if (shouldSuppress(msg)) {
          done();
          return;
        }

        const payload = msg.payload;
        // The one runtime verb, dispatched before target resolution: a stop
        // names no target — it halts whatever this node is streaming — so
        // nothing a resolver could refuse may refuse it. Any other value
        // selects no stop and rides the build path below.
        switch (payload.action) {
          case 'stop': {
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
          default: break; // This space intentionally left blank (§5)
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
        // code. One affirmative switch on action (#316); goto nests delivery.
        const action = config.action;

        /**
         * Build / stream / send a setpoint-shaped message. Shared by
         * attitude/manual/steer and by goto+stream.
         * @param {object|undefined} message
         * @param {string} brakingAction  action name for the stream brake rule
         */
        function deliverSetpoint(message, brakingAction) {
          switch (delivery) {
            case 'build':
              completeBuild(node, send, message);
              break;
            case 'stream': {
              // msg overrides by presence; the editor owns the defaults and rings.
              const rateHz = payload.rateHz === undefined ? Number(config.rateHz) : payload.rateHz;
              const ttlMs = payload.ttlMs === undefined ? Number(config.ttlMs) : payload.ttlMs;
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
                  // eslint-disable-next-line no-restricted-syntax -- §0 rule 3: another node holds the setpoint stream lock — live runtime state
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
                // Attitude and manual end by going quiet (§9 ruling 1): zero
                // thrust is a descent and a centred stick is a command, so
                // neither has a brake packet to synthesize. Position setpoints
                // keep their measured zero-velocity brake.
                braking: brakingAction !== 'attitude' && brakingAction !== 'manual',
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
                  node.send([null, makeStatusRecord(node.type, {
                    result: 'failed', detail: `setpoint send failed: ${err.message}`,
                  })]);
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
              break;
            }
            case 'send':
              // No stopStream here: `delivery` is fixed per node, so a
              // send-delivery node can never own a stream.
              connectionNode.send(message, { band: BAND.STREAMING, target, identityId });
              completeResult(node, send, 'sent', null, { message });
              break;
            default: break; // This space intentionally left blank (§5)
          }
        }

        switch (action) {
          case 'turn': {
            // Turn is an acked MAV_CMD, not a setpoint (§9 roster): command
            // tiers only, no Stream — the editor does not offer that tier.
            const relative = payload.relative === undefined ? config.relative : payload.relative;
            const message = buildTurnMessage({
              heading: valueFrom(payload, config, 'heading'),
              rate: valueFrom(payload, config, 'turnRate'),
              direction: valueFrom(payload, config, 'direction'),
              // Relative changes what the heading number means, so it is a
              // strict boolean opt-in like changeMode — never a truthy token.
              relative,
              target,
            });
            if (deliverCommand(action, message, target, identityId, connectionNode, send, done)) return;
            done();
            return;
          }
          case 'speed': {
            // Speed is an acked MAV_CMD on both stacks (§9 roster).
            const message = buildSpeedMessage({
              speed: valueFrom(payload, config, 'speed'),
              throttle: valueFrom(payload, config, 'throttle'),
              speedType: payload.speedType === undefined ? config.speedType : payload.speedType,
              target,
            });
            if (deliverCommand(action, message, target, identityId, connectionNode, send, done)) return;
            done();
            return;
          }
          case 'goto': {
            switch (delivery) {
              case 'stream':
                // goto + Stream: position setpoints on the global frame the
                // altitude reference names.
                deliverSetpoint(
                  setpointFor(action, payload, config, target, vehicleAtDeploy, connectionNode),
                  action
                );
                done();
                return;
              case 'build':
              case 'send':
              case 'confirm': {
                // One-shot guided goto: DO_REPOSITION as COMMAND_INT, the acked
                // path. The altitude reference is the one frame choice that exists.
                const message = buildRepositionMessage({
                  mode: 'position',
                  frame: frameForAltRef(payload.altRef === undefined ? config.altRef : payload.altRef),
                  target,
                  position: payload.position === undefined ? positionFrom(config) : payload.position,
                  speed: valueFrom(payload, config, 'speed'),
                  radius: valueFrom(payload, config, 'radius'),
                  yaw: valueFrom(payload, config, 'yaw'),
                  yawRate: payload.yawRate,
                  // CHANGE_MODE flies the vehicle into guided — an explicit boolean
                  // opt-in (editor checkbox, payload override), never a truthy token.
                  // Measured (§14 2026-08-12): the flag is the gate on both stacks;
                  // without it, outside GUIDED (AP) / Hold (PX4), the answer is
                  // DENIED (2).
                  changeMode: payload.changeMode === undefined ? config.changeMode : payload.changeMode,
                });
                // Async on the confirm tier: the ack arrives later and the confirm
                // flow owns done() from here.
                if (deliverCommand('reposition', message, target, identityId, connectionNode, send, done)) return;
                done();
                return;
              }
              default: break; // This space intentionally left blank (§5)
            }
            done();
            return;
          }
          case 'attitude':
          case 'manual':
          case 'steer':
            deliverSetpoint(
              setpointFor(action, payload, config, target, vehicleAtDeploy, connectionNode),
              action
            );
            done();
            return;
          default: break; // This space intentionally left blank (§5)
        }
        done();
      } catch (err) {
        failInput(node, send, err, done);
      }
    });

    node.on('close', (done) => {
      // An in-flight reposition confirm resolves 'cancelled' and finishes
      // quietly — a redeploy is not a failed command.
      waiterSlot.cancel();
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

/**
 * The setpoint message for a non-command action — everything Move sends that is
 * not an acked MAV_CMD.
 *
 * Extracted from the input handler rather than inlined: with six actions the
 * handler was measured at cyclomatic complexity 36 (DeepSource, #303), and five
 * of those branches were only ever choosing which builder to call. The handler
 * keeps the parts that are genuinely about *this* input — suppression, target
 * resolution, delivery, the stream lock — and this owns the wire shape.
 *
 * Attitude and manual are setpoints in every way that matters to delivery
 * (Build/Send/Stream, no ack) so they land here rather than growing a parallel
 * path. Neither speaks a frame or a mode: their mask, or manual's axis-invalid
 * sentinel, derives from which fields carry values — the same presence rule
 * Steer uses.
 *
 * @param {string} action  a MOVE_ACTIONS member that is not a command action
 * @param {object} payload  msg.payload (trusted — AGENTS.md input trust)
 * @param {object} config  the node's saved configuration
 * @param {{sysid: number, compid: number}} target
 * @param {object|null} vehicleAtDeploy  the node's own Vehicle Profile, if any
 * @param {object|null} connectionNode
 * @returns {{name: string, fields: object}}
 */
function setpointFor(action, payload, config, target, vehicleAtDeploy, connectionNode) {
  switch (action) {
    case 'attitude':
      return buildAttitudeMessage({
        roll: valueFrom(payload, config, 'roll'),
        pitch: valueFrom(payload, config, 'pitch'),
        yaw: valueFrom(payload, config, 'yaw'),
        rollRate: valueFrom(payload, config, 'rollRate'),
        pitchRate: valueFrom(payload, config, 'pitchRate'),
        yawRate: valueFrom(payload, config, 'yawRate'),
        thrust: valueFrom(payload, config, 'thrust'),
        timeBootMs: payload.timeBootMs,
        target,
      });
    case 'manual':
      return buildManualMessage({
        x: valueFrom(payload, config, 'stickX'),
        y: valueFrom(payload, config, 'stickY'),
        z: valueFrom(payload, config, 'stickZ'),
        r: valueFrom(payload, config, 'stickR'),
        buttons: valueFrom(payload, config, 'buttons'),
        target,
      });
    case 'goto':
      // goto + Stream: the same intent, streamed — position setpoints on the
      // global frame the altitude reference names. `speed`, `radius`,
      // `changeMode` and `yawRate` belong to the command path; a setpoint has no
      // field to carry them, so they are not read here. Ignoring a key the wire
      // has no room for is what the driver does with msg (AGENTS.md, input
      // trust) — it does not refuse over one.
      return buildMoveMessage({
        mode: 'position',
        frame: frameForAltRef(payload.altRef === undefined ? config.altRef : payload.altRef),
        target,
        position: payload.position === undefined ? positionFrom(config) : payload.position,
        yaw: valueFrom(payload, config, 'yaw'),
        timeBootMs: payload.timeBootMs,
      });
    case 'steer': {
      // The reference picks the axes (body is firmware-derived and fails
      // closed on an unknown stack, §14); the mode derives from which groups
      // carry values — filling fields IS the mode.
      const position = payload.position === undefined ? positionFrom(config) : payload.position;
      const velocity = payload.velocity === undefined ? velocityFrom(config) : payload.velocity;
      const accel = payload.accel === undefined ? accelFrom(config) : payload.accel;
      const yaw = valueFrom(payload, config, 'yaw');
      const yawRate = valueFrom(payload, config, 'yawRate');
      return buildMoveMessage({
        mode: deriveSteerMode({ position, velocity, accel, yaw, yawRate }),
        frame: frameForReference(
          payload.reference === undefined ? config.reference : payload.reference,
          firmwareFor(vehicleAtDeploy, connectionNode)
        ),
        target,
        position,
        velocity,
        accel,
        yaw,
        yawRate,
        timeBootMs: payload.timeBootMs,
      });
    }
    default: break; // This space intentionally left blank (§5)
  }
  // A non-member action matches no case and returns undefined; the caller
  // craters on it — serialize rejects it on send/stream, and the build tier
  // ships it to a deferred crater at the next node.
  return undefined; // nothing matched: no behavior selected (§5)
}

function completeBuild(node, send, message) {
  applyActionStatus(node, 'ok', 'built move');
  send([{ payload: message }, makeStatusRecord(node.type, { result: 'built', detail: null, message })]);
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
  send([{ payload: { result, ...fields } }, makeStatusRecord(node.type, { result, detail, ...fields })]);
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
  node.send([null, makeStatusRecord(node.type, { result: 'expired', detail: null, ...extra })]);
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
