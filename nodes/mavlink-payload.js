'use strict';

const { buildPayloadMessage } = require('../lib/payload');
const { BAND } = require('../lib/connection/bands');
const { AckWaiter } = require('../lib/command');

const BADGE_MAX = 24;

module.exports = function registerMavlinkPayload(RED) {
  function MavlinkPayloadNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    // At most one COMMAND_ACK wait in flight per node.
    let activeWaiter = null;
    const timeoutMs = config.timeout ? Number(config.timeout) : 10000;
    const maxRetries = config.maxRetries !== undefined && config.maxRetries !== ''
      ? Number(config.maxRetries)
      : 3;

    function cancelWaiter() {
      if (activeWaiter) {
        activeWaiter.cancel();
        activeWaiter = null;
      }
    }

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

        const delivery = config.delivery || 'build';
        if (delivery === 'build') {
          completeBuild(node, emit, built);
          if (done) done();
          return;
        }

        const connectionNode = RED.nodes.getNode(config.connection);
        if (!connectionNode || typeof connectionNode.send !== 'function') {
          throw new Error('mavlink-payload requires a Connection');
        }
        const target = {
          sysid: built.message.fields.target_system,
          compid: built.message.fields.target_component,
        };
        const identityId = config.identity || payload.identityId;

        // Confirm tier for a command-backed verb: send the COMMAND_LONG and
        // wait for its COMMAND_ACK so a later DENIED / TEMPORARILY_REJECTED /
        // timeout can halt the chain (§9). Gimbal-manager setpoints carry no
        // acknowledgement, so they can only ever be sent unconfirmed.
        if (delivery === 'confirm' && built.confirmation === 'command_ack') {
          node.status({ fill: 'blue', shape: 'dot', text: cap(`${built.message.name}…`) });
          cancelWaiter();
          const waiter = new AckWaiter({
            subscribe: (filter, handler) => connectionNode.subscribe(filter, handler),
            sendFn: (confirmation) => {
              connectionNode.send(
                { name: built.message.name, fields: { ...built.message.fields, confirmation } },
                { band: BAND.CONTROL, target, identityId }
              );
            },
            commandId: built.message.fields.command,
            targetSysid: target.sysid,
            targetCompid: target.compid,
            timeoutMs,
            maxRetries,
          });
          activeWaiter = waiter;
          waiter
            .start()
            .then((outcome) => {
              if (activeWaiter === waiter) activeWaiter = null;
              if (outcome.result === 'accepted') {
                completeAck(node, emit, built, outcome);
              } else {
                failAck(node, emit, built, outcome);
              }
              if (done) done();
            })
            .catch((err) => {
              if (activeWaiter === waiter) activeWaiter = null;
              fail(node, emit, err);
              if (done) done(err);
            });
          return;
        }

        // Send tier, or confirm requested on an unconfirmable message.
        connectionNode.send(built.message, { band: BAND.CONTROL, target, identityId });
        const detail = built.confirmation === 'command_ack' ? 'sent' : 'sent (unconfirmed)';
        completeResult(node, emit, 'succeeded', detail, built);
        if (done) done();
      } catch (err) {
        fail(node, emit, err);
        if (done) done(err);
      }
    });

    node.on('close', (done) => {
      cancelWaiter();
      if (done) done();
    });
  }

  RED.nodes.registerType('mavlink-payload', MavlinkPayloadNode);
};

function completeAck(node, emit, built, outcome) {
  node.status({ fill: 'green', shape: 'dot', text: cap(`ack ${built.message.name}`) });
  emit([
    { payload: { result: 'succeeded', message: built.message } },
    {
      payload: statusRecord('succeeded', 'command-ack accepted', {
        confirmation: built.confirmation,
        resultCode: outcome.resultCode,
        confirmedBy: outcome.confirmedBy,
        retries: outcome.retries,
        elapsed: outcome.elapsed,
      }),
    },
  ]);
}

function failAck(node, emit, built, outcome) {
  node.status({ fill: 'red', shape: 'ring', text: cap(`${built.message.name} ${outcome.result}`) });
  node.error(`mavlink-payload: ${built.message.name} ${outcome.result}`);
  emit([
    null,
    {
      payload: statusRecord(outcome.result, outcome.detail || 'command not accepted', {
        confirmation: built.confirmation,
        resultCode: outcome.resultCode,
        confirmedBy: outcome.confirmedBy,
        retries: outcome.retries,
        elapsed: outcome.elapsed,
      }),
    },
  ]);
}

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
