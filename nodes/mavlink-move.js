'use strict';

const {
  buildMoveMessage,
  createMoveStream,
  advisoryFor,
  positionFrom,
  velocityFrom,
  accelFrom,
  valueFrom,
} = require('../lib/move');
const { BAND } = require('../lib/connection/bands');
const { firstDefined, resolveDeliveryContext, missingConnectionGate } = require('../lib/addressing');
const {
  shouldSuppress,
  makeStatusRecord,
  applyActionStatus,
} = require('../lib/delivery');

module.exports = function registerMavlinkMove(RED) {
  function MavlinkMoveNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    let stream = null;
    const delivery = config.delivery;
    const connAtDeploy = delivery === 'build' ? null : RED.nodes.getNode(config.connection);
    missingConnectionGate(node, delivery, connAtDeploy);

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
        // Vehicle Profile; Build tier has none, so only the firmware-agnostic
        // force advisory can fire there.
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
            const intervalMs = streamMs(payload.intervalMs, config.intervalMs, 'intervalMs', 1);
            const ttlMs = streamMs(payload.ttlMs, config.ttlMs, 'ttlMs', 0);
            if (stream) stream.stop();
            stream = createMoveStream({
              connection: connectionNode,
              message,
              target,
              identityId,
              intervalMs,
              ttlMs,
            });
            stream.start();
            completeResult(node, send, 'succeeded', 'streaming', message);
          } else {
            if (stream) stream.stop();
            connectionNode.send(message, { band: BAND.STREAMING, target, identityId });
            completeResult(node, send, 'succeeded', 'sent', message);
          }
        }
        done();
      } catch (err) {
        fail(node, send, err, msg, done);
      }
    });

    node.on('close', (done) => {
      if (stream) stream.stop();
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

function fail(node, send, err, msg, done) {
  applyActionStatus(node, 'error', err.message);
  send([null, statusRecord('failed', err.message)]);
  done(err);
}

function statusRecord(result, detail, extra = {}) {
  return makeStatusRecord({ node: 'mavlink-move', result, detail, ...extra });
}

/**
 * Stream timing: config is editor-validated and trusted; a payload override is
 * runtime-boundary data and must refuse rather than misbehave silently — a NaN
 * ttl never satisfies the stream's `ttl > 0` expiry check (the stream runs
 * forever), and setInterval coerces a negative or NaN interval to ~1 ms or the
 * fallback. Minimum 0 keeps ttl 0 = "stream until replaced or closed";
 * an interval needs at least 1 ms to be a rate at all.
 *
 * @param {*} payloadValue  ms from msg.payload, blank = inherit config
 * @param {*} configValue   ms from the editor-validated config
 * @param {string} name     payload property name, for the error
 * @param {number} minimum  smallest valid ms value
 * @returns {number}
 */
function streamMs(payloadValue, configValue, name, minimum) {
  if (payloadValue === undefined || payloadValue === null || payloadValue === '') {
    return Number(configValue);
  }
  // Only numbers and numeric strings: bare Number() coercion turns `true`
  // into a 1 ms flood and `false`/`[]` into 0.
  const n = typeof payloadValue === 'number' || typeof payloadValue === 'string'
    ? Number(payloadValue)
    : NaN;
  if (!Number.isFinite(n) || n < minimum) {
    throw new Error(
      `payload.${name} must be a finite number of milliseconds >= ${minimum}, got ${JSON.stringify(payloadValue)}`
    );
  }
  return n;
}
