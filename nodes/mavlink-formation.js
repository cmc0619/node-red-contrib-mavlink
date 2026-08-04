'use strict';

const delivery = require('../lib/delivery');
const { executeFanout, parseSysidList } = require('../lib/fanout');
const { formationTargets } = require('../lib/formation');
const { DEFAULT_TIMEOUT_MS } = require('../lib/command');
const { dialectFromConnection } = require('../lib/addressing');

/**
 * mavlink-formation — position a group of vehicles into a geometric formation.
 *
 * The node is deliberately thin (three steps, all owned elsewhere): resolve the
 * anchor from config/payload or the leader's peer-table telemetry, compute one
 * absolute target per vehicle with lib/formation, and dispatch one sequential
 * fan-out of the Go To / Reposition preset with per-member lat/lon/alt in
 * `memberParams` (params 5/6/7). All geometry lives in lib/formation; all
 * sending lives in lib/fanout.
 *
 * Altitude semantics: targets ride the carrier's default frame,
 * MAV_FRAME_GLOBAL_RELATIVE_ALT (metres above home) — the same frame PX4
 * assumes for a COMMAND_LONG reposition. A leader anchor therefore uses the
 * leader's `relativeAlt`, and an explicit anchor altitude is metres above home.
 */

/**
 * Go To / Reposition preset (lib/command/presets.js) — MAV_CMD_DO_REPOSITION
 * (192). Its param map: 1 speed, 2 flags, 3 radius, 4 yaw, 5 lat, 6 lon, 7 alt.
 */
const REPOSITION_PRESET = 'reposition';

/**
 * Shared reposition params for every member. Only the two whose
 * build-time default of 0 is actively wrong are set:
 *   param 1 (speed) = -1  — "use default speed"; 0 would command zero ground speed.
 *   param 4 (yaw)   = NaN — "hold current heading" (dialect-declared sentinel,
 *     §9); 0 would yaw every vehicle to north, the same trap as Land's yaw
 *     (issue #98b). The formation heading rotates the *pattern*, not the noses.
 * Params 2 (flags) and 3 (radius) keep their 0 defaults.
 */
const SHARED_PARAMS = { 1: -1, 4: NaN };

module.exports = function registerMavlinkFormation(RED) {
  function MavlinkFormationNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const connectionNode = config.connection ? RED.nodes.getNode(config.connection) : null;

    if (!connectionNode || !connectionNode.peerTable) {
      delivery.applyActionStatus(node, 'invalid', 'invalid config');
    }

    // Same close discipline as mavlink-fanout: every run in flight, so a
    // redeploy aborts all of them and waits for each to unwind rather than
    // leaving a member loop sending live reposition commands from a dead node.
    const inFlight = new Set();

    node.on('input', async (msg, send, done) => {
      if (delivery.shouldSuppress(msg)) {
        done();
        return;
      }

      try {
        if (!connectionNode || !connectionNode.peerTable) {
          throw new Error('mavlink-formation requires a Connection with a peer table');
        }
        const payload = msg.payload ?? {};
        const sysids = parseSysidList(
          payload.sysids !== undefined ? payload.sysids : config.sysids
        );
        const { anchor, headingDeg } = resolveAnchor(config, payload, connectionNode.peerTable);
        const targets = formationTargets({
          shape: config.shape,
          spacing: config.spacing,
          anchor,
          headingDeg,
          sysids,
        });

        const memberParams = {};
        for (const target of targets) {
          memberParams[target.sysid] = { 5: target.lat, 6: target.lon, 7: target.alt };
        }

        const controller = new AbortController();
        const run = executeFanout({
          signal: controller.signal,
          connection: connectionNode,
          vehicleBundle: dialectFromConnection(RED, connectionNode),
          action: {
            type: 'command',
            preset: REPOSITION_PRESET,
            params: SHARED_PARAMS,
            memberParams,
            carrier: config.carrier,
          },
          selection: { mode: 'list', sysids },
          mode: 'sequential',
          delivery: config.delivery,
          intervalMs: config.intervalMs === undefined || config.intervalMs === '' ? 100 : config.intervalMs,
          timeoutMs: config.timeoutMs === undefined || config.timeoutMs === '' ? DEFAULT_TIMEOUT_MS : config.timeoutMs,
        });
        const entry = { run, controller };
        inFlight.add(entry);
        let aggregate;
        try {
          aggregate = await run;
        } finally {
          inFlight.delete(entry);
        }

        // A redeploy cancelled us: finish quietly rather than emitting or
        // raising on a closed node (same rule as mavlink-fanout).
        if (aggregate.result === 'cancelled') {
          done();
          return;
        }

        if (aggregate.success) {
          delivery.applyActionStatus(node, 'ok', `${aggregate.count} positioned`);
        } else {
          delivery.applyActionStatus(node, 'error', aggregate.result);
        }
        send(aggregate.continue
          ? [{ payload: aggregate }, aggregate]
          : [null, aggregate]);
        if (!aggregate.success) {
          done(new Error(`mavlink-formation: ${aggregate.result}${aggregate.detail ? ` — ${aggregate.detail}` : ''}`));
        } else {
          done();
        }
      } catch (err) {
        const record = delivery.makeStatusRecord({
          node: 'mavlink-formation',
          result: 'failed',
          success: false,
          continue: false,
          detail: err.message,
        });
        delivery.applyActionStatus(node, 'error', err.message);
        send([null, record]);
        done(err);
      }
    });

    node.on('close', (done) => {
      if (inFlight.size === 0) {
        done();
        return;
      }
      const running = [...inFlight];
      for (const entry of running) entry.controller.abort();
      Promise.allSettled(running.map((entry) => entry.run)).then(() => done());
    });
  }

  RED.nodes.registerType('mavlink-formation', MavlinkFormationNode);
};

