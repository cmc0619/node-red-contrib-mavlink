'use strict';

const delivery = require('../lib/delivery');
const { executeFanout, parseSysidList } = require('../lib/fanout');
const { applyConnectionStatus, isBlank, dialectFromConnection } = require('../lib/addressing');
const { formationTargets } = require('../lib/formation');
const {
  getPreset,
  buildParamArray,
  buildCommandInt,
  intCoordKinds,
  DEFAULT_FRAME,
  scaleLatLon,
} = require('../lib/command');

/**
 * mavlink-formation — position a group of vehicles into a geometric formation.
 *
 * The node is deliberately thin (three steps, all owned elsewhere): resolve the
 * anchor from config/payload or the leader's peer-table telemetry, compute one
 * absolute target per vehicle with lib/formation, and hand Fan-out one built
 * Go To / Reposition message plus per-member lat/lon/alt patches in `targets`
 * (wire units — Fan-out is a raw surface, §10). All geometry lives in
 * lib/formation; all replication lives in lib/fanout.
 *
 * Altitude semantics: targets ride MAV_FRAME_GLOBAL_RELATIVE_ALT (metres above
 * home), the frame a guided reposition assumes. A leader anchor therefore uses
 * the leader's `relativeAlt`, and an explicit anchor altitude is metres above
 * home.
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
    const connectionNode = RED.nodes.getNode(config.connection);
    applyConnectionStatus(node, true, connectionNode);

    // Abort-on-close discipline shared with mavlink-fanout: a redeploy aborts
    // every run in flight and waits for each to unwind. Rationale lives with
    // delivery.inFlightTracker.
    const inFlight = delivery.inFlightTracker();

    node.on('input', async (msg, send, done) => {
      try {
        if (delivery.shouldSuppress(msg)) {
          done();
          return;
        }
        const payload = msg.payload ?? {};
        const sysids = parseSysidList(
          payload.sysids !== undefined ? payload.sysids : config.sysids
        );
        const { anchor, headingDeg } = resolveAnchor(config, payload, connectionNode.peerTable);
        const pitchDeg = resolvePitch(config, payload);
        const targets = formationTargets({
          shape: config.shape,
          spacing: config.spacing,
          anchor,
          headingDeg,
          pitchDeg,
          sysids,
        });

        // Build the shared Reposition message once with zeroed coordinates; the
        // per-member lat/lon/alt are patched in as degE7 x/y below, since
        // Fan-out patches are the raw wire surface (§10). Formation always
        // builds COMMAND_INT: DO_REPOSITION is a positional command and the
        // references carry it as COMMAND_INT only — COMMAND_LONG is not a valid
        // carrier for it, so there is no carrier choice to make.
        const preset = getPreset(REPOSITION_PRESET);
        const params = buildParamArray(preset, { ...SHARED_PARAMS, 5: 0, 6: 0, 7: 0 });
        const bundle = dialectFromConnection(RED, connectionNode);
        const message = buildCommandInt(Number(preset.commandId), 0, 0, params, {
          // Guided reposition is relative-alt; pass the frame explicitly —
          // the driver no longer invents it when omitted (§0).
          frame: DEFAULT_FRAME,
          coordKinds: (bundle && intCoordKinds(bundle, Number(preset.commandId))) || undefined,
        });
        const memberTargets = targets.map((target) => ({
          sysid: target.sysid,
          x: scaleLatLon(target.lat),
          y: scaleLatLon(target.lon),
          z: target.alt,
        }));

        const aggregate = await inFlight.track((signal) => executeFanout({
          signal,
          // Aggregates from this node say mavlink-formation, not the library's
          // replicator — failure records already do (§9 one record owner).
          nodeType: node.type,
          connection: connectionNode,
          message,
          targets: memberTargets,
          mode: 'sequential',
          delivery: config.delivery,
          // The editor validators reject blank at deploy, so a present value
          // is guaranteed numeric — trust it (Number only, no second default).
          // Absence stays absence: a config with no key passes undefined so
          // lib/fanout's own absence default fires, rather than NaN silencing
          // every pacing comparison (Gitar, #287).
          intervalMs: config.intervalMs === undefined ? undefined : Number(config.intervalMs),
          timeoutMs: config.timeoutMs === undefined ? undefined : Number(config.timeoutMs),
        }));

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
        done();
      } catch (err) {
        delivery.failInput(node, send, err, done);
      }
    });

    node.on('close', (done) => inFlight.close(done));
  }

  RED.nodes.registerType('mavlink-formation', MavlinkFormationNode);
};

/**
 * Resolve the formation anchor and heading.
 *
 * Anchor precedence: `msg.payload.anchor` ({lat, lon, alt}), else the
 * configured fixed anchor, else the configured leader's live position from the
 * peer table. A leader with no position, or with no relative altitude, is a
 * live telemetry miss (rule 3) — never a default: 0,0 is null island and
 * altitude 0 commands a descent to home level.
 *
 * Heading precedence: `msg.payload.headingDeg`, else config, else (leader
 * anchor only) the leader's reported heading. An unknown heading stays
 * unknown — 0 would face the pattern north without anyone asking. A present
 * payload heading is trusted input like every other: Number() coercion.
 *
 * Pitch follows the same payload-then-config rule via {@link resolvePitch}.
 * Pitch tumbles the pattern around body +Y; it is not taken from telemetry.
 *
 * @param {object} config node config
 * @param {object} payload msg.payload
 * @param {{snapshot: Function}} peerTable connection peer table
 * @returns {{anchor: {lat: *, lon: *, alt: *}, headingDeg: *}}
 */
