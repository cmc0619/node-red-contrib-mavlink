'use strict';

const { buildPayloadMessage } = require('../lib/payload');
const { BAND } = require('../lib/connection/bands');

const BADGE_MAX = 24;

module.exports = function registerMavlinkPayload(RED) {
  function MavlinkPayloadNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

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

        const payload = objectPayload(msg.payload);
        const built = buildPayloadMessage({
          topic: payload.topic || config.topic || 'camera',
          verb: payload.verb || config.verb || 'photo',
          path: payload.path || config.path || 'legacy',
          target: {
            sysid: Number((payload.target && payload.target.sysid) || config.targetSystem || 1),
            compid: Number((payload.target && payload.target.compid) || config.targetComponent || 1),
          },
          values: payload.values || valuesFrom(config),
        });

        if ((config.delivery || 'build') === 'build') {
          completeBuild(node, emit, built);
        } else {
          const connectionNode = RED.nodes.getNode(config.connection);
          if (!connectionNode || typeof connectionNode.send !== 'function') {
            throw new Error('mavlink-payload requires a Connection');
          }
          connectionNode.send(built.message, {
            band: BAND.CONTROL,
            target: {
              sysid: built.message.fields.target_system,
              compid: built.message.fields.target_component,
            },
            identityId: config.identity || payload.identityId,
          });
          completeResult(node, emit, 'succeeded', 'sent', built);
        }
        if (done) done();
      } catch (err) {
        fail(node, emit, err);
        if (done) done(err);
      }
    });
  }

  RED.nodes.registerType('mavlink-payload', MavlinkPayloadNode);
};

function valuesFrom(config) {
  return {
    count: config.count,
    interval: config.interval,
    mode: config.modeValue,
    distance: config.distance,
    pitch: config.pitch,
    roll: config.roll,
    yaw: config.yaw,
    pitchRate: config.pitchRate,
    yawRate: config.yawRate,
    servo: config.servo,
    pwm: config.pwm,
    period: config.period,
    instance: config.instance,
    action: config.actionValue,
    length: config.length,
    rate: config.rate,
  };
}

function completeBuild(node, emit, built) {
  node.status({ fill: 'green', shape: 'dot', text: cap('built payload') });
  emit([
    { payload: built.message },
    { payload: statusRecord('succeeded', 'built', { confirmation: built.confirmation }) },
  ]);
}

function completeResult(node, emit, result, detail, built) {
  node.status({ fill: 'green', shape: 'dot', text: cap(detail) });
  emit([
    { payload: { result, message: built.message } },
    { payload: statusRecord(result, detail, { confirmation: built.confirmation }) },
  ]);
}

function fail(node, emit, err) {
  node.status({ fill: 'red', shape: 'ring', text: cap(err.message) });
  node.error(err);
  emit([null, { payload: statusRecord('failed', err.message) }]);
}

function statusRecord(result, detail, extra = {}) {
  return { _mavlinkStatus: true, node: 'mavlink-payload', result, detail, ...extra };
}

function objectPayload(payload) {
  return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
}

function cap(text) {
  const s = String(text || '');
  return s.length > BADGE_MAX ? `${s.slice(0, BADGE_MAX - 1)}…` : s;
}
