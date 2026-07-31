'use strict';

const {
  buildPayloadMessage,
  fieldMetaFromBundle,
} = require('../lib/payload');
const { BAND } = require('../lib/connection/bands');
const { AckWaiter, resolveFrame } = require('../lib/command');
const {
  resolveActionTarget,
  profileFromVehicleNode,
} = require('../lib/addressing/resolve');
const {
  shouldSuppress,
} = require('../lib/delivery');

const BADGE_MAX = 24;
const FIELD_TIPS_ROUTE = '/mavlink/payload/field-tips';

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
        if (shouldSuppress(msg)) {
          if (done) done();
          return;
        }

        const delivery = config.delivery;
        const connectionNode = delivery !== 'build'
          ? RED.nodes.getNode(config.connection)
          : null;
        const payload = msg.payload ?? {};

        const profile = delivery === 'build'
          ? (config.dialect === '__vehicle'
            ? profileFromVehicleNode(RED.nodes.getNode(config.vehicle))
            : null)
          : (connectionNode && connectionNode.vehicle) || null;
        const identityNode = delivery === 'build'
          ? null
          : RED.nodes.getNode(payload.identityId || config.identity);

        // Payload: compidFromConfig keeps the compid field authoritative even
        // under a companion identity — compid addresses a payload device, not
        // the autopilot (DESIGN.md §6 spec'd exception).
        const target = resolveActionTarget({
          payloadTarget: payload.target,
          configSysid: config.targetSystem,
          configCompid: config.targetComponent,
          identityNode,
          profile,
          compidFromConfig: true,
        });

        const built = buildPayloadMessage({
          topic: payload.topic || config.topic || 'camera',
          verb: payload.verb || config.verb || 'photo',
          path: payload.path || config.path || 'legacy',
          target,
          values: payload.values || valuesFrom(config),
          // Required for command-backed verbs (§9): the builder throws when a
          // MAV_CMD verb arrives without a carrier choice.
          carrier: payload.carrier || config.carrier,
          frame: resolveFrame(payload.mavFrame, config.frame),
        });

        if (delivery === 'build') {
          completeBuild(node, emit, built);
          if (done) done();
          return;
        }

        if (!connectionNode || typeof connectionNode.send !== 'function') {
          throw new Error('mavlink-payload requires a Connection');
        }
        // Payload-first, matching the target derivation above: the runtime
        // override must drive both the source stamp and the derived target.
        const identityId = payload.identityId || config.identity;

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
              // Only the LONG carrier has a confirmation byte; COMMAND_INT
              // must not grow one on retries (§9).
              const fields = built.message.name === 'COMMAND_LONG'
                ? { ...built.message.fields, confirmation }
                : built.message.fields;
              connectionNode.send(
                { name: built.message.name, fields },
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
                if (done) done();
              } else {
                failAck(node, emit, built, outcome, msg, done);
              }
            })
            .catch((err) => {
              if (activeWaiter === waiter) activeWaiter = null;
              fail(node, emit, err, msg, done);
            });
          return;
        }

        // Send tier, or confirm requested on an unconfirmable message.
        connectionNode.send(built.message, { band: BAND.CONTROL, target, identityId });
        const detail = built.confirmation === 'command_ack' ? 'sent' : 'sent (unconfirmed)';
        completeResult(node, emit, 'succeeded', detail, built);
        if (done) done();
      } catch (err) {
        fail(node, emit, err, msg, done);
      }
    });

    node.on('close', (done) => {
      cancelWaiter();
      if (done) done();
    });
  }

  if (!MavlinkPayloadNode._fieldTipsRouteRegistered && RED.httpAdmin && RED.auth) {
    let metadataApi = null;
    try {
      metadataApi = require('../lib/metadata');
    } catch {
      metadataApi = null;
    }

    /**
     * GET /mavlink/payload/field-tips?topic=&verb=&path=&vehicle=&dialect=
     * Returns `{ fields: { sequence: { description, units }, … } }` joined from
     * PAYLOAD_RECIPES + the dialect bundle (DESIGN.md §6).
     */
    RED.httpAdmin.get(
      FIELD_TIPS_ROUTE,
      RED.auth.needsPermission('mavlink.read'),
      (req, res) => {
        const topic = typeof req.query.topic === 'string' ? req.query.topic.trim() : '';
        const verb = typeof req.query.verb === 'string' ? req.query.verb.trim() : '';
        const path = typeof req.query.path === 'string' ? req.query.path.trim() : '';
        if (!topic || !verb) {
          return res.json({ fields: {}, dialect: '' });
        }
        if (!metadataApi) {
          return res.status(503).json({ fields: {}, error: 'metadata unavailable' });
        }
        try {
          const vehicleId = typeof req.query.vehicle === 'string'
            ? req.query.vehicle.trim()
            : '';
          let bundle = null;
          let dialect = '';
          const requested = typeof req.query.dialect === 'string'
            ? req.query.dialect.trim()
            : '';
          if (vehicleId) {
            const vehicleNode = RED.nodes.getNode(vehicleId);
            if (vehicleNode && typeof vehicleNode.getDialect === 'function') {
              bundle = vehicleNode.getDialect();
              dialect = vehicleNode.dialect || (bundle && bundle.dialect) || 'custom';
            } else if (!requested || requested === 'custom') {
              // Custom / undeployed profile — do not invent ardupilotmega tips
              // (Codex #36). Same posture as command/message catalog routes.
              return res.json({
                dialect: requested || '',
                fields: {},
                notice: 'Vehicle Profile not deployed — deploy the flow first',
              });
            }
            // Pre-deploy bundled Vehicle Profile: editor sends vehicle=id plus
            // an allow-listed dialect; load that seed until Deploy creates the
            // runtime node (mirrors mavlink-command.js catalog fallback).
          }
          if (!bundle) {
            const known = metadataApi.knownDialects();
            if (!requested || !known.includes(requested)) {
              return res.json({
                dialect: requested || '',
                fields: {},
                notice: requested
                  ? `unknown dialect ${JSON.stringify(requested)}`
                  : 'no dialect supplied',
              });
            }
            bundle = metadataApi.loadBundled(requested);
            dialect = requested;
          }
          return res.json({
            dialect,
            fields: fieldMetaFromBundle(bundle, topic, verb, path),
          });
        } catch (err) {
          // Bundled load errors can include filesystem paths — log server-side
          // and keep the client response generic (CodeRabbit #36).
          if (RED.log && typeof RED.log.error === 'function') {
            RED.log.error(
              `[mavlink-payload] field-tips unavailable: ${err && err.message ? err.message : String(err)}`
            );
          }
          return res.status(400).json({
            fields: {},
            error: 'field tips unavailable',
          });
        }
      }
    );

    MavlinkPayloadNode._fieldTipsRouteRegistered = true;
  }

  RED.nodes.registerType('mavlink-payload', MavlinkPayloadNode);
};

