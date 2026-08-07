'use strict';

/**
 * mavlink-param — read one, set one, or request the list (DESIGN.md §3, §9).
 *
 * Param confirmation is echo-based, not COMMAND_ACK: a set is confirmed by the
 * PARAM_VALUE the vehicle broadcasts back, and a list by collecting every
 * PARAM_VALUE up to the advertised count (§9 "Three kinds of confirmation").
 *
 * Chain model (§9):
 *   output 0 — continue: fires only on success (built message / echo / list)
 *   output 1 — status:   a status record on every terminal outcome
 *
 * Single-flight: at most one PARAM_VALUE transaction runs per node. A second
 * input supersedes any in-flight one — the prior subscription and timeout are
 * torn down and a generation token guards against a late echo settling the node
 * after it was cancelled. Every waiting transaction carries a timeout so a lost
 * echo or dropped list message cannot leave the flow open forever.
 */

const {
  buildParamMessage,
  createParamListCollector,
  matchesParamEcho,
} = require('../lib/param');
const {
  readParamDefs,
  updateParamDefs,
} = require('../lib/param/defs');
const {
  defsFor: seedDefsFor,
  seedStamp,
  seedError,
  catalogLabel,
} = require('../lib/param/seed');
const { BAND } = require('../lib/connection/bands');
const {
  makeStatusRecord,
  shouldSuppress,
  applyActionStatus,
} = require('../lib/delivery');
const {
  resolveDeliveryContext,
  firstDefined,
  applyConnectionStatus,
} = require('../lib/addressing');
const { DEFAULT_TIMEOUT_MS } = require('../lib/command');

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
        const profileId = typeof req.query.vehicle === 'string'
          ? req.query.vehicle.trim() : '';

        // Firmware and vehicle family come from the query when the editor sent
        // them, and from the deployed profile otherwise.
        //
        // The query wins deliberately. `getNode` resolves only *deployed*
        // config nodes, so a Vehicle Profile the operator just created — or
        // edited and not yet deployed — is invisible here while being perfectly
        // visible in the editor that sent the request. Preferring the query
        // also means an edited-but-undeployed firmware is honoured rather than
        // answered from the stale deployed value.
        let firmware = typeof req.query.firmware === 'string' ? req.query.firmware.trim() : '';
        let vehicleFamily = typeof req.query.vehicleFamily === 'string'
          ? req.query.vehicleFamily.trim() : '';
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
            notice: seedError()
              || (firmware
                ? `No parameter definitions for firmware "${firmware}".`
                : 'Pick a firmware, or a Vehicle Profile, to load parameter definitions.'),
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
          // A corrupt holding file is the operator's own download and must be
          // reported — but it should not also cost them the shipped baseline.
          if (seeded.size > 0) {
            return res.json({
              defs: Object.fromEntries(seeded),
              source: 'seed',
              stamp: seedStamp(),
              catalog: catalogLabel({
                firmware, vehicleFamily, count: seeded.size, source: 'seed',
              }),
              notice: `Downloaded definitions are unreadable, showing the shipped seed: ${err.message}`,
            });
          }
          return res.status(500).json({
            defs: {},
            error: `Local parameter definitions are invalid: ${err.message}`,
          });
        }
      }
    );

    RED.httpAdmin.post(
      PARAM_DEFS_UPDATE_ROUTE,
      RED.auth.needsPermission('mavlink.read'),
      async (req, res) => {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const profileId = typeof body.vehicle === 'string' ? body.vehicle.trim() : '';
        const url = typeof body.url === 'string' ? body.url.trim() : '';
        if (!profileId) {
          return res.status(400).json({ ok: false, error: 'Vehicle Profile ID is required' });
        }
        if (!url) {
          return res.status(400).json({ ok: false, error: 'Parameter definitions URL is required' });
        }
        try {
          const result = await updateParamDefs(RED.settings.userDir, profileId, url);
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

    const timeoutMs = config.timeout === '' ? DEFAULT_TIMEOUT_MS : Number(config.timeout);
    const delivery = config.delivery;
    const connAtDeploy = RED.nodes.getNode(config.connection);
    applyConnectionStatus(node, delivery, connAtDeploy);

    /**
     * In-flight transaction, or null. `gen` is the single-flight token: a
     * callback or timeout only settles the node when its captured generation
     * still matches, so a superseded operation's late echo is ignored.
     * @type {{unsubscribe: (()=>void)|null, timer: any, done: Function, gen: number}|null}
     */
    let pending = null;
    let generation = 0;

    /**
     * Tear down the in-flight transaction. When `releaseDone` is true the
     * abandoned op's `done` callback is invoked so Node-RED does not consider
     * its message perpetually unfinished.
     *
     * @param {boolean} releaseDone
     */
    function clearPending(releaseDone) {
      if (!pending) return;
      const { unsubscribe, timer, done } = pending;
      pending = null;
      if (unsubscribe) unsubscribe();
      if (timer) clearTimeout(timer);
      if (releaseDone) done();
    }

    node.on('input', (msg, send, done) => {
      try {
        if (shouldSuppress(msg)) {
          done();
          return;
        }

        const payload = msg.payload ?? {};

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

        const request = requestFrom(config, payload, {
          target,
          profile,
          connectionNode: connNode,
        });
        const message = buildParamMessage(request);

        if (delivery === 'build') {
          completeBuild(node, send, message);
          done();
          return;
        }

        if (!connNode) {
          throw new Error('mavlink-param requires a Connection');
        }
        connNode.send(message, {
          band: request.action === 'request-list' ? BAND.BULK : BAND.CONTROL,
          target: request.target,
          identityId,
        });

        // Scope the PARAM_VALUE subscription to the addressed vehicle so a
        // reply from another system on a shared connection cannot confirm this
        // operation or interleave into a list from a different vehicle.
        const echoFilter = { message: 'PARAM_VALUE', sysid: request.target.sysid };
        if (request.target.compid) echoFilter.compid = request.target.compid;

        const isConfirmSet = delivery === 'confirm' && request.action === 'set';
        const isCollectList = delivery === 'collect' && request.action === 'request-list';

        if (!isConfirmSet && !isCollectList) {
          completeResult(node, send, 'succeeded', 'sent', message);
          done();
          return;
        }

        // Supersede any prior in-flight transaction, releasing its done().
        clearPending(true);
        const myGen = ++generation;

        /** Settle the current transaction if it has not been superseded. */
        function settle(fn) {
          if (!pending || pending.gen !== myGen) return;
          const finishDone = pending.done;
          clearPending(false);
          fn(finishDone);
        }

        const collector = isCollectList ? createParamListCollector() : null;
        const unsubscribe = connNode.subscribe(echoFilter, (decoded) => {
          if (!pending || pending.gen !== myGen) return;
          if (isConfirmSet) {
            if (!matchesParamEcho(request, decoded)) return;
            settle((finishDone) => {
              completeResult(node, send, 'succeeded', 'echo-confirmed', decoded);
              finishDone();
            });
          } else {
            const params = collector.accept(decoded);
            if (!params) return;
            settle((finishDone) => {
              completeResult(node, send, 'succeeded', 'list-complete', params);
              finishDone();
            });
          }
        });

        const timer = setTimeout(() => {
          settle((finishDone) =>
            timeoutResult(node, send, isConfirmSet ? 'echo timeout' : 'list timeout', msg, finishDone));
        }, timeoutMs);

        pending = { unsubscribe, timer, done, gen: myGen };
      } catch (err) {
        fail(node, send, err, msg, done);
      }
    });

    node.on('close', (done) => {
      // Release the in-flight transaction's own done() — a redeploy mid-request
      // otherwise leaves that message forever unfinished for Node-RED's
      // onComplete hook / any wired Complete node. Matches the supersede path
      // above and the close handlers in mavlink-command / mavlink-mission
      // (issue #96).
      clearPending(true);
      done();
    });
  }

  RED.nodes.registerType('mavlink-param', MavlinkParamNode);
};

/**
 * Build a normalized param request from payload, node config, identity node,
 * and profile (per the role × tier matrix, DESIGN.md §6).
 *
 * Resolution order per field (sysid/compid): msg.payload.target →
 * companion derivation → config → profile default.
 * Firmware: payload → active profile. On Build, a concrete dialect supplies
 * `{ firmware: config.firmware }`; the Vehicle Profile escape supplies the
 * vehicle profile. Encoding: override → capabilities → named firmware.
 *
 * @param {object} config
 * @param {object} payload
 * @param {{target: object, profile: object|null, connectionNode?: object|null}} ctx
 * @returns {object} normalized param request
 */
function requestFrom(config, payload, { target, profile, connectionNode }) {
  const firmware = firstDefined(payload.firmware, profile && profile.firmware);
  const encoding = firstDefined(payload.paramEncoding, payload.encoding);
  const capabilities = capabilitiesFromPeer(connectionNode, target);
  return {
    action: payload.action || config.action || 'read',
    target,
    paramId: payload.paramId || config.paramId,
    // paramIndex 0 is a valid index; keep it rather than letting `||` drop it to
    // the library's -1 default. Absent (undefined) is left for the library.
    paramIndex: firstDefined(payload.paramIndex, config.paramIndex),
    value: payload.value !== undefined ? payload.value : config.value,
    paramType: payload.paramType || config.paramType || 'MAV_PARAM_TYPE_REAL32',
    firmware,
    encoding,
    capabilities,
  };
}

/**
 * Read AUTOPILOT_VERSION.capabilities for the addressed component, when known.
 *
 * @param {object|null|undefined} connectionNode
 * @param {{sysid: number, compid: number}} target
 * @returns {number|null}
 */
function capabilitiesFromPeer(connectionNode, target) {
  // Supported absence: connection not ready / peer table not attached yet.
  // Missing component or capabilities → fall through to firmware (null).
  const table = connectionNode && connectionNode.peerTable;
  if (!table) return null;
  const component = table.getComponent(Number(target.sysid), Number(target.compid));
  if (!component || component.capabilities == null || component.capabilities === '') {
    return null;
  }
  const caps = Number(component.capabilities);
  return Number.isFinite(caps) ? caps : null;
}

function completeBuild(node, send, message) {
  applyActionStatus(node, 'ok', 'built param');
  send([{ payload: message }, statusRecord('built', 'built', { message })]);
}

function completeResult(node, send, result, detail, payload) {
  applyActionStatus(node, 'ok', detail);
  send([{ payload }, statusRecord(result, detail, { payload })]);
}

function timeoutResult(node, send, detail, msg, done) {
  applyActionStatus(node, 'error', detail);
  send([null, statusRecord('timed-out', detail)]);
  done(new Error(`mavlink-param: ${detail}`));
}

function fail(node, send, err, msg, done) {
  applyActionStatus(node, 'error', err.message);
  send([null, statusRecord('failed', err.message)]);
  done(err);
}

/**
 * @param {string} result
 * @param {string} detail
 * @param {object} [extra]
 * @returns {object} status record for output 1
 */
function statusRecord(result, detail, extra = {}) {
  return makeStatusRecord({ node: 'mavlink-param', result, detail, ...extra });
}
