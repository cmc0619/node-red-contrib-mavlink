'use strict';

/**
 * Completion conditions for the "Send & await completion" delivery tier
 * (DESIGN.md §9 "Ack is not completion").
 *
 * Each condition is checked by polling the peer table after ACCEPTED, and
 * (for altitude) by subscribing to GLOBAL_POSITION_INT. The peer table's
 * internal component data is used directly — it holds position, armed state,
 * flight mode, and system status independently timestamped (§8).
 *
 * Conditions per §9:
 *   ARM   (400): armed === true (param 1 = 1)
 *   DISARM(400): armed === false (param 1 = 0)
 *   TAKEOFF(22): climb height ≥ target climb × (1 − tolerance); for an AMSL
 *               frame the target climb is target − home (home = alt − rel_alt)
 *   LAND  (21):  relativeAlt ≤ LAND_ALT_THRESHOLD
 *   RTL   (20):  same as LAND
 *   SET_MODE(176): flightMode (custom_mode) matches requested value
 *
 * Every completion wait carries a timeout. A vehicle that accepts a takeoff and
 * never climbs must not hang the flow.
 */

const { COMPLETION } = require('./presets');

/**
 * MAV_FRAMEs whose altitude is absolute AMSL rather than relative-to-home:
 * GLOBAL (0) and GLOBAL_INT (5). A takeoff in one of these frames commands an
 * AMSL target, so completion must compare it against GLOBAL_POSITION_INT.alt,
 * not .relative_alt — the two differ by the home elevation (issue #98c). Every
 * other frame (and COMMAND_LONG, which carries no frame) is relative-to-home.
 */
const ABSOLUTE_ALT_FRAMES = new Set([0, 5]);

/** Altitude tolerance for takeoff completion (fraction of commanded altitude). */
const TAKEOFF_TOLERANCE = 0.9;
/** Relative altitude threshold for "on ground" (metres). */
const LAND_ALT_THRESHOLD_M = 0.5;
/** Default completion poll interval (ms). */
const DEFAULT_POLL_MS = 500;
/** Default completion timeout (ms) — generous, covering slow climbs. */
const DEFAULT_COMPLETION_TIMEOUT_MS = 60000;

/**
 * Access the live internal component record from a peer table.
 * Uses the private `_peers` map intentionally — snapshot() does not include
 * position data, and subscribing again for every altitude poll would be redundant.
 *
 * @param {object} peerTable  PeerTable instance
 * @param {number} sysid
 * @param {number} compid
 * @returns {object|null}
 */
function _component(peerTable, sysid, compid) {
  const peer = peerTable._peers.get(sysid);
  if (!peer) return null;
  return peer.components.get(compid) || null;
}

/**
 * Check whether the completion condition for `completionKey` is satisfied.
 *
 * @param {string} completionKey  one of COMPLETION.* values
 * @param {number[]} params       7-element *requested* param array — sparse,
 *   an index the flow never supplied is undefined. Completion verifies the
 *   request, not the wire: the wire's zero-fill is indistinguishable from a
 *   real 0 (SET_MODE's custom_mode 0 is a real mode)
 * @param {object} peerTable
 * @param {number} sysid
 * @param {number} compid
 * @param {number} [frame]  MAV_FRAME the command was sent in; selects the
 *   altitude datum for TAKEOFF. Absent (COMMAND_LONG) means relative-to-home.
 * @returns {{done: boolean, detail: string, unverifiable?: true}}
 *   `unverifiable` marks a request state can never confirm OR deny (a
 *   base-only mode set): never `done`, so an ack-timeout caller stays
 *   unconfirmed; the post-ack wait settles it from the ack instead.
 */