function resolveAnchor(config, payload, peerTable) {
  // Payload heading wins over config; blank means "not set" (null). The peer
  // table projects a leader's telemetry heading to a finite number or null.
  let heading = !isBlank(payload.headingDeg)
    ? Number(payload.headingDeg)
    : isBlank(config.headingDeg) ? NaN : Number(config.headingDeg);

  // A payload anchor overrides the configured mode outright.
  if (payload.anchor) {
    return { anchor: payload.anchor, headingDeg: heading };
  }

  switch (config.anchorMode) {
    case 'fixed':
      return {
        anchor: { lat: config.lat, lon: config.lon, alt: config.alt },
        headingDeg: heading,
      };
    case 'leader': {
      const sysid = Number(config.leader);
      const peer = peerTable.snapshot().find((p) => p.sysid === sysid);
      const autopilot = peer && peer.components.find((c) => c.compid === 1);
      const position = autopilot && autopilot.position;
      if (!position) {
        // eslint-disable-next-line no-restricted-syntax -- §0 rule 3: no GLOBAL_POSITION_INT seen yet is a live telemetry state, not an input
        throw new Error(`mavlink-formation: leader ${config.leader} has no reported position `
          + '(no GLOBAL_POSITION_INT seen)');
      }
      // Targets ride MAV_FRAME_GLOBAL_RELATIVE_ALT, where a defaulted 0 commands
      // a descent to home level.
      if (!Number.isFinite(position.relativeAlt)) {
        // eslint-disable-next-line no-restricted-syntax -- §0 rule 3: no relative altitude reported yet is a live telemetry state, not an input
        throw new Error(`mavlink-formation: leader ${config.leader} reports no relative altitude`);
      }
      if (!Number.isFinite(heading) && position.heading != null) heading = position.heading;
      return {
        anchor: { lat: position.lat, lon: position.lon, alt: position.relativeAlt },
        headingDeg: heading,
      };
    }
    default: break; // This space intentionally left blank (§5)
  }
  return undefined; // nothing matched: no behavior selected (§5)
}

/**
 * Pitch for this formation run. Payload override and config value are both
 * trusted input: Number() coercion, never a refusal. Absent → 0.
 *
 * @param {object} config
 * @param {object} payload
 * @returns {number}
 */
function resolvePitch(config, payload) {
  if (!isBlank(payload.pitchDeg)) return Number(payload.pitchDeg);
  // Editor default is 0 — trust config.pitchDeg (Number only, no second default).
  return Number(config.pitchDeg);
}

