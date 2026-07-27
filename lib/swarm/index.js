'use strict';

const delivery = require('../delivery');
const { BAND } = require('../connection/bands');
const {
  AckWaiter,
  MAV_RESULT,
  getPreset,
  buildParamArray,
} = require('../command');
const { buildMoveMessage } = require('../move');
const { buildParamMessage, matchesParamEcho } = require('../param');
const { buildPayloadMessage } = require('../payload');

const AUTOPILOT_FIRMWARE = {
  3: 'ardupilot',
  12: 'px4',
};

const DEFAULT_INTERVAL_MS = 100;
const DEFAULT_TIMEOUT_MS = 10000;

/** `MAV_CMD_DO_FLIGHTTERMINATION` — safety command, confirmation required (§10). */
const DO_FLIGHTTERMINATION = 185;

/**
 * Apply the shared action-node input guard for Swarm.
 *
 * @param {object} msg Node-RED message.
 * @returns {{action:'suppress'}|{action:'refuse', record: object}|{action:'proceed'}}
 */
function guardSwarmInput(msg) {
  if (delivery.shouldSuppress(msg)) return { action: 'suppress' };
  const refused = delivery.refuseIfStatus(msg);
  if (refused) {
    return {
      action: 'refuse',
      record: delivery.makeStatusRecord({
        node: 'mavlink-swarm',
        result: 'refused',
        detail: refused.reason,
        timestamp: refused.timestamp,
      }),
    };
  }
  return { action: 'proceed' };
}

/**
 * Resolve the selected swarm members from a connection peer table at execution
 * time. Stale components are excluded before any send is built.
 *
 * @param {{snapshot: Function}} peerTable Connection-owned peer table.
 * @param {object} selection Selection config.
 * @returns {object[]} Active autopilot members.
 */
function selectSwarmMembers(peerTable, selection = {}) {
  const mode = selection.mode || 'all';
  const wanted = mode === 'list' ? new Set(parseSysids(selection.sysids)) : null;
  const filter = selection.filter || {};
  const members = [];

  for (const peer of peerTable.snapshot()) {
    const autopilot = autopilotComponent(peer);
    if (!autopilot || !isActive(autopilot)) continue;
    if (wanted && !wanted.has(peer.sysid)) continue;

    const member = memberFrom(peer.sysid, autopilot);
    if (mode === 'filter' && !matchesFilter(member, filter)) continue;
    members.push(member);
  }

  return members.sort((a, b) => a.sysid - b.sysid);
}

/**
 * Execute one wrapped single-message action across the selected swarm and
 * return the aggregate status record for output 1. `continue` is true only when
 * every selected member succeeded.
 *
 * @param {object} options
 * @param {object} options.connection Connection node with send/subscribe/peerTable.
 * @param {object} options.action Wrapped action config.
 * @param {'sequential'|'broadcast'} [options.mode]
 * @param {'build'|'send'|'confirm'|'sendConfirm'} [options.delivery]
 * @param {object} [options.selection]
 * @param {boolean} [options.dryRun]
 * @param {number} [options.intervalMs]
 * @param {(ms:number) => Promise<void>} [options.wait]
 * @returns {Promise<object>} Aggregate status record.
 */
