'use strict';

const { setTimeout: delay } = require('node:timers/promises');

const delivery = require('../delivery');
const { streamLocks } = require('../delivery/lock');
const { BAND } = require('../connection/bands');
const { AckWaiter, ackAddressedTo, MAV_RESULT, DEFAULT_TIMEOUT_MS, isGlobalFrame } = require('../command');
const { matchesParamEchoWire } = require('../param');
const { firmwareForAutopilot } = require('../vehicle');
const { offsetLatLon } = require('../formation');

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
 * The two setpoints whose `type_mask` position bits (x=1, y=2, z=4) say
 * whether the packet commands a *coordinate*. Broadcast, an unmasked position
 * converges the whole fleet on one point — a commanded collision — so it is
 * confirm-gated below; velocity/acceleration-only setpoints (all three bits
 * set) are fleet momentum, not convergence, and stay ungated (§10).
 */
const POSITION_SETPOINTS = new Set([
  'SET_POSITION_TARGET_LOCAL_NED',
  'SET_POSITION_TARGET_GLOBAL_INT',
]);

/** type_mask bits that ignore the position triplet (x + y + z). */
const IGNORE_POSITION = 1 + 2 + 4;

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
 * Resolve the selected members from a connection peer table at execution
 * time. Stale components are excluded before any send is built.
 *
 * @param {{snapshot: Function}} peerTable Connection-owned peer table.
 * @param {object} selection Selection config.
 * @returns {object[]} Active autopilot members.
 */