/**
 * Resolve the formation anchor and heading.
 *
 * Anchor precedence: `msg.payload.anchor` ({lat, lon, alt}), else the
 * configured fixed anchor, else the configured leader's live position from the
 * peer table. A leader with no position, or with no relative altitude, is a
 * refusal — never a default: 0,0 is null island and altitude 0 commands a
 * descent to home level.
 *
 * Heading precedence: `msg.payload.headingDeg`, else config, else (leader
 * anchor only) the leader's reported heading. An unknown heading falls back to
 * 0 (pattern faces north) rather than refusing: unlike a defaulted coordinate
 * or altitude, any heading yields a geometrically valid, fully separated
 * formation — the value orients the pattern, it cannot collapse it (§2:
 * refusals are for inputs whose default is silently dangerous).
 *
 * @param {object} config node config
 * @param {object} payload msg.payload
 * @param {{snapshot: Function}} peerTable connection peer table
 * @returns {{anchor: {lat: *, lon: *, alt: *}, headingDeg: number}}
 */
function resolveAnchor(config, payload, peerTable) {
  let heading = firstNonBlank(payload.headingDeg, config.headingDeg);

  const explicit = payload.anchor
    || (config.anchorMode === 'fixed'
      ? { lat: config.lat, lon: config.lon, alt: config.alt }
      : null);
  if (explicit) {
    return { anchor: explicit, headingDeg: heading === null ? 0 : Number(heading) };
  }

  const sysid = Number(config.leader);
  const peer = peerTable.snapshot().find((p) => p.sysid === sysid);
  const autopilot = peer && (peer.components || []).find((c) => c.compid === 1);
  const position = autopilot && autopilot.position;
  if (!position) {
    throw new Error(`mavlink-formation: leader ${config.leader} has no reported position `
      + '(no GLOBAL_POSITION_INT seen) — refusing to anchor the formation on unknown coordinates');
  }
  // Telemetry is boundary input (wire-derived): a missing relative altitude
  // must refuse, not default — the targets ride MAV_FRAME_GLOBAL_RELATIVE_ALT,
  // where a defaulted 0 commands a descent to home level.
  if (!Number.isFinite(position.relativeAlt)) {
    throw new Error(`mavlink-formation: leader ${config.leader} reports no relative altitude — `
      + 'refusing to default the formation altitude');
  }
  if (heading === null) heading = position.heading; // may still be null (wire sentinel)
  return {
    anchor: { lat: position.lat, lon: position.lon, alt: position.relativeAlt },
    headingDeg: heading === null || heading === undefined ? 0 : Number(heading),
  };
}

/**
 * First value that is not undefined, null, or blank string. `0` passes —
 * heading 0 (north) is a real heading and must not be swallowed.
 *
 * @param {...*} values
 * @returns {*} the first present value, or null
 */
function firstNonBlank(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}
