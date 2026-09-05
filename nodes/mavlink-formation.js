'use strict';

const delivery = require('../lib/delivery');
const { executeFanout, parseSysidList, isActive } = require('../lib/fanout');
const { isBlank } = require('../lib/addressing/resolve');
const { formationTargets } = require('../lib/formation');
const { REPOSITION_FLAG_CHANGE_MODE } = require('../lib/move/reposition');
const { getPreset, buildParamArray } = require('../lib/command/presets');
const { buildCommandInt, DEFAULT_FRAME, scaleLatLon } = require('../lib/command/carrier');

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

module.exports = function registerMavlinkFormation(RED) {
  function MavlinkFormationNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const connectionNode = RED.nodes.getNode(config.connection);

    // Abort-on-close discipline shared with mavlink-fanout: a redeploy aborts
    // every run in flight and waits for each to unwind. Rationale lives with
    // delivery.inFlightTracker.
    const inFlight = delivery.inFlightTracker();

    // Input-invariant Reposition scaffold, built once from the Go To /
    // Reposition preset (MAV_CMD_DO_REPOSITION; params 1 speed, 2 flags,
    // 3 radius, 4 yaw, 5 lat, 6 lon, 7 alt). The preset's blank sentinels
    // carry speed -1 (vehicle default) and yaw NaN (hold heading — the
    // formation heading rotates the pattern, not the noses); the coordinates
    // are zero here and patched in per member as degE7 x/y, since Fan-out
    // patches are the raw wire surface (§10) and executeFanout never mutates
    // its base message. DO_REPOSITION is positional and the references carry
    // it as COMMAND_INT only, so there is no carrier choice to make; guided
    // reposition is relative-alt, so the frame is passed explicitly. Param 2
    // carries MAV_DO_REPOSITION_FLAGS_CHANGE_MODE when the editor's Change
    // mode box is ticked — the gate on both stacks (§14.108): without it the
    // reposition is DENIED unless the vehicle is already in GUIDED / Hold.
    const preset = getPreset('reposition');
    const message = buildCommandInt(
      Number(preset.commandId), 0, 0,
      buildParamArray(preset, { 2: config.changeMode ? REPOSITION_FLAG_CHANGE_MODE : 0 }),
      { frame: DEFAULT_FRAME }
    );

    node.on('input', async (msg, send, done) => {
      try {
        if (delivery.shouldSuppress(msg)) {
          done();
          return;
        }
        const payload = msg.payload;
        const sysids = parseSysidList(
          payload.sysids !== undefined ? payload.sysids : config.sysids
        );
        const { anchor, headingDeg, leaderSysid } = resolveAnchor(
          config, payload, connectionNode.peerTable
        );
        const pitchDeg = resolvePitch(config, payload);
        const targets = formationTargets({
          shape: config.shape,
          spacing: config.spacing,
          anchor,
          headingDeg,
          pitchDeg,
          sysids,
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
          // One vehicle at a time, as the help promises. The retry budget is
          // the editor's (RED.mavlink.ackDefaults), read as saved.
          concurrency: 1,
          maxRetries: Number(config.maxRetries),
          delivery: config.delivery,
          // The editor owns both defaults and rejects blank at deploy, so the
          // saved value is numeric — trust it (Number only, no second default).
          intervalMs: Number(config.intervalMs),
          timeoutMs: Number(config.timeoutMs),
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
        // Which vehicle actually anchored the pattern. Present on every
        // leader-anchored run, not only a promoted one, so a flow reads one
        // field rather than inferring a substitution from its absence. Copied
        // rather than threaded through lib/fanout: the replicator has no
        // notion of a leader and should not grow one for a single caller.
        const record = leaderSysid === undefined
          ? aggregate
          : { ...aggregate, leader: leaderSysid };
        send(record.continue
          ? [{ payload: record }, record]
          : [null, record]);
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
 * configured fixed anchor, else a leader's live position from the peer table —
 * which leader being {@link resolveLeader}'s answer. A leader with no reported
 * position fails the input loudly: the lookup craters on first property access
 * and the node's error path reports the message as failed.
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
 * @returns {{anchor: {lat: *, lon: *, alt: *}, headingDeg: *, leaderSysid: (number|undefined)}}
 *   `leaderSysid` only on a leader anchor — the vehicle the pattern hung off.
 */
function resolveAnchor(config, payload, peerTable) {
  // Payload heading wins over config; both blank means "not set" (NaN), and a
  // present value rides as Number() whatever it holds. The peer table
  // projects a leader's telemetry heading to a finite number or null.
  const headingGiven = !isBlank(payload.headingDeg) || !isBlank(config.headingDeg);
  let heading = !isBlank(payload.headingDeg)
    ? Number(payload.headingDeg)
    : isBlank(config.headingDeg) ? NaN : Number(config.headingDeg);

  // A payload anchor overrides the configured mode outright.
  if (payload.anchor !== undefined) {
    return { anchor: payload.anchor, headingDeg: heading };
  }

  switch (config.anchorMode) {
    case 'fixed':
      return {
        anchor: { lat: config.lat, lon: config.lon, alt: config.alt },
        headingDeg: heading,
      };
    case 'leader': {
      const leader = resolveLeader(
        peerTable.snapshot(), Number(config.leader), config.promoteLeader
      );
      const position = leader.component.position;
      if (!headingGiven && position.heading != null) heading = position.heading;
      return {
        anchor: { lat: position.lat, lon: position.lon, alt: position.relativeAlt },
        headingDeg: heading,
        leaderSysid: leader.sysid,
      };
    }
    default: break; // This space intentionally left blank (§5)
  }
  return undefined; // nothing matched: no behavior selected (§5)
}

/**
 * The autopilot component of one peer, as a leader candidate.
 *
 * @param {object} peer  one entry of a PeerTable snapshot
 * @returns {{sysid: number, component: object|undefined}}
 */
function candidate(peer) {
  return { sysid: peer.sysid, component: peer.components.find((c) => c.compid === 1) };
}

/**
 * Whether a candidate can anchor a formation: live by the peer table's own
 * reckoning, and carrying a position to anchor on. Liveness is
 * {@link isActive}, the same predicate Fan-out selects members with, so one
 * vehicle cannot be live for one and dead for the other.
 *
 * @param {{component: object|undefined}} entry
 * @returns {boolean}
 */
function canAnchor(entry) {
  return Boolean(entry.component) && isActive(entry.component) && Boolean(entry.component.position);
}

/**
 * Pick the vehicle whose telemetry anchors the pattern.
 *
 * Without promotion this is the configured leader, whatever state it is in —
 * the historical behaviour, kept because the config names one vehicle and
 * substituting another is a decision the flow has to opt into (§4).
 *
 * With promotion on, a configured leader that has gone stale or has never
 * reported a position hands the pattern to the next vehicle that can carry it:
 * the lowest live sysid above the configured one, wrapping to the lowest live
 * sysid overall. Deterministic, so the same fleet state always promotes the
 * same vehicle, and stateless — nothing here remembers a promotion, so the
 * configured leader takes the pattern back on the first input after it
 * reports again.
 *
 * Promotion is best effort: with nobody live to promote, the configured leader
 * rides back out unchanged and the run behaves exactly as an unpromoted one —
 * anchoring on its last fix if it has one, cratering if it never reported. The
 * alternative is refusing a formation the flow could still fly, which is a
 * guard and not this node's job.
 *
 * @param {object[]} snapshot  PeerTable#snapshot
 * @param {number} sysid       the configured leader
 * @param {boolean} promote    config.promoteLeader
 * @returns {{sysid: number, component: object|undefined}}
 */
function resolveLeader(snapshot, sysid, promote) {
  const peer = snapshot.find((p) => p.sysid === sysid);
  const configured = peer ? candidate(peer) : { sysid, component: undefined };
  if (!promote || canAnchor(configured)) return configured;

  const live = snapshot.map(candidate).filter(canAnchor).sort((a, b) => a.sysid - b.sysid);
  const above = live.find((entry) => entry.sysid > sysid);
  if (above) return above;
  return live.length ? live[0] : configured;
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
