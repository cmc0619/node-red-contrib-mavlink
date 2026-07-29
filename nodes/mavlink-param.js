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

const path = require('node:path');
const {
  buildParamMessage,
  createParamListCollector,
  matchesParamEcho,
} = require('../lib/param');
const { BAND } = require('../lib/connection/bands');
const {
  makeStatusRecord,
  shouldSuppress,
  applyActionStatus,
  reportDoneError,
} = require('../lib/delivery');
const {
  resolveActionTarget,
  profileFromVehicleNode,
  firstDefined,
  resolveBuildDialect,
} = require('../lib/addressing');

/** Default param transaction timeout (ms). */
const DEFAULT_TIMEOUT_MS = 10000;

/** Admin route for the parameter definition catalog. */
const PARAM_DEFS_ROUTE = '/mavlink/param/defs';

/** Guard against double-registering the admin route (one per process). */
let _paramDefsRouteRegistered = false;

module.exports = function registerMavlinkParam(RED) {
  if (!_paramDefsRouteRegistered && RED.httpAdmin && RED.auth) {
    let defsApi = null;
    try { defsApi = require('../lib/param/defs'); } catch { }

    RED.httpAdmin.get(
      PARAM_DEFS_ROUTE,
      RED.auth.needsPermission('mavlink.read'),
      async (req, res) => {
        if (!defsApi) {
          return res.status(503).json({ defs: {}, notice: 'param defs library unavailable' });
        }
        const vehicleId = typeof req.query.vehicle === 'string'
          ? req.query.vehicle.trim() : '';
        const dialect = typeof req.query.dialect === 'string'
          ? req.query.dialect.trim() : '';
        const firmware = typeof req.query.firmware === 'string'
          ? req.query.firmware.trim() : '';
        let url;
        if (vehicleId) {
          const vehicleNode = RED.nodes.getNode(vehicleId);
          if (!vehicleNode) {
            return res.json({
              defs: {},
              notice: 'Vehicle Profile not deployed — deploy the flow first',
            });
          }
          url = defsApi.resolveDefsUrl(
            vehicleNode.vehicleFamily || 'generic',
            vehicleNode.firmware,
            vehicleNode.paramDefsUrl || ''
          );
        } else {
          if (!dialect) {
            return res.json({ defs: {}, notice: 'no dialect supplied' });
          }
          url = defsApi.resolveDefsUrl(dialect, firmware, '');
        }
        if (!url) {
          return res.json({
            defs: {},
            notice: vehicleId
              ? 'no parameter definitions available for this vehicle family and firmware'
              : 'no parameter definitions available for this dialect and firmware',
          });
        }
        const userDir = (RED.settings && RED.settings.userDir) || '';
        const cacheDir = userDir
          ? path.join(userDir, 'mavlink', 'param-defs') : undefined;
        try {
          const map = await defsApi.fetchParamDefs(url, { cacheDir });
          const defs = {};
          for (const [k, v] of map) defs[k] = v;
          return res.json({ defs, url });
        } catch (err) {
          return res.status(502).json({
            defs: {},
            notice: `fetch failed: ${err.message}`,
            url,
          });
        }
      }
    );
    _paramDefsRouteRegistered = true;
  }

  function MavlinkParamNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    const timeoutMs = config.timeout ? Number(config.timeout) : DEFAULT_TIMEOUT_MS;

    /**
     * In-flight transaction, or null. `gen` is the single-flight token: a
     * callback or timeout only settles the node when its captured generation
     * still matches, so a superseded operation's late echo is ignored.
     * @type {{unsubscribe: (()=>void)|null, timer: any, done: Function|null, gen: number}|null}
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
      if (releaseDone && done) done();
    }

    node.on('input', (msg, send, done) => {
      const emit = send || ((messages) => node.send(messages));
      try {
        if (shouldSuppress(msg)) {
          if (done) done();
          return;
        }

        const payload = objectPayload(msg.payload);
        const delivery = config.delivery || 'build';

        // Build tier: profile only for the Vehicle Profile dialect escape.
        // Concrete Build dialects carry firmware directly from the editor.
        // Wire tiers: profile from the Connection's bound Vehicle, identity from config/payload.
        const connNode = delivery !== 'build' ? RED.nodes.getNode(config.connection) : null;
        const useVehicle = delivery === 'build' && resolveBuildDialect(config) === '__vehicle';
        const profile = delivery === 'build'
          ? (useVehicle
            ? profileFromVehicleNode(RED.nodes.getNode(config.vehicle))
            : { firmware: config.firmware })
          : (connNode && connNode.vehicle) || null;
        const identityNode = delivery !== 'build'
          ? RED.nodes.getNode(payload.identityId || config.identity)
          : null;

        const request = requestFrom(config, payload, {
          identityNode,
          profile,
          connectionNode: connNode,
        });
        const message = buildParamMessage(request);

        if (delivery === 'build') {
          completeBuild(node, emit, message);
          if (done) done();
          return;
        }

        const connectionNode = requireConnection(RED, config.connection);
        connectionNode.send(message, {
          band: request.action === 'request-list' ? BAND.BULK : BAND.CONTROL,
          target: request.target,
          identityId: payload.identityId || config.identity,
        });

        // Scope the PARAM_VALUE subscription to the addressed vehicle so a
        // reply from another system on a shared connection cannot confirm this
        // operation or interleave into a list from a different vehicle.
        const echoFilter = { message: 'PARAM_VALUE', sysid: request.target.sysid };
        if (request.target.compid) echoFilter.compid = request.target.compid;

        const isConfirmSet = delivery === 'confirm' && request.action === 'set';
        const isCollectList = delivery === 'collect' && request.action === 'request-list';

        if (!isConfirmSet && !isCollectList) {
          completeResult(node, emit, 'succeeded', 'sent', message);
          if (done) done();
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
        const unsubscribe = connectionNode.subscribe(echoFilter, (decoded) => {
          if (!pending || pending.gen !== myGen) return;
          if (isConfirmSet) {
            if (!matchesParamEcho(request, decoded)) return;
            settle((finishDone) => {
              completeResult(node, emit, 'succeeded', 'echo-confirmed', decoded);
              if (finishDone) finishDone();
            });
          } else {
            const params = collector.accept(decoded);
            if (!params) return;
            settle((finishDone) => {
              completeResult(node, emit, 'succeeded', 'list-complete', params);
              if (finishDone) finishDone();
            });
          }
        });

        const timer = setTimeout(() => {
          settle((finishDone) =>
            timeoutResult(node, emit, isConfirmSet ? 'echo timeout' : 'list timeout', msg, finishDone));
        }, timeoutMs);

        pending = { unsubscribe, timer, done: done || null, gen: myGen };
      } catch (err) {
        fail(node, emit, err, msg, done);
      }
    });

    node.on('close', (done) => {
      clearPending(false);
      if (done) done();
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
 * @param {{identityNode: object|null, profile: object|null, connectionNode?: object|null}} ctx
 * @returns {object} normalized param request
 */
function requestFrom(config, payload, { identityNode, profile, connectionNode }) {
  const target = resolveActionTarget({
    payloadTarget: payload.target,
    configSysid: config.targetSystem,
    configCompid: config.targetComponent,
    identityNode,
    profile,
  });
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

function requireConnection(RED, id) {
  const node = RED.nodes.getNode(id);
  if (!node || typeof node.send !== 'function') throw new Error('mavlink-param requires a Connection');
  return node;
}

function completeBuild(node, emit, message) {
  applyActionStatus(node, 'ok', 'built param');
  emit([{ payload: message }, statusRecord('built', 'built', { message })]);
}

function completeResult(node, emit, result, detail, payload) {
  applyActionStatus(node, 'ok', detail);
  emit([{ payload }, statusRecord(result, detail, { payload })]);
}

function timeoutResult(node, emit, detail, msg, done) {
  applyActionStatus(node, 'error', detail);
  emit([null, statusRecord('timed-out', detail)]);
  reportDoneError(node, new Error(`mavlink-param: ${detail}`), msg, done);
}

function fail(node, emit, err, msg, done) {
  applyActionStatus(node, 'error', err.message);
  emit([null, statusRecord('failed', err.message)]);
  reportDoneError(node, err, msg, done);
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

function objectPayload(payload) {
  return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
}
