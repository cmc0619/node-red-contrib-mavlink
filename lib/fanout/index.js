'use strict';

const { setTimeout: delay } = require('node:timers/promises');

const delivery = require('../delivery');
const { BAND } = require('../connection/bands');
const { AckWaiter, ackAddressedTo, MAV_RESULT, DEFAULT_TIMEOUT_MS } = require('../command');
const { matchesParamEchoWire } = require('../param');
const { firmwareForAutopilot } = require('../vehicle');

const DEFAULT_INTERVAL_MS = 100;

/** `MAV_CMD_DO_FLIGHTTERMINATION` — safety command, confirmation required (§10). */
const DO_FLIGHTTERMINATION = 185;

/**
 * Mission messages that are *steps in a transfer the vehicle drives* — the
 * exclusion §10 actually justifies. Named explicitly rather than matched on
 * the `MISSION_` prefix, because the prefix over-refuses: `MISSION_SET_CURRENT`
 * ("jump to waypoint N") and `MISSION_CLEAR_ALL` are single-shot addressed
 * commands that fan out perfectly well, and a custom dialect's `MISSION_*`
 * message would be refused sight unseen. The vehicle→GCS members of the family
 * (`MISSION_CURRENT`, `MISSION_ITEM_REACHED`) need no entry — they carry no
 * `target_system` and the addressing check already refuses them.
 */
const MISSION_TRANSFER_STEPS = new Set([
  'MISSION_REQUEST_PARTIAL_LIST',
  'MISSION_WRITE_PARTIAL_LIST',
  'MISSION_ITEM',
  'MISSION_ITEM_INT',
  'MISSION_REQUEST',
  'MISSION_REQUEST_INT',
  'MISSION_REQUEST_LIST',
  'MISSION_COUNT',
  'MISSION_ACK',
]);

/**
 * Offboard setpoints: high-rate, superseded by the next one, and therefore the
 * streaming band's whole reason for existing (§ "Queue bands"). Named
 * explicitly for the same reason as above — a `SET_POSITION_TARGET_` prefix
 * silently left `SET_ATTITUDE_TARGET` and `SET_ACTUATOR_CONTROL_TARGET` on the
 * control band, where a 50 Hz stream competes with arm/RTL for the queue.
 */
const STREAMING_SETPOINTS = new Set([
  'SET_POSITION_TARGET_LOCAL_NED',
  'SET_POSITION_TARGET_GLOBAL_INT',
  'SET_ATTITUDE_TARGET',
  'SET_ACTUATOR_CONTROL_TARGET',
]);

/**
 * Fan-out is a replicator, not an action node (§10): it takes one *built*
 * message — the `{name, fields}` shape every action node's Build tier and
 * mavlink-build emit — and replicates it across the selected group, retargeting
 * `target_system`/`target_component` per member. What the message *means* is
 * inferred from its name; how it is confirmed rides along:
 *
 * | name | confirmation | band |
 * |---|---|---|
 * | COMMAND_LONG / COMMAND_INT | COMMAND_ACK | control |
 * | PARAM_SET | wire-plane PARAM_VALUE echo, sequential only | control |
 * | SET_POSITION_TARGET_* | none — setpoints carry no ack | streaming |
 * | anything else with a target_system field | none | control |
 * | MISSION_* / PARAM_REQUEST_LIST | refused — multi-message / bulk transfer | — |
 *
 * @param {{name: string, fields: object}} message
 * @param {'sequential'|'broadcast'} mode
 * @returns {{kind: object}|{refusal: string}}
 */
