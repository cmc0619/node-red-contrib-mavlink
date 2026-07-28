'use strict';

const { buildMoveMessage, createMoveStream } = require('../lib/move');
const { resolveActionTarget, profileFromVehicleNode } = require('../lib/addressing/resolve');

const BADGE_MAX = 24;

module.exports = function registerMavlinkMove(RED) {
  function MavlinkMoveNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    let stream = null;

    node.on('input', (msg, send, done) => {
      const emit = send || ((messages) => node.send(messages));
      try {
        if (msg.payload === false) {
          if (done) done();
          return;
        }
        if (msg.payload && msg.payload._mavlinkStatus) {
          emit([null, { payload: statusRecord('rejected', 'status input refused') }]);
          if (done) done();
          return;
        }

        const delivery = config.delivery || 'build';
        const connectionNode = delivery !== 'build'
          ? RED.nodes.getNode(config.connection)
          : null;
        const payload = objectPayload(msg.payload);

        const profile = delivery === 'build'
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
          completeBuild(node, emit, message);
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
            completeResult(node, emit, 'succeeded', 'streaming', message);
          } else {
            connectionNode.send(message, {
              band: require('../lib/connection/bands').BAND.STREAMING,
              target: options.target,
              identityId: options.identityId,
            });
            completeResult(node, emit, 'succeeded', 'sent', message);
          }
        }
        if (done) done();
      } catch (err) {
        fail(node, emit, err);
        if (done) done(err);
      }
    });

    node.on('close', (done) => {
      if (stream) stream.stop();
      if (done) done();
    });
  }

  RED.nodes.registerType('mavlink-move', MavlinkMoveNode);
};

function completeBuild(node, emit, message) {
  node.status({ fill: 'green', shape: 'dot', text: cap('built move') });
  emit([{ payload: message }, { payload: statusRecord('succeeded', 'built', { message }) }]);
}

function completeResult(node, emit, result, action, message) {
  node.status({ fill: 'green', shape: 'dot', text: cap(action) });
  emit([{ payload: { result, message } }, { payload: statusRecord(result, action, { message }) }]);
}

function fail(node, emit, err) {
  node.status({ fill: 'red', shape: 'ring', text: cap(err.message) });
  node.error(err);
  emit([null, { payload: statusRecord('failed', err.message) }]);
}

function statusRecord(result, detail, extra = {}) {
  return { _mavlinkStatus: true, node: 'mavlink-move', result, detail, ...extra };
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

function objectPayload(payload) {
  return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
}

function cap(text) {
  const s = String(text || '');
  return s.length > BADGE_MAX ? `${s.slice(0, BADGE_MAX - 1)}…` : s;
}
