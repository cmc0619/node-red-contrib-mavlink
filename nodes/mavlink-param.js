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
 * Status records carry the shared `__mavlinkStatusRecord__` marker from
 * `lib/delivery`, emitted as the top-level message on output 1 — the same shape
 * the sibling action nodes use — so wiring output 1 back into an action node is
 * refused as a miswire rather than executed (§9 "A status record is refused").
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
const { BAND } = require('../lib/connection/bands');
const {
  isStatusRecord,
  refuseIfStatus,
  makeStatusRecord,
  shouldSuppress,
  applyActionStatus,
} = require('../lib/delivery');

/** Default param transaction timeout (ms). */
const DEFAULT_TIMEOUT_MS = 10000;

module.exports = function registerMavlinkParam(RED) {
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
        if (isStatusRecord(msg)) {
          const refusal = refuseIfStatus(msg);
          applyActionStatus(node, 'error', 'status input refused');
          node.error('mavlink-param: status record received as input — check wiring', msg);
          emit([null, refusal]);
          if (done) done();
          return;
        }

        const payload = objectPayload(msg.payload);
        const request = requestFrom(config, payload);
        const message = buildParamMessage(request);
        const delivery = config.delivery || 'build';

        if (delivery === 'build') {
          completeBuild(node, emit, message);
          if (done) done();
          return;
        }

        const connectionNode = requireConnection(RED, config.connection);
        connectionNode.send(message, {
          band: request.action === 'request-list' ? BAND.BULK : BAND.CONTROL,
          target: request.target,
          identityId: config.identity || payload.identityId,
        });

        // Scope the PARAM_VALUE subscription to the addressed vehicle so a
        // reply from another system on a shared connection cannot confirm this
        // operation or interleave into a list from a different vehicle.
        const echoFilter = { message: 'PARAM_VALUE', sysid: request.target.sysid };
        if (request.target.compid) echoFilter.compid = request.target.compid;

        const isConfirmSet = delivery === 'confirm' && request.action === 'set';
        const isCollectList = delivery === 'collect' && request.action === 'request-list';

        if (!isConfirmSet && !isCollectList) {
          // Fire-and-forget send: no echo to wait on.
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
          fn();
          if (finishDone) finishDone();
        }

        const collector = isCollectList ? createParamListCollector() : null;
        const unsubscribe = connectionNode.subscribe(echoFilter, (decoded) => {
          if (!pending || pending.gen !== myGen) return;
          if (isConfirmSet) {
            if (!matchesParamEcho(request, decoded)) return;
            settle(() =>
              completeResult(node, emit, 'succeeded', 'echo-confirmed', decoded));
          } else {
            const params = collector.accept(decoded);
            if (!params) return;
            settle(() =>
              completeResult(node, emit, 'succeeded', 'list-complete', params));
          }
        });

        const timer = setTimeout(() => {
          settle(() =>
            timeoutResult(node, emit, isConfirmSet ? 'echo timeout' : 'list timeout'));
        }, timeoutMs);

        pending = { unsubscribe, timer, done: done || null, gen: myGen };
      } catch (err) {
        fail(node, emit, err);
        if (done) done(err);
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
 * @param {object} config
 * @param {object} payload
 * @returns {object} normalized param request
 */
function requestFrom(config, payload) {
  const target = payload.target || {};
  return {
    action: payload.action || config.action || 'read',
    target: {
      // Nullish-preserving: a configured 0 is a legitimate broadcast address
      // and must not fall through the `||` chain to the default of 1.
      sysid: Number(firstDefined(target.sysid, config.targetSystem, 1)),
      compid: Number(firstDefined(target.compid, config.targetComponent, 1)),
    },
    paramId: payload.paramId || config.paramId,
    // paramIndex 0 is a valid index; keep it rather than letting `||` drop it to
    // the library's -1 default. Absent (undefined) is left for the library.
    paramIndex: firstDefined(payload.paramIndex, config.paramIndex),
    value: payload.value !== undefined ? payload.value : config.value,
    paramType: payload.paramType || config.paramType || 'MAV_PARAM_TYPE_REAL32',
    firmware: payload.firmware || config.firmware || 'ardupilot',
  };
}

/**
 * Return the first argument that is neither undefined, null, nor the empty
 * string. Preserves an explicit 0 (unlike `||`).
 *
 * @param {...*} values
 * @returns {*}
 */
function firstDefined(...values) {
  for (const v of values) {
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
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

function timeoutResult(node, emit, detail) {
  applyActionStatus(node, 'error', detail);
  node.error(`mavlink-param: ${detail}`);
  emit([null, statusRecord('timed-out', detail)]);
}

function fail(node, emit, err) {
  applyActionStatus(node, 'error', err.message);
  node.error(err);
  emit([null, statusRecord('failed', err.message)]);
}

/**
 * @param {string} result
 * @param {string} detail
 * @param {object} [extra]
 * @returns {object} status record carrying the shared delivery marker
 */
function statusRecord(result, detail, extra = {}) {
  return makeStatusRecord({ node: 'mavlink-param', result, detail, ...extra });
}

function objectPayload(payload) {
  return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
}
