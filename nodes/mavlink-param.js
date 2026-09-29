'use strict';

/**
 * mavlink-param — read one, set one, or request the list (DESIGN.md §3, §9).
 *
 * Param confirmation is echo-based, not COMMAND_ACK: a set is confirmed by the
 * PARAM_VALUE the vehicle broadcasts back, and a list by collecting every
 * PARAM_VALUE up to the advertised count (§9 "Three kinds of confirmation").
 * The waiting exchanges are lib/param's transfer machines — ParamRestore for
 * one set, ParamRead, ParamBackup for the list — the same engines the System
 * node's bundle runs, so every wait re-sends on silence up to Max retries and
 * every value is decoded with the resolved encoding.
 *
 * Chain model (§9):
 *   output 0 — continue: fires only on success (built message / sent message /
 *              confirmed parameter / read parameter / list)
 *   output 1 — status:   progress, and a record on every terminal outcome
 */

const {
  buildParamMessage,
  resolveParamEncoding,
  capabilitiesFromPeer,
} = require('../lib/param');
const { ParamBackup, ParamRestore, ParamRead } = require('../lib/param/backup');
const {
  readParamDefs,
  updateParamDefs,
} = require('../lib/param/defs');
const {
  defsFor: seedDefsFor,
  seedStamp,
  catalogLabel,
} = require('../lib/param/seed');
const { BAND } = require('../lib/connection/bands');
const { valueFrom } = require('../lib/addressing/resolve');
const { cancelSlot } = require('../lib/command/ack');
const {
  makeStatusRecord,
  applyActionStatus,
  onActionInput,
  completeBuild,
} = require('../lib/delivery');
const { resolveDeliveryContext } = require('../lib/addressing/delivery-context');

/** Admin route for the parameter definition catalog. */
const PARAM_DEFS_ROUTE = '/mavlink/param/defs';
const PARAM_DEFS_UPDATE_ROUTE = '/mavlink/param/defs/update';

/** Guard against double-registering the admin route (one per process). */
let _paramDefsRouteRegistered = false;

