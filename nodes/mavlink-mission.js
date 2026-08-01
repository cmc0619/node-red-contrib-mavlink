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
 *   clear is destructive → a confirmation gate (config checkbox or msg.confirmed)
 */

const {
  makeStatusRecord,
  shouldSuppress,
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
const {
  resolveActionTarget,
  profileFromVehicleNode,
  firstDefined,
} = require('../lib/addressing');

module.exports = function registerMavlinkMission(RED) {
  function MavlinkMissionNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    const operation = config.operation || OPERATION.DOWNLOAD;
    const connNode = config.connection ? RED.nodes.getNode(config.connection) : null;
    const delivery = config.delivery;
    const timeoutMs = config.timeout ? Number(config.timeout) : undefined;
    const maxRetries = config.maxRetries !== undefined && config.maxRetries !== ''
      ? Number(config.maxRetries)
      : undefined;

    /**
     * In-flight machines keyed by the same lock key as {@link locks}
     * (`connection::sysid.compid::missionType`). Different types on one node
     * may run concurrently; only a later message for the *same* key cancels
     * its predecessor.
     *
     * @type {Map<string, {cancel: Function}>}
     */
    const activeByKey = new Map();

    // Wire-tier confirm needs a Connection. Do not silently degrade into Build
    // and report a phantom plan (§9) — same rule as mavlink-command.
    if (delivery !== 'build' && !connNode) {
      node.status({ fill: 'red', shape: 'ring', text: 'invalid config' });
    } else {
      node.status({});
    }

    node.on('input', (msg, send, done) => {
      if (shouldSuppress(msg)) {
        done();
        return;
      }

      const payload = msg.payload ?? {};
      const missionTypeKey = payload.missionType || config.missionType || 'mission';

      // ── Missing connection on confirm ─────────────────────────────────────
      // Do not silently build and pretend success — confirm with no connection
      // is a misconfiguration (§9). Fail loud on output 1 only (same as Command).
      if (delivery !== 'build' && !connNode) {
        const rec = record(operation, missionTypeKey, { sysid: NaN, compid: NaN }, {
          result: 'failed',
          phase: 'gated',
          reason: `no connection configured for ${delivery} delivery`,
        });
        applyActionStatus(node, 'error', 'invalid config');
        send([null, rec]);
        done(new Error(`mavlink-mission: ${rec.reason}`));
        return;
      }

      // Build tier: Vehicle Profile is used only through the explicit dialect
      // escape. Concrete Build dialects carry firmware but no profile target rung.
      // Wire tiers: profile from Connection's bound Vehicle, identity from config/payload.
      const isBuild = delivery === 'build';
      const useVehicleProfile = isBuild && config.dialect === '__vehicle';
      const profile = isBuild
        ? (useVehicleProfile ? profileFromVehicleNode(RED.nodes.getNode(config.vehicle)) : null)
        : (connNode && connNode.vehicle) || null;
      const identityNode = delivery !== 'build'
        ? RED.nodes.getNode(payload.identityId || config.identity)
        : null;

      // Firmware: dynamic override → selected profile → Build concrete firmware.
      const firmware = firstDefined(
        payload.firmware,
        profile && profile.firmware,
        isBuild && !useVehicleProfile ? config.firmware : undefined
      );

      const target = resolveActionTarget({
        payloadTarget: payload.target,
        configSysid: config.targetSystem,
        configCompid: config.targetComponent,
        identityNode,
        profile,
      });

      // Refuse a type the selected stack does not carry over this protocol rather
      // than sending a request it will silently no-op (§9, §11).
      const supported = supportedMissionTypes(firmware);
      if (!supported.includes(missionTypeKey)) {
        const rec = record(operation, missionTypeKey, target, {
          result: 'failed',
          phase: 'gated',
          reason: `${firmware} does not support ${missionTypeKey} over the mission protocol`,
        });
        applyActionStatus(node, 'error', `no ${missionTypeKey} on ${firmware}`);
        send([null, rec]);
        done(new Error(`mavlink-mission: ${rec.reason}`));
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
          send([null, rec]);
          done(new Error(`mavlink-mission: ${check.reason}`));
          return;
        }
      }

      // ── Clear confirmation gate (destructive, §9). ────────────────────────
      // Runs *before* Build: a built MISSION_CLEAR_ALL emitted on output 0 can
      // be forwarded straight to mavlink-out, so the destructive gate must
      // block construction — not just sending — without an explicit confirm
      // (same lesson as the Command node's Flight Termination Build gate).
      if (operation === OPERATION.CLEAR && !(config.confirmClear || msg.confirmed === true)) {
        const rec = record(operation, missionTypeKey, target, {
          result: 'failed',
          phase: 'unconfirmed',
          reason: 'clear is destructive — enable confirmation or set msg.confirmed = true',
        });
        applyActionStatus(node, 'error', `confirm clear ${missionTypeKey}`);
        send([null, rec]);
        done(new Error(`mavlink-mission: ${rec.reason}`));
        return;
      }

      // ── Build tier: emit the protocol plan, send nothing. ─────────────────
      if (delivery === 'build') {
        const plan = buildPlan(operation, missionType, target, uploadItems);
        applyActionStatus(node, 'preview', `plan ${operation} ${missionTypeKey}`);
        send([
          { payload: plan },
          record(operation, missionTypeKey, target, {
            result: 'succeeded',
            phase: 'built',
            messageCount: plan.messages.length,
          }),
        ]);
        done();
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
        send([null, rec]);
        done(new Error(`mavlink-mission: ${rec.reason}`));
        return;
      }

      // Key the in-flight handle the same way as the lock so a fence upload
      // does not cancel an in-flight mission download on this node (§9).
      const lockKey = locks.key(connNode.id, target, missionType);

      applyActionStatus(node, 'sending', `${operation} ${missionTypeKey}\u2026`);

      const machine = createMachine(operation, {
        send: (message) =>
          connNode.send(message, {
            band: BAND.BULK,
            target,
            identityId: payload.identityId || config.identity,
          }),
        subscribe: (filter, handler) => connNode.subscribe(filter, handler),
        target,
        missionType,
        items: uploadItems,
        timeoutMs,
        maxRetries,
        onProgress: (update) => {
          send([
            null,
            record(operation, missionTypeKey, target, { result: 'progress', ...update }),
          ]);
        },
      });
      activeByKey.set(lockKey, machine);

      machine
        .start()
        .then((outcome) => {
          if (activeByKey.get(lockKey) === machine) activeByKey.delete(lockKey);
          release();

          const rec = record(operation, missionTypeKey, target, outcome);
          if (outcome.result === 'succeeded') {
            applyActionStatus(node, 'ok', successBadge(operation, missionTypeKey, outcome));
            send([{ payload: rec }, rec]);
            done();
          } else if (outcome.result === 'cancelled') {
            applyActionStatus(node, 'error', `${operation} ${outcome.result}`);
            send([null, rec]);
            done();
          } else {
            applyActionStatus(node, 'error', `${operation} ${outcome.result}`);
            send([null, rec]);
            const detail = `${operation} ${outcome.result}${outcome.reason ? `: ${outcome.reason}` : ''}`;
            done(new Error(`mavlink-mission: ${detail}`));
          }
        })
        .catch((err) => {
          if (activeByKey.get(lockKey) === machine) activeByKey.delete(lockKey);
          release();
          applyActionStatus(node, 'error', `${operation} error`);
          send([null, record(operation, missionTypeKey, target, {
            result: 'failed',
            phase: 'error',
            reason: err.message,
          })]);
          done(err);
        });
    });

    node.on('close', (done) => {
      for (const machine of activeByKey.values()) machine.cancel();
      activeByKey.clear();
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
    let parsed;
    try {
      parsed = JSON.parse(config.items);
    } catch (err) {
      throw new Error(`mission items config is not valid JSON: ${err.message}`, { cause: err });
    }
    if (!Array.isArray(parsed)) throw new Error('mission items config must be a JSON array');
    return parsed;
  }
  return [];
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
