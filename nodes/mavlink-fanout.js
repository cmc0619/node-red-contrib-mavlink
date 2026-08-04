'use strict';

const delivery = require('../lib/delivery');
const { executeFanout, guardFanoutInput, parseSysidList } = require('../lib/fanout');
const { DEFAULT_TIMEOUT_MS } = require('../lib/command');

module.exports = function registerMavlinkFanout(RED) {
  function MavlinkFanoutNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const connectionNode = config.connection ? RED.nodes.getNode(config.connection) : null;

    // Build + explicit list resolves without a peer table (§6 exception): the
    // sysids are known at deploy time. All other combinations — including
    // build+all and build+filter — still need the live peer table.
    const cfgIsBuildList =
      config.delivery === 'build' && config.selectionMode === 'list';

    if (!cfgIsBuildList && (!connectionNode || !connectionNode.peerTable)) {
      delivery.applyActionStatus(node, 'invalid', 'invalid config');
    }

    // Abort-on-close discipline: a redeploy aborts every run in flight and
    // waits for each to unwind. Rationale lives with delivery.inFlightTracker.
    const inFlight = delivery.inFlightTracker();

    node.on('input', async (msg, send, done) => {
      const guard = guardFanoutInput(msg);
      if (guard.action === 'suppress') {
        done();
        return;
      }

      try {
        const { message, opts } = unwrapPayload(msg.payload);
        const selection = opts.selection || selectionFrom(config);
        const effectiveDelivery = opts.delivery || config.delivery;
        const listSelected = (selection.mode || 'all') === 'list' || Array.isArray(opts.targets);

        let effectiveConnection = connectionNode;
        if (!connectionNode || !connectionNode.peerTable) {
          if (effectiveDelivery === 'build' && listSelected) {
            // No connection needed: replicate for the explicit sysid list
            // without consulting a live peer table (§6 Fan-out exception).
            effectiveConnection = buildListStub(
              Array.isArray(opts.targets)
                ? opts.targets.map((t) => (typeof t === 'object' && t !== null ? t.sysid : t))
                : selection.sysids
            );
          } else {
            const rule = effectiveDelivery === 'build'
              ? `build+${selection.mode || 'all'} selection requires a Connection — ` +
                'the live peer table is the only place that selection can resolve'
              : 'requires a Connection with a peer table';
            throw new Error(`mavlink-fanout: ${rule}`);
          }
        }

        const aggregate = await inFlight.track((signal) => executeFanout({
          signal,
          connection: effectiveConnection,
          message,
          targets: opts.targets,
          selection,
          mode: opts.executionMode || config.executionMode || 'sequential',
          delivery: effectiveDelivery,
          dryRun: opts.dryRun !== undefined ? !!opts.dryRun : !!config.dryRun,
          intervalMs: numberOption(opts, config, 'intervalMs', 100),
          timeoutMs: numberOption(opts, config, 'timeoutMs', DEFAULT_TIMEOUT_MS),
          maxRetries: numberOption(opts, config, 'maxRetries', 0),
          concurrency: numberOption(opts, config, 'concurrency', 1),
          identityId: opts.identityId || config.identity,
          confirmed: msg.confirmed === true || config.confirm === true,
        }));

        // A redeploy cancelled us. The node is going away: finish quietly
        // rather than emitting or raising on a closed node, which would trip a
        // Catch node wired for "fan-out failed → failsafe" on a mere deploy.
        if (aggregate.result === 'cancelled') {
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
        if (!aggregate.success && aggregate.result !== 'dry_run') {
          done(new Error(`mavlink-fanout: ${aggregate.result}`));
        } else {
          done();
        }
      } catch (err) {
        const record = delivery.makeStatusRecord({
          node: 'mavlink-fanout',
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
  return {
    mode: config.selectionMode || 'all',
    sysids: config.sysids,
    filter,
  };
}

function applyAggregateStatus(node, aggregate) {
  if (aggregate.result === 'dry_run') {
    delivery.applyActionStatus(node, 'preview', `${aggregate.count} preview`);
  } else if (aggregate.success) {
    delivery.applyActionStatus(node, 'ok', `${aggregate.count} succeeded`);
  } else {
    delivery.applyActionStatus(node, 'error', aggregate.result);
  }
}

function assignIfPresent(target, key, value) {
  if (value !== undefined && value !== null && value !== '') target[key] = value;
}

function numberOption(opts, config, key, fallback) {
  if (opts[key] !== undefined) return opts[key];
  if (config[key] !== undefined && config[key] !== '') return config[key];
  return fallback;
}

/**
 * Synthetic connection used when delivery=build with an explicit sysid list
 * (config list selection or a runtime targets array) and no real Connection
 * configured. Peer table returns one active autopilot entry per listed sysid
 * so executeFanout can retarget messages without a live peer table (§6 Fan-out
 * exception).
 *
 * @param {string|Array} sysids  Raw sysids from config, or target sysids.
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
      throw new Error('mavlink-fanout: build-mode list stub does not send — output goes to mavlink-out');
    },
    subscribe() {
      return () => {};
    },
  };
}