module.exports = function registerMavlinkParam(RED) {
  if (!_paramDefsRouteRegistered && RED.httpAdmin && RED.auth) {
    RED.httpAdmin.get(
      PARAM_DEFS_ROUTE,
      RED.auth.needsPermission('mavlink.read'),
      async (req, res) => {
        const profileId = req.query.vehicle;

        // Firmware and vehicle family come from the query when the editor sent
        // them, and from the deployed profile otherwise.
        //
        // The query wins deliberately. `getNode` resolves only *deployed*
        // config nodes, so a Vehicle Profile the operator just created — or
        // edited and not yet deployed — is invisible here while being perfectly
        // visible in the editor that sent the request. Preferring the query
        // also means an edited-but-undeployed firmware is honoured rather than
        // answered from the stale deployed value.
        let firmware = req.query.firmware;
        let vehicleFamily = req.query.vehicleFamily;
        if (profileId && (!firmware || !vehicleFamily)) {
          const profile = RED.nodes.getNode(profileId);
          if (profile) {
            firmware = firmware || profile.firmware || '';
            vehicleFamily = vehicleFamily || profile.vehicleFamily || '';
          }
        }

        const seeded = seedDefsFor({ firmware, vehicleFamily });

        /**
         * The seed is the baseline; a profile's downloaded definitions override
         * it id by id, because that download came from the firmware actually
         * being flown while the seed is a snapshot of whenever it was built.
         */
        function merged(downloaded) {
          const out = new Map(seeded);
          for (const [id, def] of downloaded) out.set(id, def);
          return out;
        }

        function answer(map, source) {
          if (map.size > 0) {
            return res.json({
              defs: Object.fromEntries(map),
              source,
              stamp: seedStamp(),
              // Named here rather than in the dialog, because this is where
              // the firmware was actually resolved: the query may have omitted
              // it and been answered from the deployed profile, so only this
              // side knows which document the operator is really looking at.
              catalog: catalogLabel({ firmware, vehicleFamily, count: map.size, source }),
            });
          }
          return res.json({
            defs: {},
            notice: firmware
              ? `No parameter definitions for firmware "${firmware}".`
              : 'Pick a firmware, or a Vehicle Profile, to load parameter definitions.',
          });
        }

        if (!profileId) return answer(seeded, 'seed');

        try {
          const downloaded = await readParamDefs(RED.settings.userDir, profileId);
          return answer(
            downloaded.size ? merged(downloaded) : seeded,
            downloaded.size ? 'profile' : 'seed'
          );
        } catch (err) {
          // A corrupt holding file is the operator's own download: reported,
          // not papered over with the seed (§0). The fix is deleting the file.
          return res.status(500).json({
            defs: {},
            error: `Local parameter definitions are invalid: ${err.message}`,
          });
        }
      }
    );

    RED.httpAdmin.post(
      PARAM_DEFS_UPDATE_ROUTE,
      RED.auth.needsPermission('mavlink.write'),
      async (req, res) => {
        try {
          const result = await updateParamDefs(RED.settings.userDir, req.body.vehicle, req.body.url);
          return res.json({ ok: true, count: result.count });
        } catch (err) {
          return res.status(500).json({ ok: false, error: err.message });
        }
      }
    );
    _paramDefsRouteRegistered = true;
  }

  function MavlinkParamNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    const delivery = config.delivery;
    const connAtDeploy = RED.nodes.getNode(config.connection);

    /**
     * Single-flight: at most one read, set or list waits per node, and a new
     * input cancels the one in flight (lib/command/ack cancelSlot).
     */
    const slot = cancelSlot();
    let closing = false;

    onActionInput(node, async (msg, send, done) => {
      const payload = msg.payload;
      // Concrete Build dialects carry firmware from the editor (no target rung).
      const {
        connectionNode: connNode,
        profile,
        target,
        identityId,
      } = resolveDeliveryContext(RED, {
        delivery,
        config,
        payload,
        connectionNode: connAtDeploy,
        buildFirmwareProfile: true,
      });

      const action = valueFrom(payload, config, 'action');

      /**
       * The request, its encoding resolved from the msg override, then the
       * peer's AUTOPILOT_VERSION capabilities, then the named firmware
       * (DESIGN.md §11). Build has no peer table to ask.
       *
       * @param {number|string|undefined} capabilities
       * @returns {object}
       */
      const requestWith = (capabilities) => requestFrom(config, payload, target, resolveParamEncoding({
        encoding: payload.paramEncoding,
        capabilities,
        firmware: valueFrom(payload, profile, 'firmware'),
      }));
      const wireRequest = () => requestWith(capabilitiesFromPeer(connNode, target));

      /**
       * Affirmative dispatch on the tier and action (§5): a pair the
       * editor's rings cannot save matches no case, so nothing reaches the
       * wire and the input completes as a no-op.
       */
      switch (`${delivery}|${action}`) {
        case 'build|read':
        case 'build|set':
        case 'build|request-list': {
          const message = buildParamMessage(requestWith());
          completeBuild(node, send, message, 'param', { message });
          break;
        }
        case 'send|read':
        case 'send|set':
        case 'send|request-list': {
          const message = buildParamMessage(wireRequest());
          connNode.send(message, { band: bandFor(action), target, identityId });
          applyActionStatus(node, 'ok', 'sent');
          send([{ payload: message }, makeStatusRecord(node.type, { result: 'sent', payload: message })]);
          break;
        }
        case 'confirm|set': {
          const request = wireRequest();
          const param = { paramId: request.paramId, paramType: request.paramType, value: request.value };
          await wait(new ParamRestore({ ...transferOptions(request), params: [param] }), 'echo-confirmed', () => param);
          return;
        }
        case 'confirm|read': {
          const request = wireRequest();
          await wait(new ParamRead({ ...transferOptions(request), request }), 'value-received', (outcome) => outcome.param);
          return;
        }
        case 'collect|request-list':
          await wait(
            new ParamBackup({ ...transferOptions(wireRequest()), warn: (text) => node.warn(`mavlink-param: ${text}`) }),
            'list-complete',
            (outcome) => outcome.params
          );
          return;
        default: break; // This space intentionally left blank (§5)
      }
      done();
      return;

      /**
       * The transfer skeleton's options for this input (lib/delivery/transfer.js).
       *
       * @param {object} request  carries the resolved encoding
       * @returns {object}
       */
      function transferOptions(request) {
        return {
          send: (message) => connNode.send(message, { band: bandFor(action), target, identityId }),
          subscribe: (filter, handler) => connNode.subscribe(filter, handler),
          target,
          /** The editor owns both numbers and their rings (RED.mavlink.ackDefaults). */
          timeoutMs: Number(config.timeoutMs),
          maxRetries: Number(config.maxRetries),
          encoding: request.encoding,
          onProgress: (update) => send([null, makeStatusRecord(node.type, { result: 'progress', ...update })]),
        };
      }

      /**
       * Run one waiting exchange in the slot and report its outcome. Output
       * 0 fires on success only; output 1 carries the terminal record. A
       * close cancels quietly (§14.47); a later input superseding this one
       * says so on output 1, because this one's frame is already on the wire.
       *
       * @param {object} machine
       * @param {string} detail  the success word
       * @param {function(object): *} continued  output 0's payload
       */
      async function wait(machine, detail, continued) {
        applyActionStatus(node, 'sending', `${action}\u2026`);
        const outcome = await slot.run(machine);
        const { params: _params, param: _param, ...fields } = outcome;
        switch (outcome.result) {
          case 'succeeded':
            applyActionStatus(node, 'ok', detail);
            send([{ payload: continued(outcome) }, makeStatusRecord(node.type, { ...fields, detail })]);
            break;
          case 'cancelled':
            if (!closing) send([null, makeStatusRecord(node.type, { ...fields, detail: 'superseded' })]);
            break;
          case 'failed':
          case 'unconfirmed':
            applyActionStatus(node, 'error', outcome.reason);
            send([null, makeStatusRecord(node.type, fields)]);
            break;
          default: break; // This space intentionally left blank (§5)
        }
        done();
      }
    });

    /**
     * A redeploy mid-request settles the wait as cancelled, which releases
     * that message's own done() quietly.
     */
    node.on('close', (done) => {
      closing = true;
      slot.cancel();
      done();
    });
  }

  RED.nodes.registerType('mavlink-param', MavlinkParamNode);
};

