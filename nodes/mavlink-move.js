'use strict';

const { buildMoveMessage, createMoveStream } = require('../lib/move');

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

        const connectionNode = RED.nodes.getNode(config.connection);
        const payload = objectPayload(msg.payload);
        const message = buildMoveMessage({
          mode: payload.mode || config.mode || 'local-position',
          target: targetFrom(config, payload, connectionNode),
          position: payload.position || positionFrom(config),
          velocity: payload.velocity || velocityFrom(config),
          yaw: valueFrom(payload, config, 'yaw'),
          yawRate: valueFrom(payload, config, 'yawRate'),
          timeBootMs: payload.timeBootMs || config.timeBootMs || 0,
        });

        const delivery = config.delivery || 'build';
        if (delivery === 'build') {
          completeBuild(node, emit, message);
        } else {
          if (!connectionNode || typeof connectionNode.send !== 'function') {
            throw new Error('mavlink-move requires a Connection for send/stream delivery');
          }
          const options = {
            connection: connectionNode,
            message,
            target: targetFrom(config, payload, connectionNode),
            identityId: config.identity || payload.identityId,
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

/**
 * Resolve the move target from payload, node config, the Connection's Vehicle
 * Profile, then a hardcoded 1.
 *
 * Precedence: payload.target → node config → `connNode.vehicle` → 1.
 * A configured 0 is a legitimate broadcast address and must survive (not fall
 * through the `||` chain).
 *
 * @param {object} config
 * @param {object} payload
 * @param {object|null|undefined} connNode  Connection config node (may be absent for Build)
 * @returns {{sysid: number, compid: number}}
 */
function targetFrom(config, payload, connNode) {
  const target = payload.target || {};
  return {
    sysid: Number(firstDefined(
      target.sysid,
      config.targetSystem,
      connNode && connNode.vehicle && connNode.vehicle.targetSysid,
      1
    )),
    compid: Number(firstDefined(
      target.compid,
      config.targetComponent,
      connNode && connNode.vehicle && connNode.vehicle.targetCompid,
      1
    )),
  };
}

function firstDefined(...values) {
  for (const v of values) {
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
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
