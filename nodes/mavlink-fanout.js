'use strict';

const delivery = require('../lib/delivery');
const { valueFrom, isBlank } = require('../lib/addressing/resolve');
const { executeFanout, parseSysidList, reportAggregate } = require('../lib/fanout');

module.exports = function registerMavlinkFanout(RED) {
  function MavlinkFanoutNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const connectionNode = RED.nodes.getNode(config.connection);

    // The editor requires an explicit sysid list on Build, so config
    // follows the standard rule: no Connection needed on Build, required on
    // the wire tiers. A payload override asking for build+all or build+filter
    // with no Connection selects no peer table and craters in the executor
    // (§0).

    // Abort-on-close discipline: a redeploy aborts every run in flight and
    // waits for each to unwind. Rationale lives with delivery.inFlightTracker.
    const inFlight = delivery.inFlightTracker();

    node.on('input', async (msg, send, done) => {
      try {
        if (delivery.shouldSuppress(msg)) {
          done();
          return;
        }
        const { message, opts } = unwrapPayload(msg.payload);
        const selection = opts.selection === undefined ? selectionFrom(config) : opts.selection;
        const selectionMode = selection.mode;
        const effectiveDelivery = valueFrom(opts, config, 'delivery');
        const listSelected = selectionMode === 'list' || opts.targets !== undefined;

        let effectiveConnection = connectionNode;
        switch (effectiveDelivery) {
          case 'build':
            // On Build an explicit sysid list is the directory (§6 Fan-out
            // exception): it replicates against a synthetic peer table, never
            // a live one — a Connection kept hidden from an earlier tier would
            // drop every listed member it has not heard.
            if (listSelected) {
              effectiveConnection = buildListStub(
                opts.targets !== undefined
                  ? opts.targets.map((target) => target.sysid === undefined ? target : target.sysid)
                  : selection.sysids
              );
            }
            break;
          default: break; // This space intentionally left blank (§5)
        }

        const aggregate = await inFlight.track((signal) => executeFanout({
          signal,
          // The aggregate record's `node` field names the emitting node —
          // formation runs the same executor and stamps its own type.
          nodeType: node.type,
          connection: effectiveConnection,
          message,
          targets: opts.targets,
          members: configMembersFor(config, opts),
          selection,
          // Affirmative dispatch (§5): lib/fanout maps only broadcast and
          // sequential — an unknown or blank mode selects no case, so no run
          // starts and the aggregate comes back undefined (handled below).
          mode: valueFrom(opts, config, 'executionMode'),
          delivery: effectiveDelivery,
          intervalMs: numberOption(opts, config, 'intervalMs'),
          timeoutMs: numberOption(opts, config, 'timeoutMs'),
          maxRetries: numberOption(opts, config, 'maxRetries'),
          concurrency: numberOption(opts, config, 'concurrency'),
          stopOnError: valueFrom(opts, config, 'stopOnError'),
          identityId: opts.identityId === undefined ? config.identity : opts.identityId,
        }));

        // Two ways there is nothing to report. A redeploy cancelled us: the
        // node is going away, so finish quietly rather than emitting or raising
        // on a closed node, which would trip a Catch node wired for "fan-out
        // failed → failsafe" on a mere deploy. Or no execution mode matched, so
        // no run started (§5) and executeFanout selected no behavior. Either
        // way the input still completes — a message left hanging is worse than
        // one that did nothing (same rule as mavlink-mission's tier dispatch).
        if (aggregate === undefined || aggregate.result === 'cancelled') {
          done();
          return;
        }

        reportAggregate(node, send, done, aggregate, effectiveDelivery);
      } catch (err) {
        delivery.failInput(node, send, err, done);
      }
    });

    node.on('close', (done) => inFlight.close(done));
  }

  RED.nodes.registerType('mavlink-fanout', MavlinkFanoutNode);
};

/**
 * Fan-out accepts two payload shapes (§10): a built message directly —
 * `{name, fields}`, chained straight off a Build-tier action node — or the
 * wrapper `{message, targets, ...options}` when a Function node adds
 * per-target patches or runtime option overrides. Everything rides
 * `msg.payload` (§6: runtime overrides live on the payload).
 *
 * @param {*} payload
 * @returns {{message: object, opts: object}}
 */
function unwrapPayload(payload) {
  if (payload.message !== undefined) {
    const { message, ...opts } = payload;
    return { message, opts };
  }
  return { message: payload, opts: {} };
}

function selectionFrom(config) {
  const filter = {};
  for (const [key, value] of [['type', config.vehicleType], ['firmware', config.firmwareFilter], ['armed', config.armedFilter]]) {
    if (!isBlank(value)) filter[key] = value;
  }
  // No `|| 'all'`: the editor always saves a member, and the runtime maps
  // nothing — a blank saved mode crashes at dispatch, like any non-member.
  const mode = config.selectionMode;
  return {
    mode,
    // List selection reads its sysids from the members table rows.
    sysids: mode === 'list' ? config.members.map((member) => member.sysid) : undefined,
    filter,
  };
}

/**
 * The config member rows for this run, or undefined when they do not apply:
 * a payload `targets` array replaces them entirely (§6 — the override of last
 * resort), a payload `selection` override picks its own group, and rows
 * without any offset or patch are plain list selection, already covered by
 * {@link selectionFrom}.
 *
 * @param {object} config
 * @param {object} opts unwrapped payload options
 * @returns {Array<object>|undefined}
 */
function configMembersFor(config, opts) {
  if (opts.targets !== undefined || opts.selection !== undefined) return undefined;
  if (config.selectionMode !== 'list') return undefined;
  const patched = config.members.some((member) =>
    member.north !== undefined || member.east !== undefined
    || member.up !== undefined || member.patch !== undefined);
  return patched ? config.members : undefined;
}

/**
 * A numeric run option: `msg.payload` overrides by presence, otherwise the
 * editor's saved value, which the editor defaults and red-rings.
 */
function numberOption(opts, config, key) {
  return opts[key] === undefined ? Number(config[key]) : opts[key];
}

/**
 * Synthetic connection used when delivery=build with an explicit sysid list
 * (config list selection or a runtime targets array), whether or not a
 * Connection is saved. Peer table returns one active autopilot entry per listed sysid
 * so executeFanout can retarget messages without a live peer table (§6 Fan-out
 * exception).
 *
 * @param {string|Array} sysids  Sysids from the members rows, a payload
 *   selection, or a targets array.
 * @returns {object}
 */
function buildListStub(sysids) {
  const ids = parseSysidList(sysids);
  const component = { compid: 1, state: 'active', type: 0, armed: false, autopilot: 0 };
  return {
    peerTable: {
      snapshot() {
        return ids.map((sysid) => ({ sysid, components: [component] }));
      },
      getComponent(sysid, compid) {
        if (!ids.includes(sysid) || compid !== 1) return undefined;
        return component;
      },
    },
  };
}