async function executeSwarm(options) {
  const mode = options.mode || 'sequential';
  const action = options.action || {};
  const validation = validateWrap(action, mode);
  const startedAt = now(options);

  if (validation) {
    return aggregateRecord({
      result: 'refused',
      success: false,
      mode,
      action,
      members: [],
      warnings: [],
      detail: validation,
      elapsed: now(options) - startedAt,
    });
  }

  // A broadcast puts `target_system = 0` on the wire, so one packet reaches
  // *every* vehicle on the link regardless of the operator's selection (§10
  // "Broadcast"). It therefore cannot honour a filtered or explicit-list
  // selection — refuse rather than silently blast vehicles the operator
  // excluded. Sequential fan-out is the way to command a resolved subset.
  const selectionMode = (options.selection && options.selection.mode) || 'all';
  if (mode === 'broadcast' && selectionMode !== 'all') {
    return aggregateRecord({
      result: 'refused',
      success: false,
      mode,
      action,
      members: [],
      warnings: [],
      detail: `broadcast reaches every vehicle on the link (target_system 0) and cannot honour a "${selectionMode}" selection — use sequential fan-out to command a subset`,
      elapsed: now(options) - startedAt,
    });
  }

  // Safety commands (Flight Termination and any requiresConfirmation preset)
  // must not fan out — one broadcast or sequential run terminates the whole
  // fleet — without an explicit confirm (§10, mirrors the Command node gate).
  const confirmationRefusal = confirmationRefused(action, options);
  if (confirmationRefusal) {
    return aggregateRecord({
      result: 'refused',
      success: false,
      mode,
      action,
      members: [],
      warnings: [],
      detail: confirmationRefusal,
      elapsed: now(options) - startedAt,
    });
  }

  const members = selectSwarmMembers(options.connection.peerTable, options.selection);
  const warnings = mode === 'broadcast' ? broadcastWarnings(members) : [];
  if (members.length === 0) {
    return aggregateRecord({
      result: 'empty',
      success: false,
      mode,
      action,
      members: [],
      warnings,
      detail: 'selection resolved to no active vehicles',
      elapsed: now(options) - startedAt,
    });
  }

  // Even with selection mode "all", stale/expired peers are dropped from the
  // resolved group (§10). Broadcast cannot honour that exclusion on the wire
  // (target_system 0 still reaches them), so refuse and require sequential.
  if (mode === 'broadcast' && hasInactiveAutopilotPeers(options.connection.peerTable)) {
    return aggregateRecord({
      result: 'refused',
      success: false,
      mode,
      action,
      members: [],
      warnings,
      detail: 'broadcast reaches every vehicle on the link including stale/expired peers excluded from the group — use sequential fan-out',
      elapsed: now(options) - startedAt,
    });
  }

  if (mode === 'broadcast') {
    return executeBroadcast(options, members, warnings, startedAt);
  }
  return executeSequential(options, members, warnings, startedAt);
}

async function executeSequential(options, members, warnings, startedAt) {
  const records = [];
  const wait = options.wait || sleep;
  const intervalMs = Number(options.intervalMs === undefined ? DEFAULT_INTERVAL_MS : options.intervalMs);

  for (let i = 0; i < members.length; i += 1) {
    const member = members[i];
    const live = currentMemberState(options.connection.peerTable, member);
    if (!live.active) {
      records.push(memberRecord(member, {
        result: 'failed',
        success: false,
        detail: `member ${live.state}`,
      }));
    } else {
      records.push(await executeMember(options, member));
    }
    if (i < members.length - 1 && intervalMs > 0) await wait(intervalMs);
  }

  return aggregateFromMembers(options, 'sequential', records, warnings, startedAt);
}

async function executeBroadcast(options, members, warnings, startedAt) {
  const target = { sysid: 0, compid: 1 };
  const built = buildWrappedMessage(options.action, target, { firmware: uniformFirmware(members) });

  if (options.dryRun || deliveryTier(options) === 'build') {
    const records = members.map((member) => memberRecord(member, {
      result: options.dryRun ? 'dry_run' : 'built',
      success: true,
      message: retargetForMember(built.message, member),
    }));
    return aggregateFromMembers(options, 'broadcast', records, warnings, startedAt, built.message);
  }

  try {
    if (deliveryTier(options) === 'confirm' || deliveryTier(options) === 'sendConfirm') {
      const records = await confirmBroadcast(options, members, built, target);
      return aggregateFromMembers(options, 'broadcast', records, warnings, startedAt, built.message);
    }

    options.connection.send(built.message, sendOptions(options, built, target));
    const records = members.map((member) => memberRecord(member, {
      result: 'sent',
      success: true,
      message: built.message,
    }));
    return aggregateFromMembers(options, 'broadcast', records, warnings, startedAt, built.message);
  } catch (err) {
    const records = members.map((member) => memberRecord(member, {
      result: 'failed',
      success: false,
      message: built.message,
      detail: err.message,
    }));
    return aggregateFromMembers(options, 'broadcast', records, warnings, startedAt, built.message);
  }
}

async function executeMember(options, member) {
  const built = buildWrappedMessage(options.action, member, member);
  const tier = deliveryTier(options);

  if (options.dryRun || tier === 'build') {
    return memberRecord(member, {
      result: options.dryRun ? 'dry_run' : 'built',
      success: true,
      message: built.message,
    });
  }

  try {
    if (tier === 'confirm' || tier === 'sendConfirm') {
      return await confirmMember(options, member, built);
    }

    options.connection.send(built.message, sendOptions(options, built, member));
    return memberRecord(member, {
      result: 'sent',
      success: true,
      message: built.message,
    });
  } catch (err) {
    return memberRecord(member, {
      result: 'failed',
      success: false,
      message: built.message,
      detail: err.message,
    });
  }
}

