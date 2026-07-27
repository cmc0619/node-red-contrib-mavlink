'use strict';

/**
 * mavlink-mission — palette node (DESIGN.md §3, §9 "Mission protocol",
 * §12 step 7).
 *
 * Runs one of three state machines over the mission item-transfer protocol —
 * download, upload, or clear — for one of three plan types — mission, fence,
 * or rally. All protocol logic lives in `lib/mission`; this node is the thin
 * wrapper (§2): read config, resolve the connection/target/firmware, run the
 * machine, and shape the two-output chain (§9).
 *
 *   output 0 = continue  (fires only on success)
 *   output 1 = status    (progress updates *and* the terminal record)
 *
 * Delivery tiers (§9 "Delivery tiers"):
 *   build   — construct the protocol plan (the messages that would be sent) and
 *             emit it on output 0; send nothing. Always available.
 *   confirm — run the machine to its `MISSION_ACK` and report the outcome.
 *             Available when a connection is configured.
 *
 * Guards (§9 "What triggers an action node"):
 *   msg.payload === false → suppress
 *   a status record on input → refuse (miswire)
 *   clear is destructive → a confirmation gate (config checkbox or msg.confirmed)
 */

const {
  makeStatusRecord,
  shouldSuppress,
  refuseIfStatus,
  applyActionStatus,
} = require('../lib/delivery');
const { BAND } = require('../lib/connection/bands');
const {
  createMachine,
  validateItems,
  missionTypeValue,
  supportedMissionTypes,
  locks,
  OPERATION,
  buildRequestList,
  buildCount,
  buildClearAll,
  buildItemInt,
} = require('../lib/mission');

module.exports = function registerMavlinkMission(RED) {
  function MavlinkMissionNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    const operation = config.operation || OPERATION.DOWNLOAD;
    const connNode = config.connection ? RED.nodes.getNode(config.connection) : null;
    const delivery = config.delivery || (connNode ? 'confirm' : 'build');
    const firmware = config.firmware || 'ardupilot';
    const timeoutMs = config.timeout ? Number(config.timeout) : undefined;
    const maxRetries = config.maxRetries !== undefined && config.maxRetries !== ''
      ? Number(config.maxRetries)
      : undefined;

    /** At most one transfer in flight per node. */
    let active = null;

    node.status({});

    node.on('input', (msg, send, done) => {
      const emit = send || ((m) => node.send(m));
      const finish = (err) => {
        if (done) done(err);
      };

      if (shouldSuppress(msg)) {
        finish();
        return;
      }

      const refusal = refuseIfStatus(msg);
      if (refusal) {
        applyActionStatus(node, 'error', 'miswire');
        node.error('mavlink-mission: status record received on input (miswire)', msg);
        emit([null, { payload: refusal }]);
        finish();
        return;
      }

      const payload = objectPayload(msg.payload);
      const missionTypeKey = payload.missionType || config.missionType || 'mission';
      const target = resolveTarget(config, payload);

      // Firmware gate: refuse a type the selected stack does not carry over
      // this protocol rather than sending a request it will silently no-op (§9,
      // §11).
      const supported = supportedMissionTypes(firmware);
      if (!supported.includes(missionTypeKey)) {
        const rec = record(operation, missionTypeKey, target, {
          result: 'failed',
          phase: 'gated',
          reason: `${firmware} does not support ${missionTypeKey} over the mission protocol`,
        });
        applyActionStatus(node, 'error', `no ${missionTypeKey} on ${firmware}`);
        node.error(`mavlink-mission: ${rec.reason}`, msg);
        emit([null, { payload: rec }]);
        finish();
        return;
      }
      const missionType = missionTypeValue(missionTypeKey);

      // Upload item source: msg.payload.items overrides configured items.
      let uploadItems = [];
      if (operation === OPERATION.UPLOAD) {
        uploadItems = resolveItems(config, payload);
        const check = validateItems(uploadItems, missionType);
        if (!check.ok) {
          const rec = record(operation, missionTypeKey, target, {
            result: 'failed',
            phase: 'validate',
            reason: check.reason,
            seq: check.seq,
          });
          applyActionStatus(node, 'error', `invalid ${missionTypeKey} item`);
          node.error(`mavlink-mission: ${check.reason}`, msg);
          emit([null, { payload: rec }]);
          finish();
          return;
        }
      }

      // ── Build tier: emit the protocol plan, send nothing. ─────────────────
      if (delivery === 'build' || !connNode) {
        const plan = buildPlan(operation, missionType, target, uploadItems);
        applyActionStatus(node, 'preview', `plan ${operation} ${missionTypeKey}`);
        emit([
          { payload: plan },
          {
            payload: record(operation, missionTypeKey, target, {
              result: 'succeeded',
              phase: 'built',
              messageCount: plan.messages.length,
            }),
          },
        ]);
        finish();
        return;
      }

      // ── Clear confirmation gate (destructive, §9). ────────────────────────
      if (operation === OPERATION.CLEAR && !(config.confirmClear || msg.confirmed === true)) {
        const rec = record(operation, missionTypeKey, target, {
          result: 'failed',
          phase: 'unconfirmed',
          reason: 'clear is destructive — enable confirmation or set msg.confirmed = true',
        });
        applyActionStatus(node, 'error', `confirm clear ${missionTypeKey}`);
        node.error(`mavlink-mission: ${rec.reason}`, msg);
        emit([null, { payload: rec }]);
        finish();
        return;
      }

      // ── Lock per (connection, target, mission_type) (§9). ─────────────────
      const release = locks.acquire(connNode.id, target, missionType);
      if (!release) {
        const rec = record(operation, missionTypeKey, target, {
          result: 'failed',
          phase: 'locked',
          reason: `a ${missionTypeKey} transfer is already in progress for this target`,
        });
        applyActionStatus(node, 'error', `${missionTypeKey} busy`);
        node.error(`mavlink-mission: ${rec.reason}`, msg);
        emit([null, { payload: rec }]);
        finish();
        return;
      }

      if (active) active.cancel();

      applyActionStatus(node, 'sending', `${operation} ${missionTypeKey}\u2026`);

      const machine = createMachine(operation, {
        send: (message) =>
          connNode.send(message, {
            band: BAND.BULK,
            target,
            identityId: config.identity || payload.identityId,
          }),
        subscribe: (filter, handler) => connNode.subscribe(filter, handler),
        target,
        missionType,
        items: uploadItems,
        timeoutMs,
        maxRetries,
        onProgress: (update) => {
          emit([
            null,
            { payload: record(operation, missionTypeKey, target, { result: 'progress', ...update }) },
          ]);
        },
      });
      active = machine;

      machine
        .start()
        .then((outcome) => {
          if (active === machine) active = null;
          release();

          const rec = record(operation, missionTypeKey, target, outcome);
          if (outcome.result === 'succeeded') {
            applyActionStatus(node, 'ok', successBadge(operation, missionTypeKey, outcome));
            emit([{ payload: rec }, { payload: rec }]);
          } else {
            applyActionStatus(node, 'error', `${operation} ${outcome.result}`);
            if (outcome.result !== 'cancelled') {
              node.error(`mavlink-mission: ${operation} ${outcome.result}: ${outcome.reason || ''}`, msg);
            }
            emit([null, { payload: rec }]);
          }
          finish();
        })
        .catch((err) => {
          if (active === machine) active = null;
          release();
          applyActionStatus(node, 'error', `${operation} error`);
          node.error(`mavlink-mission: ${err.message}`, msg);
          emit([null, { payload: record(operation, missionTypeKey, target, {
            result: 'failed',
            phase: 'error',
            reason: err.message,
          }) }]);
          finish(err);
        });
    });

    node.on('close', (done) => {
      if (active) {
        active.cancel();
        active = null;
      }
      done();
    });
  }

  RED.nodes.registerType('mavlink-mission', MavlinkMissionNode);
};