function classifyMessage(message, mode) {
  if (!message || typeof message.name !== 'string' || !message.name || typeof message.fields !== 'object' || message.fields === null) {
    return { refusal: 'Fan-out replicates a built message — wire a Build-tier action node (or mavlink-build) into it, so msg.payload carries {name, fields}' };
  }
  const name = message.name;
  if (MISSION_TRANSFER_STEPS.has(name)) {
    return { refusal: `${name} is a step in a multi-message mission transfer the vehicle drives and cannot be replicated by Fan-out` };
  }
  if (name === 'PARAM_REQUEST_LIST') {
    return { refusal: 'PARAM_REQUEST_LIST triggers a bulk transfer and cannot be replicated by Fan-out' };
  }
  if (message.fields.target_system === undefined) {
    return { refusal: `${name} has no target_system field — Fan-out retargets per member and cannot address it` };
  }
  if (name === 'COMMAND_LONG' || name === 'COMMAND_INT') {
    return { kind: { confirmation: 'command_ack', band: BAND.CONTROL, commandId: Number(message.fields.command) } };
  }
  if (name === 'PARAM_SET') {
    if (mode === 'broadcast') {
      return { refusal: 'PARAM_SET is sequential-only; a broadcast set makes the confirm echoes a storm (§10)' };
    }
    return { kind: { confirmation: 'param_echo', band: BAND.CONTROL } };
  }
  if (STREAMING_SETPOINTS.has(name)) {
    return { kind: { confirmation: 'none', band: BAND.STREAMING } };
  }
  return { kind: { confirmation: 'none', band: BAND.CONTROL } };
}

/**
 * Apply the shared action-node input guard for Fan-out.
 *
 * @param {object} msg Node-RED message.
 * @returns {{action:'suppress'}|{action:'proceed'}}
 */
function guardFanoutInput(msg) {
  if (delivery.shouldSuppress(msg)) return { action: 'suppress' };
  return { action: 'proceed' };
}

/**
 * Resolve the selected members from a connection peer table at execution
 * time. Stale components are excluded before any send is built.
 *
 * @param {{snapshot: Function}} peerTable Connection-owned peer table.
 * @param {object} selection Selection config.
 * @returns {object[]} Active autopilot members.
 */
