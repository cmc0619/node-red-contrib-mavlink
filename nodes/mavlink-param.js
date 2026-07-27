'use strict';

const {
  buildParamMessage,
  createParamListCollector,
  matchesParamEcho,
} = require('../lib/param');
const { BAND } = require('../lib/connection/bands');

const BADGE_MAX = 24;

module.exports = function registerMavlinkParam(RED) {
  function MavlinkParamNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    let unsubscribe = null;

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
        const request = requestFrom(config, payload);
        const message = buildParamMessage(request);
        const delivery = config.delivery || 'build';
        if (delivery === 'build') {
          completeBuild(node, emit, message);
        } else {
          const connectionNode = requireConnection(RED, config.connection);
          connectionNode.send(message, {
            band: request.action === 'request-list' ? BAND.BULK : BAND.CONTROL,
            target: request.target,
            identityId: config.identity || payload.identityId,
          });
          if (delivery === 'confirm' && request.action === 'set') {
            unsubscribe = connectionNode.subscribe({ message: 'PARAM_VALUE' }, (decoded) => {
              if (!matchesParamEcho(request, decoded)) return;
              if (unsubscribe) unsubscribe();
              unsubscribe = null;
              completeResult(node, emit, 'succeeded', 'echo-confirmed', decoded);
            });
          } else if (delivery === 'collect' && request.action === 'request-list') {
            const collector = createParamListCollector();
            unsubscribe = connectionNode.subscribe({ message: 'PARAM_VALUE' }, (decoded) => {
              const params = collector.accept(decoded);
              if (!params) return;
              if (unsubscribe) unsubscribe();
              unsubscribe = null;
              completeResult(node, emit, 'succeeded', 'list-complete', params);
            });
          } else {
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
      if (unsubscribe) unsubscribe();
      if (done) done();
    });
  }

  RED.nodes.registerType('mavlink-param', MavlinkParamNode);
};

function requestFrom(config, payload) {
  return {
    action: payload.action || config.action || 'read',
    target: {
      sysid: Number((payload.target && payload.target.sysid) || config.targetSystem || 1),
      compid: Number((payload.target && payload.target.compid) || config.targetComponent || 1),
    },
    paramId: payload.paramId || config.paramId,
    paramIndex: payload.paramIndex || config.paramIndex,
    value: payload.value !== undefined ? payload.value : config.value,
    paramType: payload.paramType || config.paramType || 'MAV_PARAM_TYPE_REAL32',
    firmware: payload.firmware || config.firmware || 'ardupilot',
  };
}

function requireConnection(RED, id) {
  const node = RED.nodes.getNode(id);
  if (!node || typeof node.send !== 'function') throw new Error('mavlink-param requires a Connection');
  return node;
}

function completeBuild(node, emit, message) {
  node.status({ fill: 'green', shape: 'dot', text: cap('built param') });
  emit([{ payload: message }, { payload: statusRecord('succeeded', 'built', { message }) }]);
}

function completeResult(node, emit, result, detail, payload) {
  node.status({ fill: 'green', shape: 'dot', text: cap(detail) });
  emit([{ payload }, { payload: statusRecord(result, detail, { payload }) }]);
}

function fail(node, emit, err) {
  node.status({ fill: 'red', shape: 'ring', text: cap(err.message) });
  node.error(err);
  emit([null, { payload: statusRecord('failed', err.message) }]);
}

function statusRecord(result, detail, extra = {}) {
  return { _mavlinkStatus: true, node: 'mavlink-param', result, detail, ...extra };
}

function objectPayload(payload) {
  return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
}

function cap(text) {
  const s = String(text || '');
  return s.length > BADGE_MAX ? `${s.slice(0, BADGE_MAX - 1)}…` : s;
}
