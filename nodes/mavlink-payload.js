'use strict';

const {
  buildPayloadMessage,
  fieldMetaFromBundle,
} = require('../lib/payload');
const { BAND } = require('../lib/connection/bands');
const {
  AckWaiter,
  resolveFrame,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_RETRIES,
} = require('../lib/command');
const {
  resolveDeliveryContext,
  missingConnectionGate,
} = require('../lib/addressing');
const {
  shouldSuppress,
  makeStatusRecord,
  applyActionStatus,
} = require('../lib/delivery');
const { loadMetadata } = require('../lib/metadata/load');
const { resolveCatalogSource } = require('../lib/metadata/admin-catalog');

const FIELD_TIPS_ROUTE = '/mavlink/payload/field-tips';

module.exports = function registerMavlinkPayload(RED) {
  function MavlinkPayloadNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    // At most one COMMAND_ACK wait in flight per node.
    let activeWaiter = null;
    const timeoutMs = config.timeout ? Number(config.timeout) : DEFAULT_TIMEOUT_MS;
    const maxRetries = config.maxRetries !== undefined && config.maxRetries !== ''
      ? Number(config.maxRetries)
      : DEFAULT_MAX_RETRIES;
    const delivery = config.delivery;
    const connAtDeploy = delivery === 'build' ? null : RED.nodes.getNode(config.connection);
    missingConnectionGate(node, delivery, connAtDeploy);

    function cancelWaiter() {
      if (activeWaiter) {
        activeWaiter.cancel();
        activeWaiter = null;
      }
    }

    node.on('input', (msg, send, done) => {
      try {
        if (shouldSuppress(msg)) {
          done();
          return;
        }

        const payload = msg.payload ?? {};
        // Payload: compidFromConfig keeps the compid field authoritative even
        // under a companion identity — compid addresses a payload device, not
        // the autopilot (DESIGN.md §6 spec'd exception).
        // Connection is the deploy-time bind — do not re-getNode.
        const { connectionNode, target, identityId } = resolveDeliveryContext(RED, {
          delivery,
          config,
          payload,
          connectionNode: connAtDeploy,
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
          completeBuild(node, send, built);
          done();
          return;
        }

        if (!connectionNode) {
          // Deploy gate already badged — Node-RED Catch via done(err) only.
          done(new Error('mavlink-payload: no connection for wire delivery'));
          return;
        }

        // Confirm tier for a command-backed verb: send the COMMAND_LONG and
        // wait for its COMMAND_ACK so a later DENIED / TEMPORARILY_REJECTED /
        // timeout can halt the chain (§9). Gimbal-manager setpoints carry no
        // acknowledgement, so they can only ever be sent unconfirmed.
        if (delivery === 'confirm' && built.confirmation === 'command_ack') {
          applyActionStatus(node, 'sending', `${built.message.name}…`);
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
                completeAck(node, send, built, outcome);
                done();
              } else {
                failAck(node, send, built, outcome, msg, done);
              }
            })
            .catch((err) => {
              if (activeWaiter === waiter) activeWaiter = null;
              fail(node, send, err, msg, done);
            });
          return;
        }

        // Send tier, or confirm requested on an unconfirmable message.
        connectionNode.send(built.message, { band: BAND.CONTROL, target, identityId });
        const detail = built.confirmation === 'command_ack' ? 'sent' : 'sent (unconfirmed)';
        completeResult(node, send, 'succeeded', detail, built);
        done();
      } catch (err) {
        fail(node, send, err, msg, done);
      }
    });

    node.on('close', (done) => {
      cancelWaiter();
      done();
    });
  }

  if (!MavlinkPayloadNode._fieldTipsRouteRegistered && RED.httpAdmin && RED.auth) {
    const { api: metadataApi } = loadMetadata('mavlink-payload', RED);

    /**
     * GET /mavlink/payload/field-tips?topic=&verb=&path=&vehicle=&dialect=
     * Returns `{ fields: { sequence: { description, units }, … } }` joined from
     * PAYLOAD_RECIPES + the dialect bundle (DESIGN.md §6). Soft notices (not
     * hard 404s) when the profile is undeployed — editor tips stay usable.
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
          const source = resolveCatalogSource(RED, metadataApi, req.query || {}, { soft: true });
          if (source.kind === 'empty') {
            return res.json({
              dialect: source.dialect,
              fields: {},
              notice: source.notice,
            });
          }
          if (source.kind === 'error') {
            // getDialect / resolve failures can include filesystem paths —
            // keep the client response generic (same posture as the catch below).
            if (RED.log && typeof RED.log.error === 'function') {
              RED.log.error(
                `[mavlink-payload] field-tips unavailable: ${source.body.error}`
              );
            }
            return res.status(400).json({
              fields: {},
              error: 'field tips unavailable',
            });
          }
          let bundle;
          let dialect;
          if (source.kind === 'bundle') {
            bundle = source.bundle;
            dialect = source.dialect;
          } else {
            const known = metadataApi.knownDialects();
            if (!known.includes(source.dialect)) {
              return res.json({
                dialect: source.dialect,
                fields: {},
                notice: `unknown dialect ${JSON.stringify(source.dialect)}`,
              });
            }
            bundle = metadataApi.loadBundled(source.dialect);
            dialect = source.dialect;
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

function completeAck(node, send, built, outcome) {
  applyActionStatus(node, 'ok', `ack ${built.message.name}`);
  send([
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

function failAck(node, send, built, outcome, msg, done) {
  applyActionStatus(node, 'error', `${built.message.name} ${outcome.result}`);
  send([
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

function completeBuild(node, send, built) {
  applyActionStatus(node, 'ok', 'built payload');
  send([
    { payload: built.message },
    statusRecord('succeeded', 'built', { confirmation: built.confirmation }),
  ]);
}

function completeResult(node, send, result, detail, built) {
  applyActionStatus(node, 'ok', detail);
  send([
    { payload: { result, message: built.message } },
    statusRecord(result, detail, { confirmation: built.confirmation }),
  ]);
}

function fail(node, send, err, msg, done) {
  applyActionStatus(node, 'error', err.message);
  send([null, statusRecord('failed', err.message)]);
  done(err);
}

function statusRecord(result, detail, extra = {}) {
  return makeStatusRecord({ node: 'mavlink-payload', result, detail, ...extra });
}