function selectFanoutMembers(peerTable, selection = {}) {
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
 * Replicate one built message across the selected members and return the
 * aggregate status record for output 1. `continue` is true only when every
 * selected member succeeded.
 *
 * @param {object} options
 * @param {object} options.connection Connection node with send/subscribe/peerTable.
 * @param {{name: string, fields: object}} options.message Built message to replicate.
 * @param {Array<number|object>} [options.targets] Per-target list: sysids, or
 *   `{sysid, ...fieldPatches}` objects whose remaining keys patch the message
 *   fields for that member (wire units — Fan-out is a raw surface). Sequential
 *   only; implies list selection over the listed sysids.
 * @param {'sequential'|'broadcast'} [options.mode]
 * @param {'build'|'send'|'confirm'} [options.delivery]
 * @param {object} [options.selection]
 * @param {boolean} [options.dryRun]
 * @param {number} [options.intervalMs]
 * @param {number} [options.concurrency] Max in-flight members in sequential mode.
 * @param {(ms:number) => Promise<void>} [options.wait]
 * @returns {Promise<object>} Aggregate status record.
 */
async function executeFanout(options) {
  const mode = options.mode || 'sequential';
  const message = options.message;
  const startedAt = now(options);
  const refuse = (detail) => aggregateRecord({
    result: 'refused',
    success: false,
    mode,
    message,
    members: [],
    warnings: [],
    detail,
    elapsed: now(options) - startedAt,
  });

  const classified = classifyMessage(message, mode);
  if (classified.refusal) return refuse(classified.refusal);
  const kind = classified.kind;

  const targetsRefusal = validateTargets(options.targets, mode);
  if (targetsRefusal) return refuse(targetsRefusal);
  const overrides = overridesBySysid(options.targets);

  // A broadcast puts `target_system = 0` on the wire, so one packet reaches
  // *every* vehicle on the link regardless of the operator's selection (§10
  // "Broadcast"). It therefore cannot honour a filtered or explicit-list
  // selection — refuse rather than silently blast vehicles the operator
  // excluded. Sequential fan-out is the way to command a resolved subset.
  const selection = effectiveSelection(options);
  const selectionMode = selection.mode || 'all';
  if (mode === 'broadcast' && selectionMode !== 'all') {
    return refuse(`broadcast reaches every vehicle on the link (target_system 0) and cannot honour a "${selectionMode}" selection — use sequential fan-out to command a subset`);
  }

  // Safety commands must not fan out — one broadcast or sequential run
  // terminates the whole fleet — without an explicit confirm (§10, mirrors the
  // Command node gate). Wire-plane check: the built message carries the id.
  if (kind.confirmation === 'command_ack' && kind.commandId === DO_FLIGHTTERMINATION && options.confirmed !== true) {
    return refuse('safety command requires msg.confirmed === true (or node confirmation) before it can be fanned out');
  }

  const members = selectFanoutMembers(options.connection.peerTable, selection);
  const warnings = mode === 'broadcast' ? broadcastWarnings(members) : [];
  if (members.length === 0) {
    return aggregateRecord({
      result: 'empty',
      success: false,
      mode,
      message,
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
    return refuse('broadcast reaches every vehicle on the link including stale/expired peers excluded from the group — use sequential fan-out');
  }

  const run = { ...options, message, kind, overrides };
  if (mode === 'broadcast') {
    return executeBroadcast(run, members, warnings, startedAt);
  }
  return executeSequential(run, members, warnings, startedAt);
}

async function executeSequential(options, members, warnings, startedAt) {
  const records = new Array(members.length);
  const wait = options.wait || sleep;
  const intervalMs = Number(options.intervalMs === undefined ? DEFAULT_INTERVAL_MS : options.intervalMs);
  const concurrency = Math.max(1, Number(options.concurrency) || 1);
  const stopOnError = !!options.stopOnError;
  const signal = options.signal;

  // Up to `concurrency` members in flight at once (§10 "Concurrency"): a slow
  // or timing-out straggler no longer delays the rest by timeout × retries.
  // The inter-member pause still paces every *launch* but the first, so at
  // concurrency 1 the launch/pause/launch cadence is exactly the sequential
  // loop this replaced. Aborts (redeploy) halt further launches; members
  // already in flight are cut short by the signal inside confirmMember.
  const inFlight = new Set();
  const anyFailed = () => records.some((record) => record && !record.success);
  const shouldStop = () => stopOnError && anyFailed();
  let stopped = false;
  let i = 0;
  for (; i < members.length; i += 1) {
    while (inFlight.size >= concurrency && !(signal && signal.aborted)) {
      await Promise.race(inFlight);
    }
    if (signal && signal.aborted) break;
    // Stop-on-error (§10): halt further launches after the first member that
    // did not succeed — a refused arm on vehicle 1 should not arm 2..N. Only
    // completed records are consulted, so at concurrency 1 the check is
    // deterministic; members already in flight finish and report normally.
    if (shouldStop()) {
      stopped = true;
      break;
    }
    if (i > 0 && intervalMs > 0) await wait(intervalMs, signal);
    if (signal && signal.aborted) break;
    // Re-check: at concurrency > 1 a member launched earlier is still running
    // during the pause above, so the pre-wait verdict is stale by up to
    // intervalMs. A fast failure (a send throw, an immediate denial) landing
    // inside that window would otherwise dispatch the next member anyway.
    if (shouldStop()) {
      stopped = true;
      break;
    }

    // `i` lives outside the for (the skip-fill below needs its final value),
    // so the async completion must capture its own index — writing records[i]
    // from the callback would land on whatever `i` is by then.
    const index = i;
    const member = members[index];
    const live = currentMemberState(options.connection.peerTable, member);
    if (!live.active) {
      records[index] = memberRecord(member, {
        result: 'failed',
        success: false,
        detail: `member ${live.state}`,
      });
      continue;
    }
    const p = executeMember(options, member)
      .then((record) => { records[index] = record; })
      .finally(() => inFlight.delete(p));
    inFlight.add(p);
  }
  await Promise.allSettled(inFlight);
  if (!stopped && !(signal && signal.aborted) && shouldStop()) {
    // The failure may have landed on the last launch (nothing left to gate in
    // the loop) — the flag still marks the run so skipped members are honest.
    stopped = i < members.length;
  }
  if (stopped) {
    // Members never dispatched are reported in member order, so the caller
    // sees exactly which vehicles were not commanded (never silently omitted).
    for (let j = i; j < members.length; j += 1) {
      records[j] = memberRecord(members[j], {
        result: 'skipped',
        success: false,
        detail: 'stop-on-error: an earlier member failed; this member was never sent to',
      });
    }
  }

  return aggregateFromMembers(
    { ...options, memberTotal: members.length },
    'sequential',
    records.filter(Boolean),
    warnings,
    startedAt
  );
}

async function executeBroadcast(options, members, warnings, startedAt) {
  const target = { sysid: 0, compid: 1 };
  const message = retarget(options.message, target);

  if (options.dryRun || deliveryTier(options) === 'build') {
    const records = members.map((member) => memberRecord(member, {
      result: options.dryRun ? 'dry_run' : 'built',
      success: true,
      message: retarget(options.message, member),
    }));
    return aggregateFromMembers(options, 'broadcast', records, warnings, startedAt, message);
  }

  try {
    if (deliveryTier(options) === 'confirm' || deliveryTier(options) === 'sendConfirm') {
      const records = await confirmBroadcast(options, members, message, target);
      return aggregateFromMembers(options, 'broadcast', records, warnings, startedAt, message);
    }

    options.connection.send(message, sendOptions(options, target));
    const records = members.map((member) => memberRecord(member, {
      result: 'sent',
      success: true,
      message,
    }));
    return aggregateFromMembers(options, 'broadcast', records, warnings, startedAt, message);
  } catch (err) {
    const records = members.map((member) => memberRecord(member, {
      result: 'failed',
      success: false,
      message,
      detail: err.message,
    }));
    return aggregateFromMembers(options, 'broadcast', records, warnings, startedAt, message);
  }
}

async function executeMember(options, member) {
  const message = memberMessage(options, member);
  const tier = deliveryTier(options);

  if (options.dryRun || tier === 'build') {
    return memberRecord(member, {
      result: options.dryRun ? 'dry_run' : 'built',
      success: true,
      message,
    });
  }

  try {
    if (tier === 'confirm' || tier === 'sendConfirm') {
      return await confirmMember(options, member, message);
    }

    options.connection.send(message, sendOptions(options, member));
    return memberRecord(member, {
      result: 'sent',
      success: true,
      message,
    });
  } catch (err) {
    return memberRecord(member, {
      result: 'failed',
      success: false,
      message,
      detail: err.message,
    });
  }
}

async function confirmMember(options, member, message) {
  if (options.kind.confirmation === 'param_echo') {
    return confirmParamMember(options, member, message);
  }
  if (options.kind.confirmation !== 'command_ack') {
    options.connection.send(message, sendOptions(options, member));
    return memberRecord(member, { result: 'sent', success: true, message });
  }

  const waiter = new AckWaiter({
    subscribe: (filter, handler) => options.connection.subscribe(filter, handler),
    sendFn: (confirmation) => {
      options.connection.send(withConfirmation(message, confirmation), sendOptions(options, member));
    },
    commandId: options.kind.commandId,
    targetSystem: member.sysid,
    targetComponent: member.compid,
    // Ack attribution (§9/§10): ignore an ack explicitly addressed to a
    // different GCS on a shared link. Optional — a connection stub without
    // the accessor leaves the gate off.
    sourceIds: sourceIds(options),
    timeoutMs: timeoutMs(options),
    maxRetries: options.maxRetries === undefined ? 0 : Number(options.maxRetries),
  });
  // Cut the current member short on abort instead of waiting out its timeout
  // and retries. AckWaiter.cancel() settles the run as 'cancelled'.
  const abortWaiter = () => waiter.cancel();
  if (options.signal) options.signal.addEventListener('abort', abortWaiter, { once: true });
  let outcome;
  try {
    outcome = await waiter.start();
  } finally {
    if (options.signal) options.signal.removeEventListener('abort', abortWaiter);
  }

  return memberRecord(member, {
    result: outcome.result,
    success: outcome.result === 'accepted',
    message,
    detail: outcome.detail,
    confirmedBy: outcome.confirmedBy,
    resultCode: outcome.resultCode,
  });
}

function confirmParamMember(options, member, message) {
  return new Promise((resolve) => {
    let settled = false;
    const unsubscribe = options.connection.subscribe({ message: 'PARAM_VALUE' }, (decoded) => {
      if (!matchesParamEchoWire(message, member, decoded)) return;
      settle({
        result: 'accepted',
        success: true,
        message,
        confirmedBy: 'echo',
      });
    });
    const timeout = setTimeout(() => {
      settle({
        result: 'unconfirmed',
        success: false,
        message,
        confirmedBy: 'none',
        detail: 'no PARAM_VALUE echo received within timeout',
      });
    }, timeoutMs(options));

    // A param echo is not an AckWaiter, so cancel.hold() cannot reach it —
    // without this, close waits out the echo timeout before the node reports
    // closed (Greptile #140).
    if (options.signal) {
      options.signal.addEventListener('abort', () => settle({
        result: 'cancelled',
        success: false,
        message,
        confirmedBy: 'none',
        detail: 'cancelled before the PARAM_VALUE echo arrived',
      }), { once: true });
    }

    function settle(fields) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      unsubscribe();
      resolve(memberRecord(member, fields));
    }

    options.connection.send(message, sendOptions(options, member));
  });
}

function confirmBroadcast(options, members, message, target) {
  if (options.kind.confirmation !== 'command_ack') {
    options.connection.send(message, sendOptions(options, target));
    return Promise.resolve(members.map((member) => memberRecord(member, {
      result: 'sent',
      success: true,
      message,
    })));
  }

  return new Promise((resolve) => {
    const pending = new Map(members.map((member) => [member.sysid, member]));
    const records = [];
    // Declared before anything that can reach settle(). `settle` is hoisted but
    // `settled` is not — a synchronous COMMAND_ACK from subscribe() or send()
    // would hit the temporal dead zone and throw (CodeRabbit #140).
    let settled = false;
    const ourIds = sourceIds(options);
    const unsubscribe = options.connection.subscribe({ message: 'COMMAND_ACK' }, (decoded) => {
      const fields = decoded.fields || {};
      if (fields.command !== options.kind.commandId || !pending.has(decoded.sysid)) return;
      // Match the addressed component (autopilot 1), not the system alone. On a
      // multi-component vehicle a gimbal/companion COMMAND_ACK shares this
      // subscription; matching sysid-only would let it settle the autopilot's
      // command (§10, mirrors AckWaiter._matchesSource).
      if (target.compid !== 0 && decoded.compid !== undefined && decoded.compid !== target.compid) return;
      // Ack attribution (§9/§10): an ack explicitly addressed to a different
      // GCS on a shared link is not ours — the same shared gate AckWaiter uses.
      if (!ackAddressedTo(fields, ourIds)) return;
      if (fields.result === MAV_RESULT.IN_PROGRESS) return;
      const member = pending.get(decoded.sysid);
      pending.delete(decoded.sysid);
      records.push(memberRecord(member, {
        result: fields.result === MAV_RESULT.ACCEPTED ? 'accepted' : `result_${fields.result}`,
        success: fields.result === MAV_RESULT.ACCEPTED,
        message,
        confirmedBy: 'ack',
        resultCode: fields.result,
      }));
      if (pending.size === 0) settle();
    });
    const timeout = setTimeout(settle, timeoutMs(options));
    // Same reason as the param echo: this is a hand-rolled wait, not an
    // AckWaiter, so cancellation has to reach it explicitly or close blocks
    // until every member acks or the timeout fires (Greptile #140). Members
    // still pending are recorded unconfirmed, and the aggregate reports the
    // run as cancelled.
    if (options.signal) options.signal.addEventListener('abort', settle, { once: true });
    options.connection.send(message, sendOptions(options, target));

    function settle() {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      unsubscribe();
      for (const member of pending.values()) {
        records.push(memberRecord(member, {
          result: 'unconfirmed',
          success: false,
          message,
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
  // A cancelled run is not a failed one. The distinction is load-bearing: the
  // node reports `cancelled` quietly instead of raising, so a redeploy cannot
  // trip a Catch node wired for "fan-out failed → failsafe".
  const cancelled = !!(options.signal && options.signal.aborted);
  return aggregateRecord({
    result: options.dryRun
      ? 'dry_run'
      : (cancelled ? 'cancelled' : (success ? 'succeeded' : 'failed')),
    success: cancelled ? false : success,
    mode,
    message: options.message,
    members,
    warnings,
    broadcastMessage: message,
    detail: cancelled
      ? `cancelled after ${members.length} of ${memberTotal(options, members)} members`
      : (success ? null : 'one or more members failed'),
    elapsed: now(options) - startedAt,
  });
}

/**
 * How many members the run was going to cover, for the cancelled detail line.
 * The records array stops at the cancellation point, so it cannot say this.
 *
 * @param {object} options
 * @param {Array} members  records produced before the run stopped
 * @returns {number}
 */
function memberTotal(options, members) {
  return options.memberTotal === undefined ? members.length : options.memberTotal;
}

function aggregateRecord(fields) {
  return delivery.makeStatusRecord({
    node: 'mavlink-fanout',
    result: fields.result,
    success: fields.success,
    continue: fields.success,
    mode: fields.mode,
    action: fields.message ? fields.message.name : null,
    count: fields.members.length,
    members: fields.members,
    warnings: fields.warnings,
    message: fields.broadcastMessage || null,
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

/**
 * Per-target list validation (§10 "Per-target overrides"). Targets are
 * runtime-boundary input: a malformed entry must refuse, not quietly fall back
 * to the shared message — `{}` lookups on the wrong shape return undefined,
 * and every vehicle would silently receive the same message the caller meant
 * to differentiate.
 *
 * @param {*} targets
 * @param {'sequential'|'broadcast'} mode
 * @returns {string|null}
 */
function validateTargets(targets, mode) {
  if (targets === undefined || targets === null) return null;
  if (!Array.isArray(targets)) {
    return 'targets must be an array of sysids or {sysid, ...fieldPatches} objects';
  }
  // A broadcast packet carries one field set — uniform messages only (§10).
  if (mode === 'broadcast') {
    return 'broadcast carries one field set (uniform messages only, §10); targets requires sequential fan-out';
  }
  for (const entry of targets) {
    const sysid = typeof entry === 'object' && entry !== null ? entry.sysid : entry;
    const n = Number(sysid);
    if (!Number.isInteger(n) || n < 1 || n > 255) {
      return `targets entries need a sysid in 1..255 (got ${JSON.stringify(entry)})`;
    }
    if (typeof entry === 'object' && (Array.isArray(entry) || entry === null)) {
      return 'targets entries must be sysids or plain {sysid, ...fieldPatches} objects';
    }
  }
  return null;
}

/**
 * @param {Array<number|object>|undefined} targets
 * @returns {Map<number, object>|null} field patches keyed by sysid
 */
function overridesBySysid(targets) {
  if (!Array.isArray(targets)) return null;
  const map = new Map();
  for (const entry of targets) {
    if (typeof entry === 'object' && entry !== null) {
      const { sysid, ...patch } = entry;
      map.set(Number(sysid), patch);
    } else {
      map.set(Number(entry), {});
    }
  }
  return map;
}

/**
 * Selection, honouring a runtime `targets` list: when present it *is* the
 * selection — explicit-list semantics over the listed sysids — so the caller
 * cannot ask for one group and patch another.
 *
 * @param {object} options
 * @returns {object}
 */
function effectiveSelection(options) {
  if (Array.isArray(options.targets)) {
    return {
      mode: 'list',
      sysids: options.targets.map((entry) =>
        typeof entry === 'object' && entry !== null ? Number(entry.sysid) : Number(entry)
      ),
    };
  }
  return options.selection || {};
}

/**
 * The message one member receives: retargeted, patched with that member's
 * field overrides (wire units — Fan-out is a raw surface, § "unit conversion
 * belongs to exactly one of two surfaces"), with `target_system` forced back
 * to the member so a patch cannot cross-address another vehicle.
 *
 * @param {object} options
 * @param {{sysid:number, compid:number}} member
 * @returns {{name: string, fields: object}}
 */
function memberMessage(options, member) {
  const patch = { ...((options.overrides && options.overrides.get(member.sysid)) || {}) };
  // Addressing belongs to Fan-out, not to the patch (§10 "Fan-out addresses
  // each member's autopilot"). Both keys are stripped before the merge rather
  // than re-pinned after it, which covers the two distinct ways a patch could
  // break addressing: re-aiming a message that *does* declare the field — the
  // wire message would then disagree with `sendOptions` and the confirm
  // waiter, both keyed on `member.compid`, so the autopilot ignores the
  // command and the ack wait times out — and *inventing* the field on a
  // message that never declared it (`retarget` is careful not to; a patch must
  // be too).
  delete patch.target_system;
  delete patch.target_component;
  const base = retarget(options.message, member);
  return { ...base, fields: { ...base.fields, ...patch } };
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

function retarget(message, member) {
  const fields = { ...message.fields, target_system: member.sysid };
  // Messages addressing a system but not a component (e.g. SET_MODE) keep
  // their shape — do not invent a field the message does not declare.
  if (message.fields.target_component !== undefined) fields.target_component = member.compid;
  return { ...message, fields };
}

/**
 * The COMMAND_LONG retry counter: `confirmation` increments per resend so the
 * vehicle can deduplicate. COMMAND_INT declares no such field — leave it be.
 *
 * @param {{name: string, fields: object}} message
 * @param {number} confirmation
 * @returns {{name: string, fields: object}}
 */
function withConfirmation(message, confirmation) {
  if (message.name !== 'COMMAND_LONG' || !confirmation) return message;
  return { ...message, fields: { ...message.fields, confirmation } };
}

/**
 * Our own source sysid/compid for ack attribution (§9/§10). Null when the
 * sending identity cannot resolve — the gate stays off, the send path stays
 * the loud failure.
 *
 * @param {object} options
 * @returns {{sysid: number, compid: number}|null}
 */
function sourceIds(options) {
  return options.connection.resolveSourceIds(options.identityId);
}

function sendOptions(options, target) {
  return {
    band: options.kind.band,
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
    firmware: component.firmware || firmwareForAutopilot(component.autopilot) || null,
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

/**
 * Parse a comma-separated sysid list. Each id must be an integer in 1..255
 * (MAVLink system id is a uint8; 0 is broadcast and not a member).
 * Bad tokens fail loudly — silently dropping `256` would send a partial fan-out.
 *
 * @param {string|string[]} value
 * @returns {number[]}
 */
function parseSysidList(value) {
  const parts = Array.isArray(value)
    ? value.map((part) => String(part).trim())
    : String(value || '').split(',').map((part) => part.trim());
  const ids = [];
  for (const part of parts) {
    if (part === '') continue;
    const n = Number(part);
    if (!Number.isInteger(n) || n < 1 || n > 255) {
      throw new Error(
        `mavlink-fanout: sysid must be an integer in 1..255 (got ${JSON.stringify(part)})`
      );
    }
    ids.push(n);
  }
  return ids;
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

/**
 * Inter-member pause, cut short when `signal` aborts.
 *
 * `timers/promises` disposes the timer on abort, so a redeploy does not leave
 * the event loop held open for the rest of a pause nobody is waiting for. The
 * AbortError is the expected exit, not a failure.
 *
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
async function sleep(ms, signal) {
  try {
    await delay(ms, undefined, { signal });
  } catch {
    // Aborted: the caller checks `signal.aborted` and stops.
  }
}

module.exports = {
  executeFanout,
  classifyMessage,
  guardFanoutInput,
  selectFanoutMembers,
  parseSysidList,
};
