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
const { resolveDeliveryContext, missingConnectionGate } = require('../lib/addressing');
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
          mode: payload.mode || config.mode || 'local-position',
          frame: payload.frame !== undefined ? payload.frame : config.frame,
          target,
          position: payload.position || positionFrom(config),
          velocity: payload.velocity || velocityFrom(config),
          accel: payload.accel || accelFrom(config),
          yaw: valueFrom(payload, config, 'yaw'),
          yawRate: valueFrom(payload, config, 'yawRate'),
          timeBootMs: payload.timeBootMs || config.timeBootMs || 0,
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
          const options = {
            connection: connectionNode,
            message,
            target,
            identityId,
            intervalMs: Number(config.intervalMs || payload.intervalMs || 100),
            ttlMs: Number(config.ttlMs || payload.ttlMs || 1000),
          };
          if (stream) stream.stop();
          if (delivery === 'stream') {
            stream = createMoveStream(options);
            stream.start();
            completeResult(node, send, 'succeeded', 'streaming', message);
          } else {
            connectionNode.send(message, {
              band: BAND.STREAMING,
              target: options.target,
              identityId: options.identityId,
            });
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
