'use strict';

const { buildMoveMessage, createMoveStream } = require('../lib/move');
const {
  resolveActionTarget,
  profileFromVehicleNode,
} = require('../lib/addressing/resolve');
const {
  shouldSuppress,
} = require('../lib/delivery');

const BADGE_MAX = 24;

module.exports = function registerMavlinkMove(RED) {
  function MavlinkMoveNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    let stream = null;

    node.on('input', (msg, send, done) => {
      try {
        if (shouldSuppress(msg)) {
          done();
          return;
        }

        const delivery = config.delivery;
        const connectionNode = delivery !== 'build'
          ? RED.nodes.getNode(config.connection)
          : null;
        const payload = msg.payload ?? {};

        const profile = delivery === 'build' && config.dialect === '__vehicle'
          ? profileFromVehicleNode(RED.nodes.getNode(config.vehicle))
          : (connectionNode && connectionNode.vehicle) || null;
        const identityNode = delivery === 'build'
          ? null
          : RED.nodes.getNode(payload.identityId || config.identity);

        const target = resolveActionTarget({
          payloadTarget: payload.target,
          configSysid: config.targetSystem,
          configCompid: config.targetComponent,
          identityNode,
          profile,
          // Move: companion hides both sysid and compid — no compidFromConfig
        });

        const message = buildMoveMessage({
          mode: payload.mode || config.mode || 'local-position',
          target,
          position: payload.position || positionFrom(config),
          velocity: payload.velocity || velocityFrom(config),
          yaw: valueFrom(payload, config, 'yaw'),
          yawRate: valueFrom(payload, config, 'yawRate'),
          timeBootMs: payload.timeBootMs || config.timeBootMs || 0,
        });

        if (delivery === 'build') {
          completeBuild(node, send, message);
        } else {
          if (!connectionNode || typeof connectionNode.send !== 'function') {
            throw new Error('mavlink-move requires a Connection for send/stream delivery');
          }
          // Payload-first, matching the target derivation above.
          const identityId = payload.identityId || config.identity;
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
              band: require('../lib/connection/bands').BAND.STREAMING,
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
  node.status({ fill: 'green', shape: 'dot', text: cap('built move') });
  send([{ payload: message }, statusRecord('succeeded', 'built', { message })]);
}

function completeResult(node, send, result, action, message) {
  node.status({ fill: 'green', shape: 'dot', text: cap(action) });
  send([{ payload: { result, message } }, statusRecord(result, action, { message })]);
}

function fail(node, send, err, msg, done) {
  node.status({ fill: 'red', shape: 'ring', text: cap(err.message) });
  send([null, statusRecord('failed', err.message)]);
  done(err);
}

function statusRecord(result, detail, extra = {}) {
  return { node: 'mavlink-move', result, detail, ...extra };
}

function positionFrom(config) {
  return {
    north: config.north,
    east: config.east,
    up: config.up,
    lat: config.lat,
    lon: config.lon,
    alt: config.alt,
  };
}

function velocityFrom(config) {
  return { north: config.vNorth, east: config.vEast, up: config.vUp };
}

function valueFrom(payload, config, key) {
  if (payload[key] !== undefined) return payload[key];
  return config[key] === '' ? undefined : config[key];
}

function cap(text) {
  const s = String(text || '');
  return s.length > BADGE_MAX ? `${s.slice(0, BADGE_MAX - 1)}…` : s;
}
