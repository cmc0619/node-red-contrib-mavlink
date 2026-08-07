'use strict';

const {
  buildMoveMessage,
  createMoveStream,
  streamLocks,
  advisoryFor,
  positionFrom,
  velocityFrom,
  accelFrom,
  valueFrom,
} = require('../lib/move');
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
    const delivery = config.delivery;
    const connAtDeploy = RED.nodes.getNode(config.connection);
    applyConnectionStatus(node, delivery !== 'build', connAtDeploy);

    // Stop the active stream and free its single-owner scope (#176). Every
    // stop the node causes — replacement, a non-stream input, close — routes
    // through here so no path can leave the target locked with nothing
    // streaming to it.
    function stopStream() {
      if (!stream) return;
      stream.stop();
      stream = null;
      releaseStream();
      releaseStream = null;
      streamKey = null;
    }

    node.on('input', (msg, send, done) => {
      try {
        if (shouldSuppress(msg)) {
          done();
          return;
        }

        const payload = msg.payload ?? {};
        // Move: companion hides both sysid and compid — no compidFromConfig.
        const { connectionNode, target, identityId } = resolveDeliveryContext(RED, {
          delivery,
          config,
          payload,
          connectionNode: connAtDeploy,
        });

        const moveInput = {
          // Blank means inherit (§6): a payload mode/frame of undefined, null,
          // or '' falls back to the node's configured value, never to a
          // hardcoded default that discards the configuration.
          mode: firstDefined(payload.mode, config.mode),
          frame: firstDefined(payload.frame, config.frame),
          target,
          position: payload.position || positionFrom(config),
          velocity: payload.velocity || velocityFrom(config),
          accel: payload.accel || accelFrom(config),
          yaw: valueFrom(payload, config, 'yaw'),
          yawRate: valueFrom(payload, config, 'yawRate'),
          timeBootMs: payload.timeBootMs,
        };
        const message = buildMoveMessage(moveInput);

        // Known-unsupported firmware combos still send, but never silently
        // (§14: setpoints carry no ack, so this warning is all the feedback
        // the operator will get). Firmware comes from the connection's bound
        // Vehicle Profile; every measured advisory is PX4-specific, so Build
        // tier — which has no connection — never warns.
        const advisory = advisoryFor({
          mode: moveInput.mode,
          frame: moveInput.frame,
          firmware: connectionNode?.vehicle?.firmware,
        });
        if (advisory) node.warn(advisory);

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
            const rateHz = streamValue(payload.rateHz, config.rateHz, 'rateHz', 0.1, 'Hz');
            const ttlMs = streamValue(payload.ttlMs, config.ttlMs, 'ttlMs', 0, 'milliseconds');
            // One stream per (connection, target) (#176): a second node
            // streaming to the same vehicle would alternate contradictory
            // setpoints — the vehicle oscillates while both nodes report
            // success. Fail closed, like the mission-transfer lock. This node
            // replacing its own stream to the same target is legitimate
            // single-flight: stopping it first frees the scope, so the
            // synchronous re-acquire below cannot self-conflict. A conflict
            // (necessarily another node's stream) refuses before stopStream,
            // leaving the running stream running like any rejected input.
            const key = streamLocks.key(connectionNode.id, target);
            if (key === streamKey) stopStream();
            const release = streamLocks.acquire(connectionNode.id, target);
            if (!release) {
              throw new Error(
                `a setpoint stream to ${target.sysid}.${target.compid} is already running on this connection — stop it first or target it from one node`
              );
            }
            stopStream();
            stream = createMoveStream({
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
              onExpire: (stopMessage) => {
                stream = null;
                releaseStream = null;
                streamKey = null;
                release();
                completeExpiry(node, stopMessage);
              },
            });
            streamKey = key;
            releaseStream = release;
            // start() sends synchronously before marking the stream active, and
            // Connection.send throws loudly when the identity cannot resolve. A
            // throw here must not strand the just-acquired lock on a stream
            // that never ran — release before the error routes to failInput.
            // stop() on a never-active stream sends nothing, so stopStream()
            // here is purely the bookkeeping.
            try {
              stream.start();
            } catch (err) {
              stopStream();
              throw err;
            }
            completeResult(node, send, 'succeeded', 'streaming', message);
          } else {
            stopStream();
            connectionNode.send(message, { band: BAND.STREAMING, target, identityId });
            completeResult(node, send, 'succeeded', 'sent', message);
          }
        }
        done();
      } catch (err) {
        failInput(node, send, err, done);
      }
    });

    node.on('close', (done) => {
      stopStream();
      done();
    });
  }

  RED.nodes.registerType('mavlink-move', MavlinkMoveNode);
};

function completeBuild(node, send, message) {
  applyActionStatus(node, 'ok', 'built move');
  send([{ payload: message }, statusRecord('succeeded', 'built', { message })]);
}

function completeResult(node, send, result, action, message) {
  applyActionStatus(node, 'ok', action);
  send([{ payload: { result, message } }, statusRecord(result, action, { message })]);
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
 * progress does. Branch on it with a switch for `detail === 'expired'`.
 *
 * @param {object} node
 * @param {object} message  the zero-velocity stop message that was sent
 */
function completeExpiry(node, message) {
  applyActionStatus(node, 'ok', 'stream expired');
  node.send([null, statusRecord('succeeded', 'expired', { message })]);
}

function statusRecord(result, detail, extra = {}) {
  return makeStatusRecord({ node: 'mavlink-move', result, detail, ...extra });
}

/**
 * Stream timing: config is editor-validated and trusted; a payload override is
 * runtime-boundary data and must refuse rather than misbehave silently — a NaN
 * ttl never satisfies the stream's `ttl > 0` expiry check (the stream runs
 * forever), and setInterval coerces a NaN or out-of-range interval to ~1 ms.
 * Minimum 0 keeps ttl 0 = "stream until replaced or closed". The rate minimum
 * is 0.1 Hz: a rate must be positive to be a rate at all, and a near-zero rate
 * is the same hazard in disguise — its 1000/rate interval overflows
 * setInterval's 32-bit ceiling, which Node clamps to 1 ms, turning "almost
 * never" into a 1000 Hz flood. One setpoint per 10 s is already far below any
 * firmware's setpoint watchdog, so nothing real is excluded.
 *
 * @param {*} payloadValue  value from msg.payload, blank = inherit config
 * @param {*} configValue   value from the editor-validated config
 * @param {string} name     payload property name, for the error
 * @param {number} minimum  smallest valid value
 * @param {string} unit     unit name, for the error
 * @returns {number}
 */
function streamValue(payloadValue, configValue, name, minimum, unit) {
  if (isBlank(payloadValue)) {
    return Number(configValue);
  }
  // Only numbers and numeric strings: bare Number() coercion turns `true`
  // into a 1 ms flood and `false`/`[]` into 0.
  const n = typeof payloadValue === 'number' || typeof payloadValue === 'string'
    ? Number(payloadValue)
    : NaN;
  if (!Number.isFinite(n) || n < minimum) {
    throw new Error(
      `payload.${name} must be a finite number of ${unit} >= ${minimum}, got ${JSON.stringify(payloadValue)}`
    );
  }
  return n;
}
