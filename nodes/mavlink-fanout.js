'use strict';

const delivery = require('../lib/delivery');
const { executeFanout, parseSysidList } = require('../lib/fanout');
const { applyConnectionStatus, numberOr } = require('../lib/addressing');

module.exports = function registerMavlinkFanout(RED) {
  function MavlinkFanoutNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const connectionNode = RED.nodes.getNode(config.connection);

    // The editor requires an explicit sysid list on Build (#191), so config
    // follows the standard rule: no Connection needed on Build, required on
    // the wire tiers. Runtime payload overrides that ask for build+all or
    // build+filter without a Connection are refused per message below.
    applyConnectionStatus(node, config.delivery !== 'build', connectionNode);

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
        const selection = opts.selection || selectionFrom(config);
        const selectionMode = selection.mode;
        const effectiveDelivery = opts.delivery || config.delivery;
        const listSelected = selectionMode === 'list' || Array.isArray(opts.targets);

        let effectiveConnection = connectionNode;
        if (!connectionNode) {
          if (effectiveDelivery === 'build' && listSelected) {
            // No connection needed: replicate for the explicit sysid list
            // without consulting a live peer table (§6 Fan-out exception).
            effectiveConnection = buildListStub(
              Array.isArray(opts.targets)
                ? opts.targets.map((t) => (typeof t === 'object' && t !== null ? t.sysid : t))
                : selection.sysids
            );
          }
        }

        const aggregate = await inFlight.track((signal) => executeFanout({
          signal,
          connection: effectiveConnection,
          message,
          targets: opts.targets,
          members: configMembersFor(config, opts),
          selection,
          // Affirmative dispatch (§5): lib/fanout maps only broadcast and
          // sequential — an unknown or blank mode selects no case, so no run
          // starts and the aggregate comes back undefined (handled below).
          mode: opts.executionMode || config.executionMode,
          delivery: effectiveDelivery,
          dryRun: opts.dryRun !== undefined ? !!opts.dryRun : !!config.dryRun,
          intervalMs: numberOption(opts, config, 'intervalMs'),
          timeoutMs: numberOption(opts, config, 'timeoutMs'),
          maxRetries: numberOption(opts, config, 'maxRetries'),
          concurrency: numberOption(opts, config, 'concurrency'),
          stopOnError: opts.stopOnError !== undefined ? !!opts.stopOnError : !!config.stopOnError,
          identityId: opts.identityId || config.identity,
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

        applyAggregateStatus(node, aggregate);
        // Output 1 carries the aggregate status record at the message root.
        // On Build delivery output 0 carries the product — one message per
        // member, ready for mavlink-out — matching every other Build tier
        // (§9 "Build's output goes to mavlink-out"). On wire tiers output 0
        // is the continue trigger wrapping the aggregate (§9).
        if (aggregate.result === 'succeeded' && effectiveDelivery === 'build') {
          // Sequential build: one message per member. Broadcast build: the
          // single target_system=0 packet (aggregate.message).
          const perMember = aggregate.message
            ? [{ payload: aggregate.message }]
            : aggregate.members
                .filter((member) => member.success && member.message)
                .map((member) => ({ payload: member.message }));
          send([perMember, aggregate]);
        } else {
          send(aggregate.continue
            ? [{ payload: aggregate }, aggregate]
            : [null, aggregate]);
        }
        if (!aggregate.success && aggregate.result !== 'dry_run' && !quietEmpty(aggregate)) {
          done(new Error(`mavlink-fanout: ${aggregate.result}`));
        } else {
          done();
        }
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
  if (payload && typeof payload === 'object' && payload.message && typeof payload.message === 'object') {
    const { message, ...opts } = payload;
    return { message, opts };
  }
  return { message: payload, opts: {} };
}

function selectionFrom(config) {
  const filter = {};
  assignIfPresent(filter, 'type', config.vehicleType);
  assignIfPresent(filter, 'firmware', config.firmwareFilter);
  assignIfPresent(filter, 'armed', config.armedFilter);
  // No `|| 'all'`: the editor always saves a member, and the runtime maps
  // nothing — a blank saved mode crashes at dispatch, like any non-member.
  const mode = config.selectionMode;
  return {
    mode,
    // List selection reads its sysids from the members table rows (#163).
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
 * A filter matching zero vehicles is the correct answer, not a fault (#226):
 * the run reports quietly — grey badge, no done(err) — while output 1 still
 * carries the empty aggregate with success:false, so nothing downstream sees
 * a phantom success (§2). An empty explicit list or an empty 'all' stays
 * loud: the operator named vehicles (or expected a fleet) and reached none.
 *
 * @param {object} aggregate
 * @returns {boolean}
 */
function quietEmpty(aggregate) {
  return aggregate.result === 'empty' && aggregate.selection === 'filter';
}

function applyAggregateStatus(node, aggregate) {
  if (aggregate.result === 'dry_run') {
    delivery.applyActionStatus(node, 'preview', `${aggregate.count} preview`);
  } else if (aggregate.success) {
    delivery.applyActionStatus(node, 'ok', `${aggregate.count} succeeded`);
  } else if (quietEmpty(aggregate)) {
    // Not a §6 action situation: neither an error nor a success — grey ring,
    // matching the palette's other idle/none badges.
    node.status({ fill: 'grey', shape: 'ring', text: '0 matched' });
  } else {
    delivery.applyActionStatus(node, 'error', aggregate.result);
  }
}

function assignIfPresent(target, key, value) {
  if (value !== undefined && value !== null && value !== '') target[key] = value;
}

/**
 * A numeric run option: the payload wrapper overrides, else the saved config
 * value.
 *
 * Absence stays absence (§5: blank ≠ 0 ≠ absent): no value at either level
 * passes `undefined` through so lib/fanout's own absence default fires.
 * Coercing absence would hand the run NaN, and every pacing comparison
 * against NaN is false — an unthrottled fleet send with no symptom (Gitar,
 * #287). A present garbage value is the editor's to red (§14): these keys
 * never reach the wire, and a finite-number check on operator input is a
 * guardrail.
 */
function numberOption(opts, config, key) {
  return numberOr(opts[key], numberOr(config[key], undefined));
}

/**
 * Synthetic connection used when delivery=build with an explicit sysid list
 * (config list selection or a runtime targets array) and no real Connection
 * configured. Peer table returns one active autopilot entry per listed sysid
 * so executeFanout can retarget messages without a live peer table (§6 Fan-out
 * exception).
 *
 * @param {string|Array} sysids  Sysids from the members rows, a payload
 *   selection, or a targets array.
 * @returns {object}
 */
function buildListStub(sysids) {
  const ids = parseSysidList(sysids);
  return {
    peerTable: {
      snapshot() {
        return ids.map((sysid) => ({
          sysid,
          components: [{ compid: 1, state: 'active', type: 0, firmware: null, armed: false, autopilot: 0 }],
        }));
      },
      getComponent(sysid, compid) {
        if (!ids.includes(sysid) || compid !== 1) return undefined;
        return { compid: 1, state: 'active', type: 0, firmware: null, armed: false, autopilot: 0 };
      },
    },
    send() {
      // eslint-disable-next-line no-restricted-syntax -- outside §0: an unreachable-by-design stub — the build-tier list stub has no link to send on
      throw new Error('mavlink-fanout: build-mode list stub does not send — output goes to mavlink-out');
    },
    subscribe() {
      return () => {};
    },
  };
}