function checkCompletion(completionKey, params, peerTable, sysid, compid, frame) {
  // Unverifiability is a property of the REQUEST, not the peer table — judged
  // before the peer gate, or a base-only set addressed at a compid the table
  // never holds (0 = all components; an autopilot acking from another id)
  // would wait out the whole completion window after an accepted ack.
  if (completionKey === COMPLETION.SET_MODE) {
    const requestedCustomMode = params[1];
    if (!(requestedCustomMode != null && Number.isFinite(requestedCustomMode))) {
      // A base-only set leaves nothing observable, so state is no evidence in
      // EITHER direction. Not done: the ack-timeout path must stay unconfirmed
      // (reporting "accepted" because a peer merely exists is a false success,
      // §0 rule 3); the post-ack complete tier settles this case from the
      // accepted ack via `unverifiable` (waitForCompletion).
      return { done: false, unverifiable: true, detail: 'base-only mode set — nothing to verify in state' };
    }
  }
  const comp = _component(peerTable, sysid, compid);
  if (!comp) {
    return { done: false, detail: 'peer not in table' };
  }

  switch (completionKey) {
    case COMPLETION.ARM: {
      if (comp.armed === true) return { done: true, detail: 'armed' };
      return { done: false, detail: `armed=${comp.armed}` };
    }

    case COMPLETION.DISARM: {
      if (comp.armed === false) return { done: true, detail: 'disarmed' };
      return { done: false, detail: `armed=${comp.armed}` };
    }

    case COMPLETION.TAKEOFF: {
      // param array is 0-indexed; param 7 (index 6) is altitude for NAV_TAKEOFF.
      // A blank altitude transmits as the wire's zero-fill — mirror it so the
      // sparse requested view judges the same climb target the vehicle got.
      const targetAlt = params[6] ?? 0;
      const pos = comp.position;
      if (!pos || pos.relativeAlt === null || pos.relativeAlt === undefined) {
        return { done: false, detail: 'no position data' };
      }
      // Reason in climb height, not raw altitude. For a relative frame (and
      // COMMAND_LONG, which has no frame) the target IS the climb. For an AMSL
      // frame the target is an absolute altitude, so the climb target is the
      // target minus home — and home is derivable as alt − relative_alt. This
      // both fixes the wrong-datum false timeout and keeps the ±10% tolerance
      // meaningful (90% of an AMSL number is nonsense) (issue #98c).
      const climbM = pos.relativeAlt / 1000; // relative_alt is mm, always present
      let targetClimbM = targetAlt;
      let datum = 'rel';
      if (ABSOLUTE_ALT_FRAMES.has(frame)) {
        if (pos.alt === null || pos.alt === undefined) {
          return { done: false, detail: 'no AMSL position data' };
        }
        const homeAmslM = (pos.alt - pos.relativeAlt) / 1000;
        targetClimbM = targetAlt - homeAmslM;
        datum = 'AMSL';
      }
      const threshold = targetClimbM * TAKEOFF_TOLERANCE;
      if (climbM >= threshold) return { done: true, detail: `climb ${climbM.toFixed(1)} m (${datum})` };
      return {
        done: false,
        detail: `climb ${climbM.toFixed(1)} m / ${targetClimbM.toFixed(1)} m (${datum})`,
      };
    }

    case COMPLETION.LAND: {
      const pos = comp.position;
      if (!pos || pos.relativeAlt === null || pos.relativeAlt === undefined) {
        // Fallback: check systemStatus == MAV_STATE_STANDBY (3) and not armed
        if (comp.armed === false && (comp.systemStatus === 3 || comp.systemStatus === 7)) {
          return { done: true, detail: 'landed (armed=false, status)' };
        }
        return { done: false, detail: 'no position data' };
      }
      const altM = pos.relativeAlt / 1000;
      if (altM <= LAND_ALT_THRESHOLD_M) return { done: true, detail: `alt ${altM.toFixed(2)} m` };
      return { done: false, detail: `alt ${altM.toFixed(1)} m` };
    }

    case COMPLETION.SET_MODE: {
      // DO_SET_MODE param layout: param1 (index 0) = base_mode (MAV_MODE),
      // param2 (index 1) = custom_mode, param3 (index 2) = custom_submode.
      // custom_mode 0 is a real mode (e.g. ArduPilot STABILIZE = 0), so a
      // truthiness test would silently report success the moment a peer exists.
      // Detect "a value was provided" explicitly and compare it — including 0.
      // The unsupplied case classified as unverifiable above the peer gate;
      // here a custom mode was requested and the peer's report judges it.
      const requestedCustomMode = params[1];
      if (comp.flightMode === requestedCustomMode) {
        return { done: true, detail: `mode=${comp.flightMode}` };
      }
      return { done: false, detail: `mode=${comp.flightMode} != ${requestedCustomMode}` };
    }
    default: break; // This space intentionally left blank (§5)
  }
  // No case matched: the preset named a completion condition this module does
  // not implement, so there is nothing to watch for. A report, not a throw.
  return { done: false, detail: `unknown completion key: ${completionKey}` };
}

