'use strict';

const {
  buildPayloadMessage,
  fieldMetaFromBundle,
  carrierMattersFor,
} = require('../lib/payload');
const { BAND } = require('../lib/connection/bands');
const { ackWaiterFor, ackRecordFields, cancelSlot } = require('../lib/command/ack');
const { resolveFrame } = require('../lib/command/carrier');
const { resolveDeliveryContext } = require('../lib/addressing/delivery-context');
const {
  shouldSuppress,
  makeStatusRecord,
  applyActionStatus,
  failInput,
} = require('../lib/delivery');
const { loadBundled } = require('../lib/metadata/bundled');
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
    const name = meta.enum;
    if (!name || out[name]) continue;
    out[name] = bundle.enums[name].entries;
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

        // The editor owns the defaults and the number rings.
        const timeoutMs = Number(config.timeoutMs);
        const maxRetries = Number(config.maxRetries);

        const payload = msg.payload;
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
          applyActionStatus(node, 'sending', `${built.message.name}…`);
          const outcome = await waiterSlot.run(ackWaiterFor(connectionNode, built.message, {
            band: BAND.CONTROL,
            target,
            identityId,
            timeoutMs,
            maxRetries,
          }));
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
            failAck(node, send, built, outcome, done);
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
            switch (builtCmd.confirmation) {
              case 'command_ack':
                awaitAck(builtCmd).catch((err) => failInput(node, send, err, done));
                return;
              default: break; // This space intentionally left blank (§5)
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
        // The dialog sends every field of its selection, path included — it
        // supplies `legacy` itself while the gimbal path is still unpicked.
        const { topic, verb, path } = req.query;
        try {
          const source = resolveCatalogSource(RED, req.query, { soft: true });
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
              // getDialect / resolve failures land in the catch below with
              // the rest: logged server-side, answered generic.
              // eslint-disable-next-line no-restricted-syntax -- §0 rule 3: a Vehicle Profile that is not deployed is runtime state
              throw new Error(source.body.error);
            case 'bundle':
              bundle = source.bundle;
              dialect = source.dialect;
              break;
            case 'dialect':
              bundle = loadBundled(source.dialect);
              dialect = source.dialect;
              break;
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
          // and keep the client response generic.
          RED.log.error(`[mavlink-payload] field-tips unavailable: ${err.message}`);
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
    makeStatusRecord(node.type, {
      ...ackRecordFields(outcome),
      confirmation: built.confirmation,
      result: 'succeeded',
      detail: 'command-ack accepted',
    }),
  ]);
}

function failAck(node, send, built, outcome, done) {
  applyActionStatus(node, 'error', `${built.message.name} ${outcome.result}`);
  send([
    null,
    makeStatusRecord(node.type, {
      ...ackRecordFields(outcome),
      confirmation: built.confirmation,
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