async function confirmMember(options, member, built) {
  if (built.confirmation === 'param_echo') {
    return confirmParamMember(options, member, built);
  }
  if (built.confirmation !== 'command_ack') {
    options.connection.send(built.message, sendOptions(options, built, member));
    return memberRecord(member, { result: 'sent', success: true, message: built.message });
  }

  const waiter = new AckWaiter({
    subscribe: (filter, handler) => options.connection.subscribe(filter, handler),
    sendFn: (confirmation) => {
      const resent = buildWrappedMessage(options.action, member, member, confirmation);
      options.connection.send(resent.message, sendOptions(options, resent, member));
    },
    commandId: built.commandId,
    targetSysid: member.sysid,
    targetCompid: member.compid,
    timeoutMs: timeoutMs(options),
    maxRetries: options.maxRetries === undefined ? 0 : Number(options.maxRetries),
  });
  const outcome = await waiter.start();

  return memberRecord(member, {
    result: outcome.result,
    success: outcome.result === 'accepted',
    message: built.message,
    detail: outcome.detail,
    confirmedBy: outcome.confirmedBy,
    resultCode: outcome.resultCode,
  });
}

function confirmParamMember(options, member, built) {
  return new Promise((resolve) => {
    let settled = false;
    const unsubscribe = options.connection.subscribe({ message: 'PARAM_VALUE' }, (decoded) => {
      if (decoded.sysid !== undefined && decoded.sysid !== member.sysid) return;
      if (!matchesParamEcho(built.paramRequest, decoded)) return;
      settle({
        result: 'accepted',
        success: true,
        message: built.message,
        confirmedBy: 'echo',
      });
    });
    const timeout = setTimeout(() => {
      settle({
        result: 'unconfirmed',
        success: false,
        message: built.message,
        confirmedBy: 'none',
        detail: 'no PARAM_VALUE echo received within timeout',
      });
    }, timeoutMs(options));

    function settle(fields) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      unsubscribe();
      resolve(memberRecord(member, fields));
    }

    options.connection.send(built.message, sendOptions(options, built, member));
  });
}

function confirmBroadcast(options, members, built, target) {
  if (built.confirmation !== 'command_ack') {
    options.connection.send(built.message, sendOptions(options, built, target));
    return Promise.resolve(members.map((member) => memberRecord(member, {
      result: 'sent',
      success: true,
      message: built.message,
    })));
  }

  return new Promise((resolve) => {
    const pending = new Map(members.map((member) => [member.sysid, member]));
    const records = [];
    const unsubscribe = options.connection.subscribe({ message: 'COMMAND_ACK' }, (decoded) => {
      const fields = decoded.fields || {};
      if (fields.command !== built.commandId || !pending.has(decoded.sysid)) return;
      // Match the addressed component (autopilot 1), not the system alone. On a
      // multi-component vehicle a gimbal/companion COMMAND_ACK shares this
      // subscription; matching sysid-only would let it settle the autopilot's
      // command (§10, mirrors AckWaiter._matchesSource).
      if (target.compid !== 0 && decoded.compid !== undefined && decoded.compid !== target.compid) return;
      if (fields.result === MAV_RESULT.IN_PROGRESS) return;
      const member = pending.get(decoded.sysid);
      pending.delete(decoded.sysid);
      records.push(memberRecord(member, {
        result: fields.result === MAV_RESULT.ACCEPTED ? 'accepted' : `result_${fields.result}`,
        success: fields.result === MAV_RESULT.ACCEPTED,
        message: built.message,
        confirmedBy: 'ack',
        resultCode: fields.result,
      }));
      if (pending.size === 0) settle();
    });
    const timeout = setTimeout(settle, timeoutMs(options));
    options.connection.send(built.message, sendOptions(options, built, target));

    function settle() {
      clearTimeout(timeout);
      unsubscribe();
      for (const member of pending.values()) {
        records.push(memberRecord(member, {
          result: 'unconfirmed',
          success: false,
          message: built.message,
          confirmedBy: 'none',
          detail: 'no COMMAND_ACK received within timeout',
        }));
      }
      pending.clear();
      resolve(records.sort((a, b) => a.sysid - b.sysid));
    }
  });
}

function aggregateFromMembers(options, mode, members, warnings, startedAt, message = null) {
  const success = members.every((member) => member.success);
  return aggregateRecord({
    result: options.dryRun ? 'dry_run' : (success ? 'succeeded' : 'failed'),
    success,
    mode,
    action: options.action,
    members,
    warnings,
    message,
    detail: success ? null : 'one or more swarm members failed',
    elapsed: now(options) - startedAt,
  });
}