/**
 * Build a normalized param request from payload and node config (per the
 * role × tier matrix, DESIGN.md §6). The target is already resolved; the
 * encoding is the resolved token.
 *
 * @param {object} config
 * @param {object} payload
 * @param {{sysid: number, compid: number}} target
 * @param {string|undefined} encoding
 * @returns {object} normalized param request
 */
function requestFrom(config, payload, target, encoding) {
  return {
    action: valueFrom(payload, config, 'action'),
    target,
    paramId: valueFrom(payload, config, 'paramId'),
    /**
     * The editor's -1 default is the name-addressed sentinel. A supplied 0 is
     * a valid index; an absent value remains undefined and reaches
     * buildParamMessage as NaN so the serializer reports the malformed request.
     */
    paramIndex: valueFrom(payload, config, 'paramIndex'),
    value: valueFrom(payload, config, 'value'),
    /**
     * No REAL32 fallback: an absent type resolves to nothing, never to a
     * guess — guessing the type silently mis-encodes the value.
     */
    paramType: valueFrom(payload, config, 'paramType'),
    encoding,
  };
}

/**
 * Queue band per action (§7): the full-table stream rides Bulk, the
 * single-parameter conversations ride Control.
 *
 * @param {string} action
 * @returns {number|undefined}
 */
function bandFor(action) {
  switch (action) {
    case 'request-list': return BAND.BULK;
    case 'read':
    case 'set': return BAND.CONTROL;
    default: break; // This space intentionally left blank (§5)
  }
  return undefined;
}
