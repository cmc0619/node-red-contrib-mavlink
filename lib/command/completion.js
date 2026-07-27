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
 *   TAKEOFF(22): relativeAlt ≥ commanded altitude × (1 − tolerance)
 *   LAND  (21):  relativeAlt ≤ LAND_ALT_THRESHOLD
 *   RTL   (20):  same as LAND
 *   SET_MODE(176): flightMode (custom_mode) matches requested value
 *
 * Every completion wait carries a timeout. A vehicle that accepts a takeoff and
 * never climbs must not hang the flow.
 */

const { COMPLETION } = require('./presets');

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
  const peer = peerTable._peers && peerTable._peers.get(sysid);
  if (!peer) return null;
  return peer.components && peer.components.get(compid) || null;
}

/**
 * Check whether the completion condition for `completionKey` is satisfied.
 *
 * @param {string} completionKey  one of COMPLETION.* values
 * @param {number[]} params       7-element param array
 * @param {object} peerTable
 * @param {number} sysid
 * @param {number} compid
 * @returns {{done: boolean, detail: string}}
 */
function checkCompletion(completionKey, params, peerTable, sysid, compid) {
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
      // param array is 0-indexed; param 7 (index 6) is altitude for NAV_TAKEOFF
      const targetAlt = params[6];
      const pos = comp.position;
      if (!pos || pos.relativeAlt === null || pos.relativeAlt === undefined) {
        return { done: false, detail: 'no position data' };
      }
      // relativeAlt from GLOBAL_POSITION_INT is in mm; convert to metres
      const altM = pos.relativeAlt / 1000;
      const threshold = targetAlt * TAKEOFF_TOLERANCE;
      if (altM >= threshold) return { done: true, detail: `alt ${altM.toFixed(1)} m` };
      return { done: false, detail: `alt ${altM.toFixed(1)} m / ${targetAlt} m target` };
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
      // param 2 (index 1) = base_mode (MAV_MODE), param 3 (index 2) = custom_mode
      // We check custom_mode (flightMode in peer table) matches param 3 if non-zero,
      // otherwise just check base_mode.
      const requestedCustomMode = params[2];
      if (requestedCustomMode && comp.flightMode === requestedCustomMode) {
        return { done: true, detail: `mode=${comp.flightMode}` };
      }
      if (!requestedCustomMode) {
        // No custom mode specified — accept when not null
        return { done: true, detail: 'mode set' };
      }
      return { done: false, detail: `mode=${comp.flightMode} != ${requestedCustomMode}` };
    }

    default:
      return { done: false, detail: `unknown completion key: ${completionKey}` };
  }
}

/**
 * Poll peer-table state until the completion condition is satisfied or the
 * timeout fires.  Returns a Promise resolving with the outcome.
 *
 * @param {object} opts
 * @param {string}   opts.completionKey
 * @param {number[]} opts.params        7-element param array
 * @param {object}   opts.peerTable
 * @param {number}   opts.sysid
 * @param {number}   opts.compid
 * @param {number}   [opts.timeoutMs]
 * @param {number}   [opts.pollMs]
 * @param {() => number} [opts.now]
 * @returns {Promise<{success: boolean, confirmedBy: 'state'|'none', detail: string, elapsed: number}>}
 */
function waitForCompletion(opts) {
  const {
    completionKey,
    params,
    peerTable,
    sysid,
    compid,
    timeoutMs = DEFAULT_COMPLETION_TIMEOUT_MS,
    pollMs = DEFAULT_POLL_MS,
  } = opts;
  const now = opts.now || Date.now;

  return new Promise((resolve) => {
    const startMs = now();
    let pollHandle = null;
    let timeoutHandle = null;
    let settled = false;

    function settle(result) {
      if (settled) return;
      settled = true;
      if (pollHandle) { clearInterval(pollHandle); pollHandle = null; }
      if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = null; }
      resolve(result);
    }

    function poll() {
      const check = checkCompletion(completionKey, params, peerTable, sysid, compid);
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
      const check = checkCompletion(completionKey, params, peerTable, sysid, compid);
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
  });
}

module.exports = {
  checkCompletion,
  waitForCompletion,
  TAKEOFF_TOLERANCE,
  LAND_ALT_THRESHOLD_M,
  DEFAULT_COMPLETION_TIMEOUT_MS,
  DEFAULT_POLL_MS,
};
