'use strict';

/**
 * mavlink-mission — palette node (DESIGN.md §3, §9 "Mission protocol",
 * §12 step 7).
 *
 * Runs one of three state machines over the mission item-transfer protocol —
 * download, upload, or clear — for one of three plan types — mission, fence,
 * or rally. All protocol logic lives in `lib/mission`; this node is the thin
 * wrapper (§2): read config, resolve the connection/target, run the machine,
 * and shape the two-output chain (§9).
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
 * Clear carries no confirmation gate: selecting the Clear operation in the
 * editor IS the confirmation (owner ruling, 2026-08-13). The destructive
 * guard this node keeps is the empty-upload refusal — an upload can never
 * degrade into an accidental clear.
 */

const {
  makeStatusRecord,
  shouldSuppress,
  applyActionStatus,
  failInput,
} = require('../lib/delivery');
const { BAND } = require('../lib/connection/bands');
const {
  createMachine,
  validateItems,
  missionTypeValue,
  locks,
  OPERATION,
  buildRequestList,
  buildCount,
  buildClearAll,
  buildItemInt,
} = require('../lib/mission');
const {
  resolveDeliveryContext,
  applyConnectionStatus,
  finiteNumberOr,
} = require('../lib/addressing');

module.exports = function registerMavlinkMission(RED) {
  function MavlinkMissionNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    // No `|| DOWNLOAD`. The editor always saves an operation, so an absent
    // one is drift — and this default is the one that made a SITL node named
    // `ex09-upload` silently *download* (#224). Both tiers now reject it:
    // createMachine on the wire, buildPlan on Build.
    const operation = config.operation;
    const connNode = RED.nodes.getNode(config.connection);
    const delivery = config.delivery;
    applyConnectionStatus(node, delivery !== 'build', connNode);

    /**
     * In-flight machines keyed by the same lock key as {@link locks}
     * (`connection::sysid.compid::missionType`). Different types on one node
     * may run concurrently; only a later message for the *same* key cancels
     * its predecessor.
     *
     * @type {Map<string, {cancel: Function}>}
     */
    const activeByKey = new Map();

    node.on('input', function handleInput(msg, send, done) {
      // A sync throw from an input handler is logged by Node-RED but never
      // completes the message — done() is not called and output 1 stays
      // silent. Everything below that can throw (items JSON, a wire tier
      // whose Connection did not resolve) routes through failInput instead,
      // like every other sender.
      try {
        handle(msg, send, done);
      } catch (err) {
        failInput(node, send, err, done);
      }
    });

    function handle(msg, send, done) {
      if (shouldSuppress(msg)) {
        done();
        return;
      }

      const payload = msg.payload ?? {};
      const missionTypeKey = payload.missionType || config.missionType;

      const { target } = resolveDeliveryContext(RED, {
        delivery,
        config,
        payload,
        connectionNode: connNode,
      });

      // The vehicle judges type support: a stack that does not carry this type
      // answers the transfer with a MAV_MISSION_UNSUPPORTED ack (upload) or
      // stays silent until the transfer deadline (download) — operational
      // failures the existing paths already report loud (§9). The editor's
      // Type dropdown is the firmware protector (§11). No `|| 'mission'`
      // default: a blank or unknown key throws here (missionTypeValue craters
      // on both), routed through failInput — the editor always saves a member.
      const missionType = missionTypeValue(missionTypeKey);

      // Per-step timeout / retry count (owner ruling, 2026-08-14, the
      // timer half of the selection-typo audit). Blank keeps the library
      // default; a present non-finite value used to coerce silently —
      // `setTimeout(fn, NaN)` (`lib/mission/transfer.js`) substitutes ~1 ms
      // instead of refusing, turning a hand-edited 'abc' step timeout into a
      // retry storm rather than the configured cadence. Neither value
      // reaches the wire, so nothing downstream catches it the way wire.js
      // catches an integer field.
      const timeoutMs = finiteNumberOr(config.timeout, undefined, 'Mission step timeout');
      const maxRetries = finiteNumberOr(config.maxRetries, undefined, 'Mission max retries');

      // A download or upload is a two-way conversation with one vehicle: the
      // machine subscribes exact-match on the target sysid, and no vehicle
      // sources sysid 0 — a broadcast transfer starts the protocol on every
      // vehicle on the link and can never match a reply (§10 refuses mission
      // transfer steps for fan-out for the same reason). Refused on every
      // tier: a built broadcast plan forwarded to mavlink-out is the same
      // fleet-wide transfer. Clear stays a single addressed message that
      // legitimately fans out (§10) and is not gated here.
      if (target.sysid === 0 && operation !== OPERATION.CLEAR) {
        const rec = record(operation, missionTypeKey, target, {
          result: 'failed',
          phase: 'broadcast',
          reason: `mission ${operation} cannot target broadcast (sysid 0) — no vehicle answers as sysid 0; address one vehicle`,
        });
        applyActionStatus(node, 'error', `no broadcast ${operation}`);
        send([null, rec]);
        done(new Error(`mavlink-mission: ${rec.reason}`));
        return;
      }

      // Upload item source: msg.payload.items overrides configured items.
      let uploadItems = [];
      if (operation === OPERATION.UPLOAD) {
        uploadItems = resolveItems(config, payload);
        // MISSION_COUNT 0 is the wire's "erase the plan": an empty upload
        // would silently clear the vehicle mission and report success,
        // bypassing the confirmation gate the explicit Clear path has (#241).
        // The items source is dynamic (payload overrides config), so this is
        // a runtime boundary; refused before anything is built or sent, on
        // every tier.
        if (uploadItems.length === 0) {
          const rec = record(operation, missionTypeKey, target, {
            result: 'failed',
            phase: 'empty',
            reason: 'upload requires at least one item — an empty upload would erase the plan; use the Clear operation instead',
          });
          applyActionStatus(node, 'error', 'no items to upload');
          send([null, rec]);
          done(new Error(`mavlink-mission: ${rec.reason}`));
          return;
        }
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

      // Affirmative tier dispatch (§5): each tier is a whole arm, so a
      // token the `delivery` select cannot save (RED.mavlink.oneOf,
      // mavlink-mission.html) matches nothing and starts no transfer.
      switch (delivery) {
        case 'build':
          buildTier();
          return;
        case 'confirm':
          confirmTier();
          return;
      }
      // No tier matched, so nothing ran. The input is still completed — a
      // message left hanging is worse than one that did nothing.
      done();

      /** Emit the protocol plan on output 0 and send nothing. */
      function buildTier() {
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

      /** Run the transfer machine to its MISSION_ACK. */
      function confirmTier() {
        // An unknown operation matches no createMachine case and comes back
        // undefined; the crater is the start() dereference below, inside the
        // try that frees the lock — a throw between acquire and the promise
        // chain would otherwise hold it until redeploy, every later op on this
        // target reporting "busy" over a transfer that never started (#222).
        // Constructors are store-only; the subscription only opens in start().
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

        // No path leaves the lock held (the stream-handover rule in
        // mavlink-move): a sync throw out of this call — today, the undefined
        // machine's start dereference — frees the lock on its way to failInput.
        // The store waits until start() returns, so close() never iterates a
        // handle that cannot cancel.
        let settled;
        try {
          settled = machine.start();
        } catch (err) {
          release();
          throw err;
        }
        activeByKey.set(lockKey, machine);

        settled
          .then((outcome) => {
            if (activeByKey.get(lockKey) === machine) activeByKey.delete(lockKey);
            release();

            const rec = record(operation, missionTypeKey, target, outcome);
            if (outcome.result === 'succeeded') {
              applyActionStatus(node, 'ok', successBadge(operation, missionTypeKey, outcome));
              send([{ payload: rec }, rec]);
              done();
            } else if (outcome.result === 'cancelled') {
              // A redeploy cancelled the machine: the node is going away, so
              // finish quietly — emitting here would land a record and an error
              // badge on a closed node over a mere deploy (same rule as fanout,
              // formation, command, and payload).
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
      }
    }

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
  switch (operation) {
    case OPERATION.DOWNLOAD:
      messages = [buildRequestList(target, missionType)];
      break;
    case OPERATION.CLEAR:
      messages = [buildClearAll(target, missionType)];
      break;
    case OPERATION.UPLOAD:
      messages = [
        buildCount(target, items.length, missionType),
        ...items.map((item, seq) => buildItemInt(item, target, seq, missionType)),
      ];
      break;
  }
  return { operation, missionType, target, messages };
}

/**
 * Resolve upload items: the payload overrides the configured JSON, which the
 * editor validates (non-empty array or blank) — the runtime just reads it.
 *
 * @param {object} config
 * @param {object} payload
 * @returns {object[]}
 */
function resolveItems(config, payload) {
  if (Array.isArray(payload.items)) return payload.items;
  return config.items && config.items.trim() ? JSON.parse(config.items) : [];
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