function selectFanoutMembers(peerTable, selection = {}) {
  const mode = selection.mode || 'all';
  // Strict, because this list can arrive on msg.payload: a sysid that is not a
  // uint8 is a bad list, and the only alternative to refusing is dropping it —
  // which sends to the members that did parse and reports success, the partial
  // fan-out parseSysidList exists to prevent. Build tier already refuses here
  // (buildListStub, nodes/mavlink-fanout.js), so this is also what makes one
  // payload behave the same on both tiers. Config lists are editor-validated
  // and pass untouched.
  const wanted = mode === 'list' ? new Set(parseSysidList(selection.sysids)) : null;
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
 * @param {Array<object>} [options.members] Editor-validated member rows
 *   `{sysid, north?, east?, up?, patch?}` (#163). Consulted only when the
 *   payload supplied no `targets` — payload targets are the override of last
 *   resort (§6) and replace config members entirely. Metre offsets convert
 *   here, at message time, against the base message's own position.
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

  // Config members (#163) become the targets array only when the payload
  // supplied none. The derived list still flows through validateTargets: the
  // `command` and broadcast gates below are run-classification policy for
  // *every* patch source, not a second copy of the editor's row validation.
  let targets = options.targets;
  if (targets === undefined && options.members) {
    const derived = memberPatchTargets(options.members, message);
    if (derived.refusal) return refuse(derived.refusal);
    targets = derived.targets;
  }

  const targetsRefusal = validateTargets(targets, mode);
  if (targetsRefusal) return refuse(targetsRefusal);
  const overrides = overridesBySysid(targets);

  // A broadcast puts `target_system = 0` on the wire, so one packet reaches
  // *every* vehicle on the link regardless of the operator's selection (§10
  // "Broadcast"). It therefore cannot honour a filtered or explicit-list
  // selection — refuse rather than silently blast vehicles the operator
  // excluded. Sequential fan-out is the way to command a resolved subset.
  const selection = effectiveSelection(options, targets);
  // No mode validation: the flow author is trusted, on config and on
  // msg.payload alike — a garbage selection is theirs to fix, and anything
  // unrecognised behaves as 'all' (#231, declined by owner ruling).
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

  // A broadcast position setpoint converges every vehicle on the link on one
  // coordinate (target_system 0) — a commanded collision, not a formation — so
  // it needs the same explicit confirm as the safety gate above (§10, #245).
  // Wire-plane check: the built message's type_mask says whether the position
  // axes are commanded; a mask that cannot be read gates (NaN clears no bits —
  // fail closed). Velocity/acceleration-only broadcasts stay ungated.
  if (mode === 'broadcast' && POSITION_SETPOINTS.has(message.name)
      && (Number(message.fields.type_mask) & IGNORE_POSITION) !== IGNORE_POSITION
      && options.confirmed !== true) {
    return refuse('broadcast position setpoint converges every vehicle on one coordinate — requires msg.confirmed === true (or node confirmation); velocity/acceleration-only setpoints broadcast ungated');
  }

  const members = selectFanoutMembers(options.connection.peerTable, selection);
  const warnings = mode === 'broadcast' ? broadcastWarnings(members) : [];
  if (members.length === 0) {
    // The record carries the resolved selection mode because the node's
    // loud/quiet decision branches on it (#226): a filter matching zero
    // vehicles is an answer; a named list or 'all' reaching nobody is a fault.
    return {
      ...aggregateRecord({
        result: 'empty',
        success: false,
        mode,
        message,
        members: [],
        warnings,
        detail: 'selection resolved to no active vehicles',
        elapsed: now(options) - startedAt,
      }),
      selection: selectionMode,
    };
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

  // The sequential lock check, on the broadcast plane: one packet reaches
  // every vehicle and cannot exclude the one another node is streaming to, so
  // a single held lock refuses the whole broadcast (#245, mirrors the
  // stale-peer refusal in executeFanout).
  if (options.kind.band === BAND.STREAMING) {
    const locked = members.filter((member) => streamLocks.isHeld(options.connection.id, member));
    if (locked.length > 0) {
      return aggregateRecord({
        result: 'refused',
        success: false,
        mode: 'broadcast',
        message: options.message,
        members: [],
        warnings,
        detail: `a setpoint stream to ${locked.map((m) => `${m.sysid}.${m.compid}`).join(', ')} is already running on this connection — broadcast cannot exclude it; stop the stream first`,
        elapsed: now(options) - startedAt,
      });
    }
  }

  try {
    if (deliveryTier(options) === 'confirm') {
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

  // Single-owner setpoint streams (#245): a vehicle another node is actively
  // streaming to must not receive a contradictory one-shot setpoint — the two
  // producers alternate and the vehicle oscillates while both report success
  // (lib/delivery/lock). Checked at dispatch, on the wire tiers only: the
  // lock guards sends. Fan-out holds nothing itself — a one-shot has no
  // lifetime to own, and a stream that starts after it supersedes it the same
  // way Move's own handover setpoint does.
  if (options.kind.band === BAND.STREAMING && streamLocks.isHeld(options.connection.id, member)) {
    return memberRecord(member, {
      result: 'refused',
      success: false,
      message,
      detail: `a setpoint stream to ${member.sysid}.${member.compid} is already running on this connection — stop it before fanning out setpoints`,
    });
  }

  try {
    if (tier === 'confirm') {
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
    // different GCS on a shared link. Null when the sending identity cannot
    // resolve, which leaves the gate off.
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
    resultParam2: outcome.resultParam2,
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
        // Broadcast confirm collects acks itself rather than through
        // AckWaiter, so the §9 field has to be read off the frame here too.
        resultParam2: fields.result_param2,
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
    resultParam2: fields.resultParam2 === undefined ? null : fields.resultParam2,
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
    // `command` decides the run's classification, confirmation and safety gate,
    // all resolved ONCE from the base message before any patch is applied. A
    // patch that rewrote it would send a different operation than the one that
    // was gated — `{sysid: 1, command: 185}` under a base of ARM put Flight
    // Termination on the wire with no confirmation. A per-member command is a
    // different message, not a replication: refuse it loudly.
    if (typeof entry === 'object' && entry !== null && Object.prototype.hasOwnProperty.call(entry, 'command')) {
      return 'targets may not patch `command` — the run is classified and safety-gated once from the base message; send a different message instead';
    }
  }
  return null;
}

/**
 * The position surfaces Fan-out can offset in metres (#163) — the same
 * carrier facts mavlink-formation's per-member patches use: COMMAND_INT rides
 * lat/lon on x/y as degE7 with alt on z; COMMAND_LONG rides them on
 * param5/param6 as float degrees with alt on param7;
 * SET_POSITION_TARGET_GLOBAL_INT on lat_int/lon_int degE7 with alt. All three
 * global alt fields are up-positive. SET_POSITION_TARGET_LOCAL_NED is metres
 * in NED — offsets apply directly, and z is down-positive (up subtracts).
 */
const POSITION_SURFACES = {
  COMMAND_INT: { lat: 'x', lon: 'y', alt: 'z', scale: 1e7, frameField: 'frame' },
  // No frame rides the LONG wire, so a non-location command's param5-7 cannot
  // be told apart from coordinates here — operator's contract (#196).
  COMMAND_LONG: { lat: 'param5', lon: 'param6', alt: 'param7', scale: 1 },
  SET_POSITION_TARGET_GLOBAL_INT: { lat: 'lat_int', lon: 'lon_int', alt: 'alt', scale: 1e7, frameField: 'coordinate_frame' },
  SET_POSITION_TARGET_LOCAL_NED: { local: true },
};

/** MAV_FRAME_LOCAL_NED — the one local frame where "north" is the x axis. */
const FRAME_LOCAL_NED = 1;

/**
 * Config member rows → the targets array in the §10 per-target patch shape.
 * The rows themselves are editor-validated and trusted; only the metre
 * offsets need work here, because they convert at message time against the
 * base message's own position — lib/formation's flat-earth math
 * (offsetLatLon), never a second copy. Refusals: offsets on a message with no
 * known position surface, a non-finite base coordinate (the built message is
 * runtime payload input), and formation's near-pole refusal.
 *
 * @param {Array<object>} members `{sysid, north?, east?, up?, patch?}` rows
 * @param {{name: string, fields: object}} message
 * @returns {{targets: Array<object>}|{refusal: string}}
 */
function memberPatchTargets(members, message) {
  const targets = [];
  for (const member of members) {
    const patch = member.patch ? { ...member.patch } : {};
    if (member.north !== undefined || member.east !== undefined || member.up !== undefined) {
      const surface = POSITION_SURFACES[message.name];
      if (!surface) {
        return {
          refusal: `member ${member.sysid} has metre offsets but ${message.name} has no position surface to offset — `
            + 'offsets need COMMAND_INT, COMMAND_LONG, SET_POSITION_TARGET_GLOBAL_INT, or SET_POSITION_TARGET_LOCAL_NED',
        };
      }
      try {
        Object.assign(patch, offsetPatch(surface, message, member));
      } catch (err) {
        return { refusal: `member ${member.sysid} offsets: ${err.message}` };
      }
    }
    // Row sysid wins over anything in the raw patch — a patch carrying its
    // own `sysid` would silently retarget the row to a different vehicle.
    targets.push({ ...patch, sysid: member.sysid });
  }
  return { targets };
}

/**
 * One member's metre offsets as wire-unit field patches against the base
 * message's own position. Only the axes the row actually set are patched.
 *
 * @param {object} surface POSITION_SURFACES entry for the message
 * @param {{name: string, fields: object}} message
 * @param {{north?: number, east?: number, up?: number}} member
 * @returns {object} wire-unit field patch
 */
function offsetPatch(surface, message, member) {
  const patch = {};
  // The metre math below is the measured global form (degE7, §14) plus strict
  // LOCAL_NED metres. COMMAND_INT and the setpoints scale x/y BY FRAME — a
  // local frame is metres ×1e4, so pushing it through the degE7 path turns a
  // commanded 10 m into ~9 cm — and body frames re-aim "north" along the
  // vehicle's own heading. Anything but the measured frames refuses loudly
  // rather than applying the wrong scale or axis; a raw patch still works.
  if (surface.local) {
    const frame = Number(message.fields.coordinate_frame);
    if (frame !== FRAME_LOCAL_NED) {
      throw new Error(
        `coordinate_frame ${message.fields.coordinate_frame} is not LOCAL_NED — "north" would follow the body axis, not north; patch raw fields instead`);
    }
    // NED metres: offsets apply directly; z is down-positive, so up subtracts.
    if (member.north !== undefined) patch.x = baseCoord(message, 'x') + member.north;
    if (member.east !== undefined) patch.y = baseCoord(message, 'y') + member.east;
    if (member.up !== undefined) patch.z = baseCoord(message, 'z') - member.up;
    return patch;
  }
  if (surface.frameField && !isGlobalFrame(Number(message.fields[surface.frameField]))) {
    throw new Error(
      `${surface.frameField} ${message.fields[surface.frameField]} is not a global frame — local x/y scale ×1e4 (§14), not degE7; patch raw fields instead`);
  }
  if (member.north !== undefined || member.east !== undefined) {
    const at = offsetLatLon(
      baseCoord(message, surface.lat) / surface.scale,
      baseCoord(message, surface.lon) / surface.scale,
      member.north || 0,
      member.east || 0
    );
    patch[surface.lat] = surface.scale === 1 ? at.lat : Math.round(at.lat * surface.scale);
    patch[surface.lon] = surface.scale === 1 ? at.lon : Math.round(at.lon * surface.scale);
  }
  // Global altitude fields are up-positive: up adds directly.
  if (member.up !== undefined) patch[surface.alt] = baseCoord(message, surface.alt) + member.up;
  return patch;
}

/**
 * A base coordinate read from the built message — runtime payload input, so a
 * non-finite value refuses loudly rather than putting NaN math on the wire.
 *
 * @param {{name: string, fields: object}} message
 * @param {string} field
 * @returns {number}
 */
function baseCoord(message, field) {
  const value = Number(message.fields[field]);
  if (!Number.isFinite(value)) {
    throw new Error(`${message.name}.${field} is not a finite number to offset from`);
  }
  return value;
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
 * Selection, honouring a `targets` list (runtime payload or derived from
 * config members): when present it *is* the selection — explicit-list
 * semantics over the listed sysids — so the caller cannot ask for one group
 * and patch another.
 *
 * @param {object} options
 * @param {Array<number|object>|undefined} targets
 * @returns {object}
 */
function effectiveSelection(options, targets) {
  if (Array.isArray(targets)) {
    return {
      mode: 'list',
      sysids: targets.map((entry) =>
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
  selectFanoutMembers,
  parseSysidList,
};