function completeAck(node, emit, built, outcome) {
  node.status({ fill: 'green', shape: 'dot', text: cap(`ack ${built.message.name}`) });
  emit([
    { payload: { result: 'succeeded', message: built.message } },
    statusRecord('succeeded', 'command-ack accepted', {
      confirmation: built.confirmation,
      resultCode: outcome.resultCode,
      confirmedBy: outcome.confirmedBy,
      retries: outcome.retries,
      elapsed: outcome.elapsed,
    }),
  ]);
}

function failAck(node, emit, built, outcome, msg, done) {
  node.status({ fill: 'red', shape: 'ring', text: cap(`${built.message.name} ${outcome.result}`) });
  emit([
    null,
    statusRecord(outcome.result, outcome.detail || 'command not accepted', {
      confirmation: built.confirmation,
      resultCode: outcome.resultCode,
      confirmedBy: outcome.confirmedBy,
      retries: outcome.retries,
      elapsed: outcome.elapsed,
    }),
  ]);
  done(new Error(`mavlink-payload: ${built.message.name} ${outcome.result}`));
}

function valuesFrom(config) {
  return {
    /* camera photo */
    cameraId: config.cameraId,
    count: config.count,
    interval: config.interval,
    sequence: config.sequence,
    /* camera start/stop video */
    streamId: config.streamId,
    statusFrequency: config.statusFrequency,
    /* camera trigger-distance */
    distance: config.distance,
    shutter: config.shutter,
    trigger: config.trigger,
    /* camera/gimbal set-mode */
    mode: config.modeValue,
    /* gimbal set-mode stabilize */
    stabilizeRoll: config.stabilizeRoll,
    stabilizePitch: config.stabilizePitch,
    stabilizeYaw: config.stabilizeYaw,
    /* gimbal roi-set */
    lat: config.lat,
    lon: config.lon,
    alt: config.alt,
    /* gimbal aim */
    pitch: config.pitch,
    roll: config.roll,
    yaw: config.yaw,
    pitchRate: config.pitchRate,
    yawRate: config.yawRate,
    flags: config.flags,
    gimbalDeviceId: config.gimbalDeviceId,
    /* servo */
    servo: config.servo,
    pwm: config.pwm,
    period: config.period,
    /* release */
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
    statusRecord('succeeded', 'built', { confirmation: built.confirmation }),
  ]);
}

function completeResult(node, emit, result, detail, built) {
  node.status({ fill: 'green', shape: 'dot', text: cap(detail) });
  emit([
    { payload: { result, message: built.message } },
    statusRecord(result, detail, { confirmation: built.confirmation }),
  ]);
}

function fail(node, emit, err, msg, done) {
  node.status({ fill: 'red', shape: 'ring', text: cap(err.message) });
  emit([null, statusRecord('failed', err.message)]);
  done(err);
}

function statusRecord(result, detail, extra = {}) {
  return { node: 'mavlink-payload', result, detail, ...extra };
}

function cap(text) {
  const s = String(text || '');
  return s.length > BADGE_MAX ? `${s.slice(0, BADGE_MAX - 1)}…` : s;
}