/**
 * Build a status record for output 1. Every record carries the operation and
 * mission type so a downstream `switch` can branch (§9).
 *
 * @param {string} operation
 * @param {string} missionTypeKey
 * @param {{sysid: number, compid: number}} target
 * @param {object} fields
 * @returns {object}
 */
function record(operation, missionTypeKey, target, fields) {
  return makeStatusRecord({
    node: 'mavlink-mission',
    operation,
    missionType: missionTypeKey,
    target,
    ...fields,
  });
}

/**
 * The protocol plan for the Build tier: the messages the machine would send.
 *
 * @param {string} operation
 * @param {number} missionType
 * @param {{sysid: number, compid: number}} target
 * @param {object[]} items
 * @returns {{operation: string, missionType: number, target: object, messages: object[]}}
 */
function buildPlan(operation, missionType, target, items) {
  let messages;
  if (operation === OPERATION.DOWNLOAD) {
    messages = [buildRequestList(target, missionType)];
  } else if (operation === OPERATION.CLEAR) {
    messages = [buildClearAll(target, missionType)];
  } else {
    messages = [
      buildCount(target, items.length, missionType),
      ...items.map((item, seq) => buildItemInt(item, target, seq, missionType)),
    ];
  }
  return { operation, missionType, target, messages };
}

/**
 * Resolve upload items from config JSON or the message payload.
 *
 * @param {object} config
 * @param {object} payload
 * @returns {object[]}
 */
function resolveItems(config, payload) {
  if (Array.isArray(payload.items)) return payload.items;
  if (typeof config.items === 'string' && config.items.trim()) {
    const parsed = JSON.parse(config.items);
    if (!Array.isArray(parsed)) throw new Error('mission items config must be a JSON array');
    return parsed;
  }
  return [];
}

/**
 * @param {object} config
 * @param {object} payload
 * @returns {{sysid: number, compid: number}}
 */
function resolveTarget(config, payload) {
  const t = payload.target || {};
  return {
    sysid: Number(t.sysid || config.targetSystem || 1),
    compid: Number(t.compid || config.targetComponent || 1),
  };
}

/**
 * Success badge text (capped downstream by applyActionStatus).
 *
 * @param {string} operation
 * @param {string} missionTypeKey
 * @param {object} outcome
 * @returns {string}
 */
function successBadge(operation, missionTypeKey, outcome) {
  if (operation === OPERATION.DOWNLOAD) return `${missionTypeKey} \u2193 ${outcome.count} items`;
  if (operation === OPERATION.UPLOAD) return `${missionTypeKey} \u2191 ${outcome.count} items`;
  return `${missionTypeKey} cleared`;
}

/**
 * @param {*} payload
 * @returns {object}
 */
function objectPayload(payload) {
  return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
}
