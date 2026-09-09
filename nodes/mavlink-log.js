'use strict';

/**
 * mavlink-log — list or download onboard logs through the MAVLink log
 * transfer protocol. The library owns the bounded exchange; this node only
 * resolves the Connection/target and shapes the two-output action contract.
 * Output 0 is a list or Buffer for a successful operation. Output 1 carries
 * progress and the terminal status record.
 */

const {
  makeStatusRecord,
  shouldSuppress,
  applyActionStatus,
  failInput,
} = require('../lib/delivery');
const { BAND } = require('../lib/connection/bands');
const { createMachine, locks, OPERATION } = require('../lib/log');
const { resolveDeliveryContext } = require('../lib/addressing/delivery-context');

function registerMavlinkLog(RED) {
  function MavlinkLogNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const connAtDeploy = RED.nodes.getNode(config.connection);
    const activeByKey = new Map();

    node.on('input', (msg, send, done) => {
      try {
        handle(msg, send, done);
      } catch (err) {
        failInput(node, send, err, done);
      }
    });

    function handle(msg, send, done) {
      if (shouldSuppress(msg)) {
        done();
        return;
      }

      const payload = msg.payload;
      const operation = config.operation;
      const id = payload.id === undefined ? config.logId : payload.id;

      const { connectionNode: connNode, target, identityId } = resolveDeliveryContext(RED, {
        delivery: 'confirm',
        config,
        payload,
        connectionNode: connAtDeploy,
        compidFromConfig: true,
      });

      const machine = createMachine(operation, {
        send: (message) => connNode.send(message, {
          band: BAND.BULK,
          target,
          identityId,
        }),
        subscribe: (filter, handler) => connNode.subscribe(filter, handler),
        target,
        id,
        size: payload.size,
        timeoutMs: Number(config.timeoutMs),
        maxRetries: Number(config.maxRetries),
        onProgress: (update) => send([
          null,
          record(node, operation, target, { result: 'progress', ...update }),
        ]),
      });

      const release = locks.acquire(connNode.id, target);
      if (!release) {
        applyActionStatus(node, 'error', `${operation} busy`);
        send([null, record(node, operation, target, {
          result: 'failed',
          phase: 'locked',
          reason: 'a log operation is already in progress for this target',
        })]);
        done();
        return;
      }

      const lockKey = locks.key(connNode.id, target);
      activeByKey.set(lockKey, machine);
      applyActionStatus(node, 'sending', `${operation}…`);

      let settled;
      try {
        settled = machine.start();
      } catch (err) {
        activeByKey.delete(lockKey);
        release();
        throw err;
      }

      settled.then((outcome) => {
        if (activeByKey.get(lockKey) === machine) activeByKey.delete(lockKey);
        release();
        const status = record(node, operation, target, statusFields(outcome));
        if (outcome.result === 'succeeded') {
          applyActionStatus(node, 'ok', successBadge(operation, outcome));
          send([successMessage(operation, outcome, msg), status]);
          done();
          return;
        }
        if (outcome.result === 'cancelled') {
          done();
          return;
        }
        applyActionStatus(node, 'error', `${operation} failed`);
        send([null, status]);
        done();
      }).catch((err) => {
        if (activeByKey.get(lockKey) === machine) activeByKey.delete(lockKey);
        release();
        failInput(node, send, err, done, { operation, target });
      });
    }

    node.on('close', (done) => {
      for (const machine of activeByKey.values()) machine.cancel();
      activeByKey.clear();
      done();
    });
  }

  RED.nodes.registerType('mavlink-log', MavlinkLogNode);
}

function record(node, operation, target, fields) {
  return makeStatusRecord(node.type, { operation, target, ...fields });
}

function statusFields(outcome) {
  const { data: _data, ...fields } = outcome;
  return fields;
}

function successMessage(operation, outcome, msg) {
  const output = { ...msg };
  switch (operation) {
    case OPERATION.LIST:
      output.payload = outcome.entries;
      return output;
    case OPERATION.DOWNLOAD:
      output.payload = outcome.data;
      output.logId = outcome.id;
      return output;
    default: break; // This space intentionally left blank (§5)
  }
  return output;
}

function successBadge(operation, outcome) {
  switch (operation) {
    case OPERATION.LIST: return `${outcome.count} logs`;
    case OPERATION.DOWNLOAD: return `log ${outcome.id} downloaded`;
    default: break; // This space intentionally left blank (§5)
  }
  return operation;
}

module.exports = registerMavlinkLog;
module.exports.successMessage = successMessage;
module.exports.statusFields = statusFields;
