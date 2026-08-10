'use strict';

const {
  buildPayloadMessage,
  fieldMetaFromBundle,
  carrierMattersFor,
} = require('../lib/payload');
const { BAND } = require('../lib/connection/bands');
const {
  AckWaiter,
  resolveFrame,
  carrierWantedBy,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_RETRIES,
} = require('../lib/command');
const {
  resolveDeliveryContext,
  applyConnectionStatus,
} = require('../lib/addressing');
const {
  shouldSuppress,
  makeStatusRecord,
  applyActionStatus,
  failInput,
} = require('../lib/delivery');
const { loadMetadata } = require('../lib/metadata/load');
const { resolveCatalogSource } = require('../lib/metadata/admin-catalog');

const FIELD_TIPS_ROUTE = '/mavlink/payload/field-tips';

/**
 * Entries for every enum the form's fields reference, so the dialog can build
 * its selects from the dialect instead of a baked table (§6).
 *
 * @param {object} bundle  DialectBundle
 * @param {Object<string, {enum?: string}>} fields
 * @returns {Object<string, Array>}
 */
function enumsForFields(bundle, fields) {
  const out = {};
  for (const meta of Object.values(fields)) {
    const name = meta && meta.enum;
    if (!name || out[name]) continue;
    const found = bundle.enums && bundle.enums[name];
    if (found) out[name] = found.entries || [];
  }
  return out;
}

