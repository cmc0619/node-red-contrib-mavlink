'use strict';

const delivery = require('../lib/delivery');
const { executeFanout, guardFanoutInput, createFanoutCancel } = require('../lib/fanout');
const { resolveFrame, mergeParams, DEFAULT_TIMEOUT_MS } = require('../lib/command');
const { positionFrom, velocityFrom, valueFrom } = require('../lib/move');
const { dialectFromConnection } = require('../lib/addressing');

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

    // At most one fan-out in flight per node, tracked so `close` can both stop
    // it and wait for it to unwind. Node-RED's close does not abort a running
    // promise chain: without this, a redeploy leaves the member loop sending
    // live vehicle commands from a node that no longer exists.
    let inFlight = null;
    let cancel = null;

    node.on('input', async (msg, send, done) => {
      const guard = guardFanoutInput(msg);
      if (guard.action === 'suppress') {
        done();
        return;
      }

      try {
        const payload = msg.payload ?? {};
        const selection = selectionFrom(config, payload);
        const effectiveDelivery = payload.delivery || config.delivery;
        const effectiveSelectionMode = selection.mode || 'all';

        let effectiveConnection = connectionNode;
        if (!connectionNode || !connectionNode.peerTable) {
          if (effectiveDelivery === 'build' && effectiveSelectionMode === 'list') {
            // No connection needed: build messages for the explicit sysid list
            // without consulting a live peer table (§6 Fan-out exception).
            effectiveConnection = buildListStub(selection.sysids);
          } else {
            const rule = effectiveDelivery === 'build'
              ? `build+${effectiveSelectionMode} selection requires a Connection — ` +
                `the live peer table is the only place ${effectiveSelectionMode} selection can resolve`
              : 'requires a Connection with a peer table';
            throw new Error(`mavlink-fanout: ${rule}`);
          }
        }

        cancel = createFanoutCancel();
        const run = executeFanout({
          cancel,
          connection: effectiveConnection,
          vehicleBundle: dialectFromConnection(RED, effectiveConnection),
          action: actionFrom(config, payload),
          selection,
          mode: payload.executionMode || config.executionMode || 'sequential',
          delivery: effectiveDelivery,
          dryRun: payload.dryRun !== undefined ? !!payload.dryRun : !!config.dryRun,
          intervalMs: numberOption(payload, config, 'intervalMs', 100),
          timeoutMs: numberOption(payload, config, 'timeoutMs', DEFAULT_TIMEOUT_MS),
          maxRetries: numberOption(payload, config, 'maxRetries', 0),
          identityId: payload.identityId || config.identity,
          confirmed: msg.confirmed === true || config.confirm === true,
        });
        inFlight = run;
        let aggregate;
        try {
          aggregate = await run;
        } finally {
          if (inFlight === run) inFlight = null;
        }

        // A redeploy cancelled us. The node is going away: finish quietly
        // rather than emitting or raising on a closed node, which would trip a
        // Catch node wired for "fan-out failed → failsafe" on a mere deploy.
        if (aggregate.result === 'cancelled') {
          done();
          return;
        }

        applyAggregateStatus(node, aggregate);
        // Output 1 carries the aggregate status record at the message root.
        // Output 0 (continue) wraps the aggregate under msg.payload as a normal
        // trigger (§9).
        send(aggregate.continue
          ? [{ payload: aggregate }, aggregate]
          : [null, aggregate]);
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

    node.on('close', (done) => {
      if (!inFlight) {
        done();
        return;
      }
      // Stop the loop and cut the in-flight member's ack wait short, then wait
      // for the chain to actually unwind before reporting closed. Calling
      // done() immediately would let the tail of a cancelled run emit onto a
      // node Node-RED has already torn down.
      cancel.cancel();
      inFlight.then(() => done(), () => done());
    });
  }

  RED.nodes.registerType('mavlink-fanout', MavlinkFanoutNode);
};

function actionFrom(config, payload) {
  const type = payload.actionType || payload.type || config.actionType || 'command';
  if (type === 'command') {
    return {
      type,
      commandId: payload.commandId || config.commandId || config.advancedCommand,
      preset: payload.preset || config.preset,
      // mergeParams Number-coerces 1–7; payload.params overlays last.
      params: mergeParams(config, { ...payload, ...(payload.params || {}) }),
      carrier: payload.carrier || config.carrier,
      frame: resolveFrame(payload.mavFrame, config.frame),
    };
  }
  if (type === 'move') {
    return {
      type,
      mode: payload.moveMode || config.moveMode || 'local-position',
      position: payload.position || positionFrom(config),
      velocity: payload.velocity || velocityFrom(config),
      yaw: valueFrom(payload, config, 'yaw'),
      yawRate: valueFrom(payload, config, 'yawRate'),
      timeBootMs: payload.timeBootMs || config.timeBootMs || 0,
    };
  }
  if (type === 'payload') {
    return {
      type,
      topic: payload.topic || config.topic,
      verb: payload.verb || config.verb,
      path: payload.path || config.path,
      values: payload.values || valuesFrom(config),
      carrier: payload.carrier || config.carrier,
      frame: resolveFrame(payload.mavFrame, config.frame),
    };
  }
  if (type === 'param') {
    return {
      type,
      action: payload.paramAction || payload.action || config.paramAction || 'set',
      paramId: payload.paramId || config.paramId,
      value: payload.value !== undefined ? payload.value : config.value,
      paramType: payload.paramType || config.paramType || 'MAV_PARAM_TYPE_REAL32',
      firmware: payload.firmware || config.firmware,
    };
  }
  return { type };
}

function selectionFrom(config, payload) {
  if (payload.selection) return payload.selection;
  const filter = {};
  assignIfPresent(filter, 'type', payload.vehicleType || config.vehicleType);
  assignIfPresent(filter, 'firmware', payload.firmwareFilter || config.firmwareFilter);
  assignIfPresent(filter, 'armed', payload.armedFilter || config.armedFilter);
  return {
    mode: payload.selectionMode || config.selectionMode || 'all',
    sysids: payload.sysids || config.sysids,
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

function valuesFrom(config) {
  return {
    count: config.count,
    interval: config.interval,
    mode: config.modeValue,
    distance: config.distance,
    pitch: config.pitch,
    roll: config.roll,
    yaw: config.payloadYaw,
    pitchRate: config.pitchRate,
    yawRate: config.payloadYawRate,
    servo: config.servo,
    pwm: config.pwm,
    period: config.period,
    instance: config.instance,
    action: config.actionValue,
    length: config.length,
    rate: config.rate,
  };
}

function numberOption(payload, config, key, fallback) {
  if (payload[key] !== undefined) return payload[key];
  if (config[key] !== undefined && config[key] !== '') return config[key];
  return fallback;
}

/**
 * Synthetic connection used when delivery=build and selectionMode=list with no
 * real Connection configured. Peer table returns one active autopilot entry per
 * listed sysid so executeFanout can build targeted messages without needing a
 * live peer table (§6 Fan-out exception).
 *
 * @param {string|string[]} sysids  Raw sysids value from config or payload.
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
