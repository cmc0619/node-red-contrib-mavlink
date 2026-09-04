'use strict';

const { setTimeout: delay } = require('node:timers/promises');

const delivery = require('../delivery');
const { streamLocks } = require('../delivery/lock');
const { BAND } = require('../connection/bands');
const { ackWaiterFor, ackAddressedTo, MAV_RESULT, isGlobalFrame } = require('../command');
const { MAV_FRAME } = require('../command/carrier');
const { matchesParamEchoWire, resolveParamEncoding } = require('../param');
const { firmwareForAutopilot } = require('../vehicle');
const { offsetLatLon } = require('../formation');

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
 * | anything else | none | control |
 *
 * @param {{name: string, fields: object}} message
 * @returns {{kind: object}}
 */
function classifyMessage(message) {
  const name = message.name;
  if (name === 'COMMAND_LONG' || name === 'COMMAND_INT') {
    return { kind: { confirmation: 'command_ack', band: BAND.CONTROL, commandId: message.fields.command } };
  }
  if (name === 'PARAM_SET') {
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
 * @param {boolean} [activeOnly]
 * @returns {object[]} Autopilot members.
 */
function selectFanoutMembers(peerTable, selection, activeOnly = true) {
  let keep;
  switch (selection.mode) {
    case 'all':
      keep = () => true;
      break;
    case 'list': {
      // Entries are coerced, never vetted (parseSysidList): the editor bounds
      // every configured sysid, and a payload list is trusted runtime input —
      // an entry that names no vehicle selects none, and the aggregate record
      // names the members that were actually selected.
      const wanted = new Set(parseSysidList(selection.sysids));
      keep = (member) => wanted.has(member.sysid);
      break;
    }
    case 'filter':
      keep = (member) => matchesFilter(member, selection.filter);
      break;
    default: break; // This space intentionally left blank (§5)
  }

  const members = [];
  for (const peer of peerTable.snapshot()) {
    const autopilot = autopilotComponent(peer);
    if (!autopilot || (activeOnly && !isActive(autopilot))) continue;
    const member = memberFrom(peer.sysid, autopilot);
    if (!keep(member)) continue;
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
 * @param {string} options.nodeType The calling node's registered type
 *   (`node.type`), stamped into the aggregate record's `node` field — both
 *   mavlink-fanout and mavlink-formation run through here, and an aggregate
 *   must name the node that emitted it, not the library.
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
 * @param {object} [options.selection]  the group to command; consulted only
 *   when no `targets` list (given or derived) names the group itself
 * @param {number} [options.intervalMs]
 * @param {number} [options.concurrency] Max in-flight members in sequential mode.
 * @param {AbortSignal} options.signal The run's abort signal — every caller's
 *   in-flight tracker supplies one; the aggregate reads it to report a
 *   cancelled run.
 * @param {(ms:number) => Promise<void>} [options.wait]
 * @returns {Promise<object>|object|undefined} Aggregate status record
 *   (Promise from broadcast/sequential; plain object when empty; undefined
 *   when no mode matched).
 */
function executeFanout(options) {
  const mode = options.mode;
  const message = options.message;
  const startedAt = Date.now();
  const kind = classifyMessage(message).kind;

  // Config members (#163) become the targets array only when the payload
  // supplied none.
  let targets = options.targets;
  if (targets === undefined && options.members) {
    targets = memberPatchTargets(options.members, message);
  }

  const overrides = overridesBySysid(targets);

  // A `targets` list *is* the selection — explicit-list semantics over the
  // listed sysids — so the caller cannot ask for one group and patch another.
  let selection = targets === undefined
    ? options.selection
    : { mode: 'list', sysids: [...overrides.keys()] };
  let activeOnly = true;
  switch (mode) {
    case 'broadcast':
      selection = { mode: 'all' };
      activeOnly = false;
      break;
    case 'sequential': break;
    default: break; // This space intentionally left blank (§5)
  }
  const selectionMode = selection.mode;

  const members = selectFanoutMembers(options.connection.peerTable, selection, activeOnly);
  if (members.length === 0) {
    // The record carries the resolved selection mode because the node's
    // loud/quiet decision branches on it (#226): a filter matching zero
    // vehicles is an answer; a named list or 'all' reaching nobody is a fault.
    return {
      ...aggregateRecord(options.nodeType, {
        result: 'empty',
        success: false,
        mode,
        message,
        members: [],
        warnings: [],
        detail: 'selection resolved to no vehicles',
        elapsed: Date.now() - startedAt,
      }),
      selection: selectionMode,
    };
  }

  const run = { ...options, message, kind, overrides };
  switch (mode) {
    case 'broadcast':
      return executeBroadcast(run, members, startedAt);
    case 'sequential':
      return executeSequential(run, members, startedAt);
    default: break; // This space intentionally left blank (§5)
  }
  return undefined; // nothing matched: no behavior selected (§5)
}

async function executeSequential(options, members, startedAt) {
  const records = new Array(members.length);
  const wait = options.wait || sleep;
  const intervalMs = Number(options.intervalMs);
  // The editor validator requires an integer >= 1 and owns the default (1,
  // strictly sequential). No clamp — the runtime trusts the saved config.
  const concurrency = Number(options.concurrency);
  const stopOnError = options.stopOnError;
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
  // Capacity gate for the launch loop. The Set it reads is drained from
  // outside the loop — every launched member deletes itself from `inFlight`
  // in its own .finally, and the race's await yields to those handlers. The
  // editor rings concurrency to an integer >= 1; the saved value is read as
  // it is.
  const atCapacity = () => inFlight.size >= concurrency && !signal.aborted;
  let stopped = false;
  let i = 0;
  for (; i < members.length; i += 1) {
    while (atCapacity()) {
      await Promise.race(inFlight);
    }
    if (signal.aborted) break;
    // Stop-on-error (§10): halt further launches after the first member that
    // did not succeed — a refused arm on vehicle 1 should not arm 2..N. Only
    // completed records are consulted, so at concurrency 1 the check is
    // deterministic; members already in flight finish and report normally.
    if (shouldStop()) {
      stopped = true;
      break;
    }
    if (i > 0) await wait(intervalMs, signal);
    if (signal.aborted) break;
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
    // The rejection arm is the §9 aggregate guard: executeMember catches its
    // dispatch arms itself, but the section before them can still throw, and
    // an unhandled rejection is swallowed by the allSettled below —
    // records[index] stays a hole, the member vanishes from the aggregate,
    // and stop-on-error never sees the failure. Recording it also keeps `p`
    // from rejecting, so the capacity race above cannot rethrow mid-run.
    const p = executeMember(options, member)
      .then(
        (record) => { records[index] = record; },
        (err) => {
          records[index] = memberRecord(member, {
            result: 'failed',
            success: false,
            // A payload getter can throw any value; dereferencing a null
            // reason here would crash the arm and re-open the hole it closes.
            detail: err && err.message ? err.message : String(err),
          });
        }
      )
      .finally(() => inFlight.delete(p));
    inFlight.add(p);
  }
  await Promise.allSettled(inFlight);
  if (!stopped && !signal.aborted && shouldStop()) {
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

  // Sequential runs carry no fleet-uniformity warnings: each member is
  // addressed individually.
  return aggregateFromMembers(
    options, 'sequential', records.filter(Boolean), [], startedAt, null, members.length
  );
}

async function executeBroadcast(options, members, startedAt) {
  const target = { sysid: 0, compid: 1 };
  const message = retarget(options.message, target);
  const warnings = broadcastWarnings(members);

  try {
    switch (options.delivery) {
      case 'build': {
        const records = members.map((member) => memberRecord(member, {
          result: 'built',
          success: true,
          message: retarget(options.message, member),
        }));
        return aggregateFromMembers(options, 'broadcast', records, warnings, startedAt, message);
      }
      case 'confirm': {
        const refused = broadcastStreamRefusal(options, members, warnings, startedAt);
        if (refused) return refused;
        const records = await confirmBroadcast(options, members, message, target);
        return aggregateFromMembers(options, 'broadcast', records, warnings, startedAt, message);
      }
      case 'send': {
        const refused = broadcastStreamRefusal(options, members, warnings, startedAt);
        if (refused) return refused;
        options.connection.send(message, sendOptions(options, target));
        const records = members.map((member) => memberRecord(member, {
          result: 'sent',
          success: true,
          message,
        }));
        return aggregateFromMembers(options, 'broadcast', records, warnings, startedAt, message);
      }
      default: break; // This space intentionally left blank (§5)
    }
    return aggregateFromMembers(
      options,
      'broadcast',
      members.map((member) => unmatchedTierRecord(options, member, message)),
      warnings,
      startedAt,
      message
    );
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

/**
 * The sequential lock check, on the broadcast plane: one packet reaches
 * every vehicle and cannot exclude the one another node is streaming to, so
 * a single held lock refuses the whole broadcast (#245, mirrors the
 * stale-peer refusal in executeFanout). Owned by the wire tiers — each arm
 * invokes it before touching the wire; Build constructs and sends nothing,
 * so it has no lock to respect. Null when the broadcast may proceed.
 *
 * @param {object} options
 * @param {object[]} members  the resolved group
 * @param {string[]} warnings
 * @param {number} startedAt
 * @returns {object|null} refusal aggregate, or null
 */
function broadcastStreamRefusal(options, members, warnings, startedAt) {
  if (options.kind.band !== BAND.STREAMING) return null;
  const locked = members.filter((member) => streamLocks.isHeld(options.connection.id, member));
  if (locked.length === 0) return null;
  return aggregateRecord(options.nodeType, {
    result: 'refused',
    success: false,
    mode: 'broadcast',
    message: options.message,
    members: [],
    warnings,
    detail: `a setpoint stream to ${locked.map((m) => `${m.sysid}.${m.compid}`).join(', ')} is already running on this connection — broadcast cannot exclude it; stop the stream first`,
    elapsed: Date.now() - startedAt,
  });
}

async function executeMember(options, member) {
  const message = memberMessage(options, member);

  try {
    switch (options.delivery) {
      case 'build':
        return memberRecord(member, {
          result: 'built',
          success: true,
          message,
        });
      case 'confirm': {
        const refused = streamLockRefusal(options, member, message);
        if (refused) return refused;
        return await confirmMember(options, member, message);
      }
      case 'send': {
        const refused = streamLockRefusal(options, member, message);
        if (refused) return refused;
        options.connection.send(message, sendOptions(options, member));
        return memberRecord(member, {
          result: 'sent',
          success: true,
          message,
        });
      }
      default: break; // This space intentionally left blank (§5)
    }
    return unmatchedTierRecord(options, member, message);
  } catch (err) {
    return memberRecord(member, {
      result: 'failed',
      success: false,
      message,
      detail: err.message,
    });
  }
}

/**
 * Single-owner setpoint streams (#245): a vehicle another node is actively
 * streaming to must not receive a contradictory one-shot setpoint — the two
 * producers alternate and the vehicle oscillates while both report success
 * (lib/delivery/lock). Owned by the wire tiers — each arm invokes it before
 * touching the wire, because the lock guards sends and Build sends nothing.
 * Fan-out holds nothing itself — a one-shot has no lifetime to own, and a
 * stream that starts after it supersedes it the same way Move's own handover
 * setpoint does. Null when the send may proceed.
 *
 * @param {object} options
 * @param {{sysid: number, compid: number}} member
 * @param {{name: string, fields: object}} message
 * @returns {object|null} refused member record, or null
 */
function streamLockRefusal(options, member, message) {
  if (options.kind.band !== BAND.STREAMING) return null;
  if (!streamLocks.isHeld(options.connection.id, member)) return null;
  return memberRecord(member, {
    result: 'refused',
    success: false,
    message,
    detail: `a setpoint stream to ${member.sysid}.${member.compid} is already running on this connection — stop it before fanning out setpoints`,
  });
}

/**
 * Confirm one member on the message kind's own confirmation (§5): a
 * COMMAND_ACK wait, a PARAM_VALUE echo, or a plain send for a kind that
 * carries no acknowledgement.
 */
function confirmMember(options, member, message) {
  switch (options.kind.confirmation) {
    case 'command_ack': return confirmAckMember(options, member, message);
    case 'param_echo': return confirmParamMember(options, member, message);
    case 'none':
      options.connection.send(message, sendOptions(options, member));
      return memberRecord(member, { result: 'sent', success: true, message });
    default: break; // This space intentionally left blank (§5)
  }
  return undefined; // nothing matched: no behavior selected (§5)
}

async function confirmAckMember(options, member, message) {
  const waiter = ackWaiterFor(options.connection, message, {
    band: options.kind.band,
    target: { sysid: member.sysid, compid: member.compid },
    identityId: options.identityId,
    timeoutMs: Number(options.timeoutMs),
    maxRetries: Number(options.maxRetries),
  });
  // Cut the current member short on abort instead of waiting out its timeout
  // and retries. AckWaiter.cancel() settles the run as 'cancelled'.
  const abortWaiter = () => waiter.cancel();
  options.signal.addEventListener('abort', abortWaiter, { once: true });
  let outcome;
  try {
    outcome = await waiter.start();
  } finally {
    options.signal.removeEventListener('abort', abortWaiter);
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
  // The type half of the echo match only means anything on bytewise (§10, §14).
  // The replicator holds a built frame, never the request that encoded it, so
  // the encoding comes from the connection's one bound Vehicle Profile — the
  // same firmware every member on this link decodes against.
  const encoding = resolveParamEncoding({ firmware: options.connection.vehicle.firmware });
  const { timeoutMs } = options;
  return new Promise((resolve) => {
    let settled = false;
    // Named so settle() can detach it: the signal is the run's, shared by
    // every member, and a member settled by echo or timeout must not leave its
    // abort closure behind for the rest of the fleet run (the AckWaiter
    // wrapper in confirmMember does the same). Declared before the subscribe
    // so a synchronous echo reaching settle cannot hit the temporal dead zone.
    const abortSettle = () => settle({
      result: 'cancelled',
      success: false,
      message,
      confirmedBy: 'none',
      detail: 'cancelled before the PARAM_VALUE echo arrived',
    });
    // trustedOnly: an untrusted-marked echo must not confirm the write (§7
    // trust ruling #264); plain unsigned links carry no mark and pass.
    const unsubscribe = options.connection.subscribe({ message: 'PARAM_VALUE', trustedOnly: true }, (decoded) => {
      if (!matchesParamEchoWire(message, member, decoded, encoding)) return;
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
    }, Number(timeoutMs));

    // A param echo is not an AckWaiter, so cancel.hold() cannot reach it —
    // without this, close waits out the echo timeout before the node reports
    // closed (Greptile #140).
    options.signal.addEventListener('abort', abortSettle, { once: true });

    function cleanup() {
      clearTimeout(timeout);
      unsubscribe();
      options.signal.removeEventListener('abort', abortSettle);
    }

    function settle(fields) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(memberRecord(member, fields));
    }

    // The wait is armed before the send, so a send that throws must take the
    // timer, subscription, and abort listener down with it — the rejection
    // reports the member failed (executeMember's catch), and nothing may
    // outlive that verdict for the full echo window.
    try {
      options.connection.send(message, sendOptions(options, member));
    } catch (err) {
      settled = true;
      cleanup();
      throw err;
    }
  });
}

function confirmBroadcast(options, members, message, target) {
  // One frame to the broadcast address; only a COMMAND_ACK kind has anything
  // to wait for (§5). A PARAM_SET broadcast has no per-member echo to match,
  // so it reports 'sent' like a kind with no acknowledgement.
  switch (options.kind.confirmation) {
    case 'command_ack': return confirmBroadcastAck(options, members, message, target);
    case 'param_echo':
    case 'none':
      options.connection.send(message, sendOptions(options, target));
      return Promise.resolve(members.map((member) => memberRecord(member, {
        result: 'sent',
        success: true,
        message,
      })));
    default: break; // This space intentionally left blank (§5)
  }
  return undefined; // nothing matched: no behavior selected (§5)
}

function confirmBroadcastAck(options, members, message, target) {
  const { timeoutMs } = options;
  return new Promise((resolve) => {
    const pending = new Map(members.map((member) => [member.sysid, member]));
    const records = [];
    // Declared before anything that can reach settle(). `settle` is hoisted but
    // `settled` is not — a synchronous COMMAND_ACK from subscribe() or send()
    // would hit the temporal dead zone and throw (CodeRabbit #140).
    let settled = false;
    const ourIds = options.connection.resolveSourceIds(options.identityId);
    // trustedOnly: an untrusted-marked ack must not settle a member (§7 trust
    // ruling #264); plain unsigned links carry no mark and pass.
    const unsubscribe = options.connection.subscribe({ message: 'COMMAND_ACK', trustedOnly: true }, (decoded) => {
      const fields = decoded.fields;
      if (fields.command !== options.kind.commandId || !pending.has(decoded.sysid)) return;
      // Match the addressed component (autopilot 1), not the system alone. On a
      // multi-component vehicle a gimbal/companion COMMAND_ACK shares this
      // subscription; matching sysid-only would let it settle the autopilot's
      // command (§10, mirrors AckWaiter._matchesSource).
      if (target.compid !== 0 && decoded.compid !== target.compid) return;
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
    const timeout = setTimeout(() => settle(), Number(timeoutMs));
    // Same reason as the param echo: this is a hand-rolled wait, not an
    // AckWaiter, so cancellation has to reach it explicitly or close blocks
    // until every member acks or the timeout fires (Greptile #140). Members
    // still pending are recorded unconfirmed, and the aggregate reports the
    // run as cancelled.
    options.signal.addEventListener('abort', settle, { once: true });
    // Same rule as the param-echo wait: the resources were armed before the
    // send, so a send that throws takes them down before its rejection lands
    // in executeBroadcast's catch (every member reported failed there).
    try {
      options.connection.send(message, sendOptions(options, target));
    } catch (err) {
      settled = true;
      cleanup();
      throw err;
    }

    function cleanup() {
      clearTimeout(timeout);
      unsubscribe();
      // The signal outlives this broadcast (it is the run's): an ack or
      // timeout settle must detach the abort handler, not leave it to
      // accumulate on the shared signal.
      options.signal.removeEventListener('abort', settle);
    }

    function settle() {
      if (settled) return;
      settled = true;
      cleanup();
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

/**
 * @param {number} [total]  how many members the run was going to cover, for
 *   the cancelled detail line — a sequential run's records stop at the
 *   cancellation point, so they cannot say this themselves.
 */
function aggregateFromMembers(
  options, mode, members, warnings, startedAt, message = null, total = members.length
) {
  const success = members.every((member) => member.success);
  // A cancelled run is not a failed one. The distinction is load-bearing: the
  // node reports `cancelled` quietly instead of raising, so a redeploy cannot
  // trip a Catch node wired for "fan-out failed → failsafe".
  const cancelled = options.signal.aborted;
  return aggregateRecord(options.nodeType, {
    result: cancelled ? 'cancelled' : (success ? 'succeeded' : 'failed'),
    success: cancelled ? false : success,
    mode,
    message: options.message,
    members,
    warnings,
    broadcastMessage: message,
    detail: cancelled
      ? `cancelled after ${members.length} of ${total} members`
      : (success ? null : 'one or more members failed'),
    elapsed: Date.now() - startedAt,
  });
}

function aggregateRecord(nodeType, fields) {
  return delivery.makeStatusRecord(nodeType, {
    result: fields.result,
    success: fields.success,
    continue: fields.success,
    mode: fields.mode,
    action: fields.message.name,
    count: fields.members.length,
    members: fields.members,
    warnings: fields.warnings,
    message: fields.broadcastMessage || null,
    detail: fields.detail || null,
    elapsed: fields.elapsed,
  });
}

/**
 * The record for a member no delivery-tier arm reached.
 *
 * Reported rather than thrown or dropped: `aggregateFromMembers` counts
 * through `records.filter(Boolean)`, so a dropped member would aggregate as a
 * success — §2's phantom success by another door. §0 rule 3: an operational
 * outcome is a record, never a validation throw and never silence.
 *
 * One owner, because the broadcast and per-member paths both need it and
 * `detail` is the only thing an operator has to tell them what happened.
 *
 * @param {object} options
 * @param {{sysid: number, compid: number}} member
 * @param {object} message
 * @returns {object}
 */
function unmatchedTierRecord(options, member, message) {
  return memberRecord(member, {
    result: 'failed',
    success: false,
    message,
    detail: `no delivery tier matched ${JSON.stringify(options.delivery)}`,
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

/**
 * Config member rows → the targets array in the §10 per-target patch shape.
 * The rows themselves are editor-validated and trusted; only the metre
 * offsets need work here, because they convert at message time against the
 * base message's own position — lib/formation's flat-earth math
 * (offsetLatLon), never a second copy.
 *
 * @param {Array<object>} members `{sysid, north?, east?, up?, patch?}` rows
 * @param {{name: string, fields: object}} message
 * @returns {Array<object>}
 */
function memberPatchTargets(members, message) {
  const targets = [];
  for (const member of members) {
    const patch = { ...member.patch };
    if (member.north !== undefined || member.east !== undefined || member.up !== undefined) {
      const surface = POSITION_SURFACES[message.name];
      Object.assign(patch, offsetPatch(surface, message, member));
    }
    // Row sysid wins over anything in the raw patch — a patch carrying its
    // own `sysid` would silently retarget the row to a different vehicle.
    targets.push({ ...patch, sysid: member.sysid });
  }
  return targets;
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
  // vehicle's own heading. Anything but the measured frames matches no offset
  // arm; a raw patch still works.
  if (surface.local) {
    // Only LOCAL_NED: a body frame re-aims "north" along the vehicle's own
    // heading, and no other local frame has a measured metre scale. Any other
    // frame matches no case and produces no patch — the raw patch surface is
    // how a flow reaches those.
    switch (Number(message.fields.coordinate_frame)) {
      case MAV_FRAME.LOCAL_NED:
        // NED metres: offsets apply directly; z is down-positive, so up subtracts.
        if (member.north !== undefined) patch.x = baseCoord(message, 'x') + member.north;
        if (member.east !== undefined) patch.y = baseCoord(message, 'y') + member.east;
        if (member.up !== undefined) patch.z = baseCoord(message, 'z') - member.up;
        return patch;
      default: break; // This space intentionally left blank (§5)
    }
    return patch;
  }
  // The metre math below is degE7 (§14). A local frame scales x/y ×1e4, so
  // pushing one through here turns a commanded 10 m into ~9 cm — it produces
  // no coordinate patch at all instead.
  if (surface.frameField && !isGlobalFrame(Number(message.fields[surface.frameField]))) {
    return patch;
  }
  if (member.north !== undefined || member.east !== undefined) {
    // An axis the operator left blank contributes no offset, which is a
    // question about presence — the same test `up` makes below. It is spelled
    // out here rather than folded into the call because offsetLatLon needs
    // both axes at once, so the absent one cannot simply skip its write.
    const at = offsetLatLon(
      baseCoord(message, surface.lat) / surface.scale,
      baseCoord(message, surface.lon) / surface.scale,
      member.north === undefined ? 0 : member.north,
      member.east === undefined ? 0 : member.east
    );
    patch[surface.lat] = surface.scale === 1 ? at.lat : Math.round(at.lat * surface.scale);
    patch[surface.lon] = surface.scale === 1 ? at.lon : Math.round(at.lon * surface.scale);
  }
  // Global altitude fields are up-positive: up adds directly.
  if (member.up !== undefined) patch[surface.alt] = baseCoord(message, surface.alt) + member.up;
  return patch;
}

/**
 * A base coordinate read from the built message. Non-finite stays non-finite:
 * the offset arithmetic carries it to lib/connection/wire.js, which is where
 * an integer field's finiteness is judged.
 *
 * @param {{name: string, fields: object}} message
 * @param {string} field
 * @returns {number}
 */
function baseCoord(message, field) {
  return Number(message.fields[field]);
}

/**
 * @param {Array<number|object>|undefined} targets
 * @returns {Map<number, object>} field patches keyed by sysid; empty when the
 *   run carries no targets list
 */
function overridesBySysid(targets) {
  const map = new Map();
  if (targets === undefined) return map;
  targets.forEach((entry) => {
    if (typeof entry === 'object' && entry !== null) {
      const { sysid, ...patch } = entry;
      map.set(Number(sysid), patch);
    } else {
      map.set(Number(entry), {});
    }
  });
  return map;
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
  const patch = { ...options.overrides.get(member.sysid) };
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

function retarget(message, member) {
  const fields = { ...message.fields, target_system: member.sysid };
  // Messages addressing a system but not a component (e.g. SET_MODE) keep
  // their shape — do not invent a field the message does not declare.
  if (message.fields.target_component !== undefined) fields.target_component = member.compid;
  return { ...message, fields };
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
  return { active: isActive(component), state: component.state };
}

function autopilotComponent(peer) {
  return peer.components.find((component) => component.compid === 1);
}

function memberFrom(sysid, component) {
  return {
    sysid,
    compid: component.compid,
    type: component.type,
    firmware: firmwareForAutopilot(component.autopilot) || null,
    armed: component.armed,
    flightMode: component.flightMode,
  };
}

/**
 * Whether a peer-table component counts as live. The one definition of the
 * word: member selection here and leader selection in mavlink-formation both
 * read it, so a vehicle that is live for one is live for the other. A snapshot
 * only ever carries `active` and `stale` — `sweep()` deletes expired
 * components outright.
 *
 * @param {{state: string}} component  a component from PeerTable#snapshot
 * @returns {boolean}
 */
function isActive(component) {
  return component.state !== 'stale';
}

function matchesFilter(member, filter) {
  if (filter.type !== undefined && Number(filter.type) !== Number(member.type)) return false;
  if (filter.firmware && String(filter.firmware) !== String(member.firmware)) return false;
  if (filter.armed !== undefined && booleanFilter(filter.armed) !== member.armed) return false;
  return true;
}

/**
 * The armed filter's saved form: the editor select writes 'true' / 'false',
 * a payload filter may carry the boolean itself (§5 affirmative dispatch —
 * any other value matches no member).
 *
 * @param {*} value
 * @returns {boolean|undefined}
 */
function booleanFilter(value) {
  switch (value) {
    case true:
    case 'true':
      return true;
    case false:
    case 'false':
      return false;
    default: break; // This space intentionally left blank (§5)
  }
  return undefined; // nothing matched: no behavior selected (§5)
}

/**
 * Parse a comma-separated sysid list (or array) into numbers.
 *
 * @param {string|string[]} value
 * @returns {number[]}
 */
function parseSysidList(value) {
  const parts = Array.isArray(value)
    ? value.map((part) => String(part).trim())
    : String(value).split(',').map((part) => part.trim());
  // Coerced, not vetted: the editor bounds every configured sysid (the
  // members table, mavlink-fanout.html), and a `msg.payload.targets` list is
  // trusted runtime input. An entry that names no vehicle simply selects none.
  return parts.map(Number);
}

function broadcastWarnings(members) {
  const warnings = [];
  // An unknown firmware or mode counts as its own value: a fleet the table
  // cannot vouch for as uniform is reported as mixed.
  if (unique(members.map((member) => member.firmware)).length > 1) {
    warnings.push('mixed firmware in broadcast selection; uniform params may not mean the same thing on every stack');
  }
  if (unique(members.map((member) => member.flightMode)).length > 1) {
    warnings.push('mixed flight modes in broadcast selection');
  }
  return warnings;
}

function unique(values) {
  return [...new Set(values)];
}

/**
 * Inter-member pause, cut short when `signal` aborts.
 *
 * `timers/promises` disposes the timer on abort, so a redeploy does not leave
 * the event loop held open for the rest of a pause nobody is waiting for. The
 * AbortError is the expected exit, not a failure.
 *
 * @param {number} ms
 * @param {AbortSignal} signal
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
    selectFanoutMembers,
  parseSysidList,
  isActive,
};