function aggregateRecord(fields) {
  return delivery.makeStatusRecord({
    node: 'mavlink-swarm',
    result: fields.result,
    success: fields.success,
    continue: fields.success,
    mode: fields.mode,
    action: fields.action.type,
    count: fields.members.length,
    members: fields.members,
    warnings: fields.warnings,
    message: fields.message || null,
    detail: fields.detail || null,
    elapsed: fields.elapsed,
  });
}

function memberRecord(member, fields) {
  return {
    sysid: member.sysid,
    compid: member.compid,
    result: fields.result,
    success: fields.success,
    message: fields.message || null,
    detail: fields.detail || null,
    confirmedBy: fields.confirmedBy || 'none',
    resultCode: fields.resultCode === undefined ? null : fields.resultCode,
  };
}

function validateWrap(action, mode) {
  if (action.type === 'mission') return 'Mission actions are multi-message transactions and cannot be wrapped by Swarm';
  if (action.type === 'param' && action.action === 'request-list') {
    return 'Param request-list is a bulk transfer and cannot be wrapped by Swarm';
  }
  if (action.type === 'param' && action.action !== 'set') {
    return 'Swarm only wraps Param set-one actions';
  }
  if (action.type === 'param' && mode === 'broadcast') {
    return 'Param set is sequential-only; broadcast Param set is refused';
  }
  if (!['command', 'move', 'payload', 'param'].includes(action.type)) {
    return `unknown Swarm action ${JSON.stringify(action.type)}`;
  }
  if (action.type === 'command') {
    const preset = action.preset ? getPreset(action.preset) : null;
    if (!preset && !Number.isFinite(Number(action.commandId))) {
      return 'Command action requires a numeric commandId or a preset';
    }
    if (preset && !Number.isFinite(Number(preset.commandId))) {
      return `preset ${JSON.stringify(action.preset)} has no numeric commandId`;
    }
  }
  if (action.type === 'move' && action.mode === 'global-position') {
    const p = action.position || {};
    if (!isPresentCoordinate(p.lat) || !isPresentCoordinate(p.lon)) {
      return 'Move global-position requires lat and lon (blank coordinates must not become 0,0)';
    }
  }
  return null;
}

/** @param {*} value */
function isPresentCoordinate(value) {
  if (value === undefined || value === null || value === '') return false;
  return Number.isFinite(Number(value));
}

/**
 * True when the peer table still tracks an autopilot that selection would
 * exclude as stale/expired — those vehicles would still hear a broadcast.
 *
 * @param {object} peerTable
 * @returns {boolean}
 */
function hasInactiveAutopilotPeers(peerTable) {
  for (const peer of peerTable.snapshot()) {
    const autopilot = autopilotComponent(peer);
    if (autopilot && !isActive(autopilot)) return true;
  }
  return false;
}

function buildWrappedMessage(action, target, member, confirmation = 0) {
  if (action.type === 'command') return buildCommand(action, target, confirmation);
  if (action.type === 'move') {
    return {
      message: buildMoveMessage({ ...action, target }),
      confirmation: 'none',
      band: BAND.STREAMING,
    };
  }
  if (action.type === 'payload') {
    const built = buildPayloadMessage({ ...action, target });
    return {
      ...built,
      band: BAND.CONTROL,
      commandId: built.message.fields.command,
    };
  }
  const paramRequest = {
    ...action,
    target,
    firmware: action.firmware || member.firmware || 'ardupilot',
  };
  return {
    message: buildParamMessage(paramRequest),
    confirmation: 'param_echo',
    band: BAND.CONTROL,
    paramRequest,
  };
}

/**
 * Whether a Command action requires an explicit confirm that was not given.
 * Returns a refusal detail string when the gate blocks, or null to proceed.
 *
 * A preset carries `requiresConfirmation`; a raw command id of
 * `DO_FLIGHTTERMINATION` (185) is treated the same even without a preset, so a
 * hand-entered id cannot bypass the gate (§10 safety).
 *
 * @param {object} action  wrapped action config
 * @param {object} options  execute options; `options.confirmed === true` clears
 * @returns {string|null}
 */
function confirmationRefused(action, options) {
  if (action.type !== 'command') return null;
  if (options.confirmed === true) return null;
  const preset = action.preset ? getPreset(action.preset) : null;
  const commandId = preset ? Number(preset.commandId) : Number(action.commandId);
  const needsConfirm = (preset && preset.requiresConfirmation) || commandId === DO_FLIGHTTERMINATION;
  if (!needsConfirm) return null;
  return 'safety command requires msg.confirmed === true (or node confirmation) before it can be swarmed';
}

