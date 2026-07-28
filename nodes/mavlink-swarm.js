'use strict';

const delivery = require('../lib/delivery');
const { executeSwarm, guardSwarmInput } = require('../lib/swarm');

module.exports = function registerMavlinkSwarm(RED) {
  function MavlinkSwarmNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const connectionNode = config.connection ? RED.nodes.getNode(config.connection) : null;

    // Build + explicit list resolves without a peer table (§6 exception): the
    // sysids are known at deploy time. All other combinations — including
    // build+all and build+filter — still need the live peer table.
    const cfgIsBuildList =
      (config.delivery || 'build') === 'build' &&
      (config.selectionMode || 'all') === 'list';

    if (!cfgIsBuildList && (!connectionNode || !connectionNode.peerTable)) {
      delivery.applyActionStatus(node, 'invalid', 'invalid config');
    }

    node.on('input', async (msg, send, done) => {
      const emit = send || ((messages) => node.send(messages));
      const guard = guardSwarmInput(msg);
      if (guard.action === 'suppress') {
        if (done) done();
        return;
      }
      if (guard.action === 'refuse') {
        delivery.applyActionStatus(node, 'error', 'refused');
        node.error('mavlink-swarm: received a status record on input (miswire)', msg);
        emit([null, guard.record]);
        if (done) done();
        return;
      }

      try {
        const payload = objectPayload(msg.payload);
        const selection = selectionFrom(config, payload);
        const effectiveDelivery = payload.delivery || config.delivery || 'build';
        const effectiveSelectionMode = selection.mode || 'all';

        let effectiveConnection = connectionNode;
        if (!connectionNode || !connectionNode.peerTable) {
          if (effectiveDelivery === 'build' && effectiveSelectionMode === 'list') {
            // No connection needed: build messages for the explicit sysid list
            // without consulting a live peer table (§6 Swarm exception).
            effectiveConnection = buildListStub(selection.sysids);
          } else {
            const rule = effectiveDelivery === 'build'
              ? `build+${effectiveSelectionMode} selection requires a Connection — ` +
                `the live peer table is the only place ${effectiveSelectionMode} selection can resolve`
              : 'requires a Connection with a peer table';
            throw new Error(`mavlink-swarm: ${rule}`);
          }
        }

        const aggregate = await executeSwarm({
          connection: effectiveConnection,
          action: actionFrom(config, payload),
          selection,
          mode: payload.executionMode || config.executionMode || 'sequential',
          delivery: effectiveDelivery,
          dryRun: payload.dryRun !== undefined ? !!payload.dryRun : !!config.dryRun,
          intervalMs: numberOption(payload, config, 'intervalMs', 100),
          timeoutMs: numberOption(payload, config, 'timeoutMs', 10000),
          maxRetries: numberOption(payload, config, 'maxRetries', 0),
          identityId: payload.identityId || config.identity,
          confirmed: msg.confirmed === true || config.confirm === true,
        });

        applyAggregateStatus(node, aggregate);
        if (!aggregate.success && aggregate.result !== 'dry_run') {
          node.error(`mavlink-swarm: ${aggregate.result}`, msg);
        }
        // Output 1 carries the aggregate status record at the message root (its
        // delivery marker on the top-level object), matching the Command node
        // and lib/delivery, so wiring output 1 back into an action node is
        // refused as a miswire. Output 0 (continue) wraps the aggregate under
        // msg.payload as a normal trigger (§9).
        emit(aggregate.continue
          ? [{ payload: aggregate }, aggregate]
          : [null, aggregate]);
        if (done) done();
      } catch (err) {
        const record = delivery.makeStatusRecord({
          node: 'mavlink-swarm',
          result: 'failed',
          success: false,
          continue: false,
          detail: err.message,
        });
        delivery.applyActionStatus(node, 'error', err.message);
        node.error(err, msg);
        emit([null, record]);
        if (done) done(err);
      }
    });
  }

  RED.nodes.registerType('mavlink-swarm', MavlinkSwarmNode);
};

function actionFrom(config, payload) {
  const type = payload.actionType || payload.type || config.actionType || 'command';
  if (type === 'command') {
    return {
      type,
      commandId: payload.commandId || config.commandId || config.advancedCommand,
      preset: payload.preset || config.preset,
      params: { ...parseJson(config.params), ...numericPayloadParams(payload), ...(payload.params || {}) },
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
      topic: payload.topic || config.topic || 'camera',
      verb: payload.verb || config.verb || 'photo',
      path: payload.path || config.path || 'legacy',
      values: payload.values || valuesFrom(config),
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

function numericPayloadParams(payload) {
  const params = {};
  for (const [key, value] of Object.entries(payload)) {
    const index = Number(key);
    if (Number.isInteger(index) && index >= 1 && index <= 7) params[index] = value;
  }
  return params;
}

function parseJson(value) {
  if (!value) return {};
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function positionFrom(config) {
  return {
    north: config.north,
    east: config.east,
    up: config.up,
    lat: config.lat,
    lon: config.lon,
    alt: config.alt,
  };
}

function velocityFrom(config) {
  return { north: config.vNorth, east: config.vEast, up: config.vUp };
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

function valueFrom(payload, config, key) {
  if (payload[key] !== undefined) return payload[key];
  return config[key] === '' ? undefined : config[key];
}

function numberOption(payload, config, key, fallback) {
  if (payload[key] !== undefined) return payload[key];
  if (config[key] !== undefined && config[key] !== '') return config[key];
  return fallback;
}

function objectPayload(payload) {
  return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
}

/**
 * Synthetic connection used when delivery=build and selectionMode=list with no
 * real Connection configured. Peer table returns one active autopilot entry per
 * listed sysid so executeSwarm can build targeted messages without needing a
 * live peer table (§6 Swarm exception).
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
      throw new Error('mavlink-swarm: build-mode list stub does not send — output goes to mavlink-out');
    },
    subscribe() {
      return () => {};
    },
  };
}

/**
 * Parse a comma-separated sysid list. Each id must be an integer in 1..255
 * (MAVLink system id is a uint8; 0 is broadcast and not a swarm member).
 * Bad tokens fail loudly — silently dropping `256` would send a partial swarm.
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
        `mavlink-swarm: sysid must be an integer in 1..255 (got ${JSON.stringify(part)})`
      );
    }
    ids.push(n);
  }
  return ids;
}