module.exports = function registerMavlinkPayload(RED) {
  function MavlinkPayloadNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    // At most one COMMAND_ACK wait in flight per node.
    let activeWaiter = null;
    const timeoutMs = config.timeout === '' ? DEFAULT_TIMEOUT_MS : Number(config.timeout);
    const maxRetries = config.maxRetries === '' ? DEFAULT_MAX_RETRIES : Number(config.maxRetries);
    const delivery = config.delivery;
    const connAtDeploy = RED.nodes.getNode(config.connection);
    applyConnectionStatus(node, delivery !== 'build', connAtDeploy);

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
        const { connectionNode, target, identityId } = resolveDeliveryContext(RED, {
          delivery,
          config,
          payload,
          connectionNode: connAtDeploy,
          compidFromConfig: true,
        });

        /** The recipe rendered for one carrier. Carrier is an input to the
         *  builder, so a swap re-runs this rather than converting by hand. */
        function buildFor(carrier) {
          return buildPayloadMessage({
            topic: payload.topic || config.topic,
            verb: payload.verb || config.verb,
            path: payload.path || config.path,
            target,
            values: payload.values || config.values || {},
            // Required for command-backed verbs (§9): the builder throws when a
            // MAV_CMD verb arrives without a carrier choice.
            carrier,
            frame: resolveFrame(payload.mavFrame, config.frame),
          });
        }

        const carrierChosen = payload.carrier || config.carrier;
        const built = buildFor(carrierChosen);

        if (delivery === 'build') {
          completeBuild(node, send, built);
          done();
          return;
        }

        if (!connectionNode) {
          throw new Error('mavlink-payload requires a Connection');
        }
        /**
         * Send a command-backed verb and wait for its COMMAND_ACK, resending once
         * in the other carrier if the vehicle answers COMMAND_INT_ONLY (8) or
         * COMMAND_LONG_ONLY (7) — §9 "resend in the other form", the same rule
         * mavlink-command follows, via the same `carrierWantedBy`.
         *
         * This matters more than it looks: the editor shows the Carrier control
         * only for a verb whose command carries a location (gimbal ROI-set), and
         * pins the other 13 command verbs to COMMAND_INT. An operator has no way
         * to pick LONG for those, so on a LONG-only vehicle the swap is the only
         * thing standing between them and a flat refusal.
         *
         * At most one swap per message. A second wrong-carrier ack — the same code
         * again or a contradictory one — fails loud rather than ping-ponging.
         */
        function awaitAck(built, carrierUsed, swapped) {
          applyActionStatus(node, 'sending', `${built.message.name}…`);
          cancelWaiter();
          const waiter = new AckWaiter({
            subscribe: (filter, handler) => connectionNode.subscribe(filter, handler),
            sendFn: (confirmation) => {
              // Only the LONG carrier has a confirmation byte; COMMAND_INT must
              // not grow one on retries (§9).
              const fields = built.message.name === 'COMMAND_LONG'
                ? { ...built.message.fields, confirmation }
                : built.message.fields;
              connectionNode.send(
                { name: built.message.name, fields },
                { band: BAND.CONTROL, target, identityId }
              );
            },
            commandId: built.message.fields.command,
            targetSystem: target.sysid,
            targetComponent: target.compid,
            // Ack attribution (§9): ignore an ack explicitly addressed to a
            // different GCS on a shared link.
            sourceIds: connectionNode.resolveSourceIds(identityId),
            timeoutMs,
            maxRetries,
          });
          activeWaiter = waiter;
          waiter
            .start()
            .then((outcome) => {
              if (activeWaiter === waiter) activeWaiter = null;
              const wanted = carrierWantedBy(outcome.resultCode);
              if (wanted && wanted !== carrierUsed && !swapped) {
                node.warn(
                  `mavlink-payload: ${built.message.name} rejected as ` +
                    `${outcome.result} — resending as COMMAND_${wanted.toUpperCase()} ` +
                    '(§9 carrier swap)'
                );
                awaitAck(buildFor(wanted), wanted, true);
                return;
              }
              if (outcome.result === 'cancelled') {
                // A redeploy cancelled the wait (see the close handler). Finish
                // quietly on a node that is going away — raising here would
                // trip a Catch node wired for "payload failed → failsafe" on a
                // mere deploy, the rule mavlink-mission already follows.
                done();
              } else if (outcome.result === 'accepted') {
                completeAck(node, send, built, outcome);
                done();
              } else {
                failAck(node, send, built, outcome, msg, done);
              }
            })
            .catch((err) => {
              if (activeWaiter === waiter) activeWaiter = null;
              failInput(node, send, err, done);
            });
        }

        // Confirm tier for a command-backed verb: wait for the COMMAND_ACK so
        // a DENIED / TEMPORARILY_REJECTED / timeout can halt the chain (§9).
        // Gimbal-manager setpoints carry no acknowledgement, so they can only
        // ever be sent unconfirmed and fall through below.
        if (delivery === 'confirm' && built.confirmation === 'command_ack') {
          awaitAck(built, carrierChosen);
          return;
        }

        // Send tier, or confirm requested on an unconfirmable message.
        connectionNode.send(built.message, { band: BAND.CONTROL, target, identityId });
        const detail = built.confirmation === 'command_ack' ? 'sent' : 'sent (unconfirmed)';
        completeResult(node, send, 'succeeded', detail, built);
        done();
      } catch (err) {
        failInput(node, send, err, done);
      }
    });

    node.on('close', (done) => {
      cancelWaiter();
      done();
    });
  }

  if (RED.httpAdmin && RED.auth) {
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
          // The field set IS the form: keys are the rows the dialog renders,
          // values carry label/units/range/enum so nothing is baked into the
          // editor. `carrierMatters` is false unless the command carries a
          // location, in which case COMMAND_INT vs COMMAND_LONG is invisible.
          const fields = fieldMetaFromBundle(bundle, topic, verb, path);
          return res.json({
            dialect,
            fields,
            carrierMatters: carrierMattersFor(bundle, topic, verb, path),
            enums: enumsForFields(bundle, fields),
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
      resultParam2: outcome.resultParam2,
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
      resultParam2: outcome.resultParam2,
      confirmedBy: outcome.confirmedBy,
      retries: outcome.retries,
      elapsed: outcome.elapsed,
    }),
  ]);
  done(new Error(`mavlink-payload: ${built.message.name} ${outcome.result}`));
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

function statusRecord(result, detail, extra = {}) {
  return makeStatusRecord({ node: 'mavlink-payload', result, detail, ...extra });
}