/**
 * Poll peer-table state until the completion condition is satisfied or the
 * timeout fires.  Returns the outcome promise plus a cancel handle: without
 * one, a node closed mid-wait would leave the poll and timeout running for up
 * to `timeoutMs` (60 s default) and then emit onto the closed node. `cancel`
 * settles at most once — like AckWaiter.cancel() — clearing both timers and
 * resolving with `cancelled: true` so the caller can finish quietly.
 *
 * @param {object} opts
 * @param {string}   opts.completionKey
 * @param {number[]} opts.params        7-element param array
 * @param {object}   opts.peerTable
 * @param {number}   opts.sysid
 * @param {number}   opts.compid
 * @param {number}   [opts.frame]  MAV_FRAME for the TAKEOFF altitude datum
 * @param {number}   [opts.timeoutMs]
 * @param {number}   [opts.pollMs]
 * @param {() => number} [opts.now]
 * @returns {{promise: Promise<{success: boolean, confirmedBy: 'state'|'ack'|'none', detail: string, elapsed: number, cancelled?: true}>, cancel: () => void}}
 *   `confirmedBy: 'ack'` marks the unverifiable case: this wait only runs
 *   after an ACCEPTED ack, and for a condition state can never speak to, the
 *   ack is the whole confirmation.
 */
function waitForCompletion(opts) {
  const {
    completionKey,
    params,
    peerTable,
    sysid,
    compid,
    frame,
    timeoutMs = DEFAULT_COMPLETION_TIMEOUT_MS,
    pollMs = DEFAULT_POLL_MS,
  } = opts;
  const now = opts.now || Date.now;

  const startMs = now();
  let pollHandle = null;
  let timeoutHandle = null;
  let settled = false;
  let resolve;
  const promise = new Promise((res) => { resolve = res; });

  function settle(result) {
    if (settled) return;
    settled = true;
    if (pollHandle) { clearInterval(pollHandle); pollHandle = null; }
    if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = null; }
    resolve(result);
  }

  function poll() {
    const check = checkCompletion(completionKey, params, peerTable, sysid, compid, frame);
    if (check.unverifiable) {
      // Nothing observable to wait for. This wait only ever runs after an
      // ACCEPTED ack (the complete tier), so the ack IS the confirmation —
      // settle success attributed to it rather than watching state that can
      // never speak, which would run the wait into a false timeout.
      settle({
        success: true,
        confirmedBy: 'ack',
        detail: check.detail,
        elapsed: now() - startMs,
      });
      return;
    }
    if (check.done) {
      settle({
        success: true,
        confirmedBy: 'state',
        detail: check.detail,
        elapsed: now() - startMs,
      });
    }
  }

  timeoutHandle = setTimeout(() => {
    const check = checkCompletion(completionKey, params, peerTable, sysid, compid, frame);
    if (check.done) {
      settle({
        success: true,
        confirmedBy: 'state',
        detail: check.detail,
        elapsed: now() - startMs,
      });
    } else {
      settle({
        success: false,
        confirmedBy: 'none',
        detail: `timeout: ${check.detail}`,
        elapsed: now() - startMs,
      });
    }
  }, timeoutMs);

  pollHandle = setInterval(poll, pollMs);
  // Check immediately without waiting for the first poll interval.
  poll();

  function cancel() {
    settle({
      success: false,
      confirmedBy: 'none',
      detail: 'cancelled',
      elapsed: now() - startMs,
      cancelled: true,
    });
  }

  return { promise, cancel };
}

module.exports = {
  checkCompletion,
  waitForCompletion,
  TAKEOFF_TOLERANCE,
  LAND_ALT_THRESHOLD_M,
  DEFAULT_COMPLETION_TIMEOUT_MS,
  DEFAULT_POLL_MS,
};