function buildCommand(action, target, confirmation) {
  const preset = action.preset ? getPreset(action.preset) : null;
  // A preset owns its command id; do not fall back to a leftover default
  // `action.commandId` (e.g. 400) that the editor may carry when a preset is
  // selected (§9, §10). validateWrap already refused missing/non-numeric ids.
  const commandId = preset ? Number(preset.commandId) : Number(action.commandId);
  if (!Number.isFinite(commandId) || commandId <= 0) {
    throw new Error(`Swarm command requires a positive numeric commandId, got ${JSON.stringify(action.commandId)}`);
  }
  const params = preset
    ? buildParamArray(preset, action.params || {})
    : [1, 2, 3, 4, 5, 6, 7].map((index) => keepParam((action.params || {})[index]));

  return {
    message: {
      name: 'COMMAND_LONG',
      fields: {
        target_system: target.sysid,
        target_component: target.compid,
        command: commandId,
        confirmation,
        param1: params[0],
        param2: params[1],
        param3: params[2],
        param4: params[3],
        param5: params[4],
        param6: params[5],
        param7: params[6],
      },
    },
    confirmation: 'command_ack',
    band: BAND.CONTROL,
    commandId,
  };
}

function retargetForMember(message, member) {
  return {
    ...message,
    fields: {
      ...message.fields,
      target_system: member.sysid,
      target_component: member.compid,
    },
  };
}

function sendOptions(options, built, target) {
  return {
    band: built.band,
    target: { sysid: target.sysid, compid: target.compid },
    identityId: options.identityId,
  };
}

function currentMemberState(peerTable, member) {
  if (typeof peerTable.getComponent !== 'function') return { active: true, state: 'active' };
  const component = peerTable.getComponent(member.sysid, member.compid);
  if (!component) return { active: false, state: 'expired' };
  if (!isActive(component)) return { active: false, state: component.state || 'inactive' };
  return { active: true, state: component.state || 'active' };
}

function autopilotComponent(peer) {
  return (peer.components || []).find((component) => component.compid === 1);
}

function memberFrom(sysid, component) {
  return {
    sysid,
    compid: component.compid,
    type: component.type,
    autopilot: component.autopilot,
    firmware: component.firmware || AUTOPILOT_FIRMWARE[component.autopilot] || null,
    armed: component.armed,
    flightMode: component.flightMode,
    state: component.state,
  };
}

function isActive(component) {
  return component.state !== 'stale' && component.state !== 'expired';
}

function matchesFilter(member, filter) {
  if (filter.type !== undefined && Number(filter.type) !== Number(member.type)) return false;
  if (filter.firmware && String(filter.firmware) !== String(member.firmware)) return false;
  if (filter.armed !== undefined && booleanFilter(filter.armed) !== member.armed) return false;
  return true;
}

function booleanFilter(value) {
  if (value === true || value === 'true' || value === 'armed') return true;
  if (value === false || value === 'false' || value === 'disarmed') return false;
  return Boolean(value);
}

function parseSysids(value) {
  if (Array.isArray(value)) return value.map(Number);
  return String(value || '')
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

function broadcastWarnings(members) {
  const warnings = [];
  if (unique(members.map((member) => member.firmware).filter(Boolean)).length > 1) {
    warnings.push('mixed firmware in broadcast selection; uniform params may not mean the same thing on every stack');
  }
  if (unique(members.map((member) => member.flightMode).filter((mode) => mode !== null && mode !== undefined)).length > 1) {
    warnings.push('mixed flight modes in broadcast selection');
  }
  return warnings;
}

function uniformFirmware(members) {
  const firmwares = unique(members.map((member) => member.firmware).filter(Boolean));
  return firmwares.length === 1 ? firmwares[0] : undefined;
}

function unique(values) {
  return [...new Set(values)];
}

function deliveryTier(options) {
  return options.delivery || 'build';
}

function timeoutMs(options) {
  return Number(options.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : options.timeoutMs);
}

function now(options) {
  return options.now ? options.now() : Date.now();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Coerce an advanced command param, preserving a caller-supplied `NaN`.
 *
 * `NaN` is a meaningful COMMAND_LONG value ("leave this field unchanged" for
 * several MAV_CMDs such as CONDITION_YAW rate); `value || 0` would silently
 * rewrite it to 0. Only genuinely absent params default to 0 (§9). Presets go
 * through `buildParamArray`, which already preserves NaN.
 *
 * @param {*} value
 * @returns {number}
 */
function keepParam(value) {
  return value === undefined || value === null ? 0 : Number(value);
}

module.exports = {
  executeSwarm,
  guardSwarmInput,
  selectSwarmMembers,
};
