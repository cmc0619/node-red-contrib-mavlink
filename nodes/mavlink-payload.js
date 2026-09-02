'use strict';

const {
  buildPayloadMessage,
  fieldMetaFromBundle,
  carrierMattersFor,
} = require('../lib/payload');
const { BAND } = require('../lib/connection/bands');
const {
  AckWaiter,
  sendFnFor,
  cancelSlot,
  resolveFrame,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_RETRIES,
} = require('../lib/command');
const {
  resolveDeliveryContext,
  numberOr,
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

    // At most one COMMAND_ACK wait in flight per node (lib/command cancelSlot).
    const waiterSlot = cancelSlot();
    const delivery = config.delivery;
    const connAtDeploy = RED.nodes.getNode(config.connection);

    node.on('input', (msg, send, done) => {
      try {
        if (shouldSuppress(msg)) {
          done();
          return;
        }

        // Blank keeps the library default; the editor's number validator owns
        // the rest (§14: a finite-number check on operator input is a guardrail).
        const timeoutMs = numberOr(config.timeout, DEFAULT_TIMEOUT_MS);
        const maxRetries = numberOr(config.maxRetries, DEFAULT_MAX_RETRIES);

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

        const builtCmd = buildPayloadMessage({
          topic: payload.topic === undefined ? config.topic : payload.topic,
          verb: payload.verb === undefined ? config.verb : payload.verb,
          path: payload.path === undefined ? config.path : payload.path,
          target,
          values: payload.values === undefined ? config.values : payload.values,
          // Required for command-backed verbs (§9): a non-member carrier
          // selects no builder (§5), so the message ships undefined and
          // craters at the tier that touches it.
          carrier: payload.sendAs === undefined ? config.sendAs : payload.sendAs,
          frame: resolveFrame(payload.mavFrame, config.frame),
        });

        /**
         * Send a command-backed verb and wait for its COMMAND_ACK. The ack,
         * whatever it says, is the result (§9): a wrong-carrier code is reported
         * like any other rejection and the flow decides what to send next.
         */
        async function awaitAck(built) {
          // A new input supersedes the previous input's wait.
          waiterSlot.cancel();
          applyActionStatus(node, 'sending', `${built.message.name}…`);
          const waiter = new AckWaiter({
            subscribe: (filter, handler) => connectionNode.subscribe(filter, handler),
            // Only the LONG carrier has a confirmation byte; COMMAND_INT must
            // not grow one on retries (§9, lib/command sendFnFor).
            sendFn: sendFnFor(connectionNode, built.message, { band: BAND.CONTROL, target, identityId }),
            commandId: built.message.fields.command,
            targetSystem: target.sysid,
            targetComponent: target.compid,
            // Ack attribution (§9): ignore an ack explicitly addressed to a
            // different GCS on a shared link.
            sourceIds: connectionNode.resolveSourceIds(identityId),
            timeoutMs,
            maxRetries,
          });
          waiterSlot.active = waiter;
          let outcome;
          try {
            outcome = await waiter.start();
          } finally {
            waiterSlot.release(waiter);
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
        }

        // Affirmative dispatch on the tier (§5): a non-member matches no case,
        // nothing reaches the wire, and the input completes as a no-op — the
        // same shape as State's mode. No connection guard on the wire cases:
        // the editor is the protector, and a missing Connection craters at
        // `.send` / `.subscribe` like any other absent config node.
        switch (delivery) {
          case 'build':
            completeBuild(node, send, builtCmd);
            break;
          case 'confirm':
            // Wait for the COMMAND_ACK so a DENIED / TEMPORARILY_REJECTED /
            // timeout can halt the chain (§9). Gimbal-manager setpoints carry
            // no acknowledgement, so they fall through and send unconfirmed.
            if (builtCmd.confirmation === 'command_ack') {
              awaitAck(builtCmd).catch((err) => failInput(node, send, err, done));
              return;
            }
            // falls through
          case 'send': {
            connectionNode.send(builtCmd.message, { band: BAND.CONTROL, target, identityId });
            const detail = builtCmd.confirmation === 'command_ack' ? 'sent' : 'sent (unconfirmed)';
            completeResult(node, send, 'succeeded', detail, builtCmd);
            break;
          }
          default: break; // This space intentionally left blank (§5)
        }
        done();
      } catch (err) {
        failInput(node, send, err, done);
      }
    });

    node.on('close', (done) => {
      waiterSlot.cancel();
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
        let path = typeof req.query.path === 'string' ? req.query.path.trim() : '';
        // Editor preview only: a gimbal-aim tips request before a path member is
        // picked still shows the legacy fields. The `|| 'legacy'` default moved
        // out of recipeFor (so the runtime craters on a blank path) to here,
        // where a preview default belongs — the editor is the validator layer.
        if (topic === 'gimbal' && verb === 'aim' && !path) path = 'legacy';
        if (!topic || !verb) {
          return res.json({ fields: {}, dialect: '' });
        }
        if (!metadataApi) {
          return res.status(503).json({ fields: {}, error: 'metadata unavailable' });
        }
        try {
          const source = resolveCatalogSource(RED, metadataApi, req.query || {}, { soft: true });
          let bundle;
          let dialect;
          switch (source.kind) {
            case 'empty':
              return res.json({
                dialect: source.dialect,
                fields: {},
                notice: source.notice,
              });
            case 'error':
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
            case 'bundle':
              bundle = source.bundle;
              dialect = source.dialect;
              break;
            case 'dialect': {
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
              break;
            }
            default: break; // This space intentionally left blank (§5)
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

// The outcome fields both ack records carry — one spelling so the success and
// failure halves of the record contract cannot diverge.
function ackFields(built, outcome) {
  return {
    confirmation: built.confirmation,
    resultCode: outcome.resultCode,
    resultParam2: outcome.resultParam2,
    confirmedBy: outcome.confirmedBy,
    retries: outcome.retries,
    elapsed: outcome.elapsed,
  };
}

function completeAck(node, send, built, outcome) {
  applyActionStatus(node, 'ok', `ack ${built.message.name}`);
  send([
    { payload: { result: 'succeeded', message: built.message } },
    makeStatusRecord(node.type, {
      result: 'succeeded',
      detail: 'command-ack accepted',
      ...ackFields(built, outcome),
    }),
  ]);
}

function failAck(node, send, built, outcome, msg, done) {
  applyActionStatus(node, 'error', `${built.message.name} ${outcome.result}`);
  send([
    null,
    makeStatusRecord(node.type, {
      result: outcome.result,
      detail: outcome.detail,
      ...ackFields(built, outcome),
    }),
  ]);
  done();
}

function completeBuild(node, send, built) {
  applyActionStatus(node, 'ok', 'built payload');
  send([
    { payload: built.message },
    makeStatusRecord(node.type, { result: 'succeeded', detail: 'built', confirmation: built.confirmation }),
  ]);
}

function completeResult(node, send, result, detail, built) {
  applyActionStatus(node, 'ok', detail);
  send([
    { payload: { result, message: built.message } },
    makeStatusRecord(node.type, { result, detail, confirmation: built.confirmation }),
  ]);
}
