'use strict';

/**
 * mavlink-system — run the bounded onboard log, file, and parameter services.
 * The protocol modules own each exchange; this node resolves the Connection
 * and target, selects a service, and shapes the two-output action contract.
 */

const logProtocol = require('../lib/log');
const ftpProtocol = require('../lib/ftp');
const parameterProtocol = require('../lib/param/backup');
const { resolveParamEncoding, capabilitiesFromPeer } = require('../lib/param');
const { BAND } = require('../lib/connection/bands');
const { resolveDeliveryContext } = require('../lib/addressing/delivery-context');
const delivery = require('../lib/delivery');

function registerMavlinkSystem(RED) {
  function MavlinkSystemNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const connAtDeploy = RED.nodes.getNode(config.connection);
    const inFlight = delivery.inFlightTracker();

    node.on('input', async (msg, send, done) => {
      const service = config.service;
      const operation = config.operation;
      try {
        if (delivery.shouldSuppress(msg)) {
          done();
          return;
        }

        const payload = msg.payload;
        const { connectionNode: connNode, profile, target, identityId } =
          resolveDeliveryContext(RED, {
            delivery: 'confirm',
            config,
            payload,
            connectionNode: connAtDeploy,
            compidFromConfig: true,
          });
        const protocol = protocolFor(service);
        const context = {
          service,
          operation,
          config,
          msg,
          payload,
          connNode,
          profile,
          target,
          identityId,
          send,
          node,
        };
        const machine = protocol.createMachine(operation, machineOptions(context));

        const release = protocol.locks.acquire(connNode.id, target);
        if (!release) {
          delivery.applyActionStatus(node, 'error', `${service} busy`);
          send([null, record(node, service, operation, target, {
            result: 'failed',
            phase: 'locked',
            reason: `a ${service} operation is already in progress for this target`,
          })]);
          done();
          return;
        }

        delivery.applyActionStatus(node, 'sending', `${service} ${operation}…`);
        await inFlight.track((signal) => {
          let started = false;
          signal.addEventListener('abort', () => {
            if (started) machine.cancel();
          }, { once: true });

          return Promise.resolve().then(() => {
            started = true;
            const startedRun = machine.start();
            if (signal.aborted) machine.cancel();
            return startedRun;
          }).then((outcome) => {
            release();
            finish(node, send, done, msg, service, operation, target, outcome);
            return outcome;
          }).catch((err) => {
            release();
            delivery.failInput(node, send, err, done, { service, operation, target });
            return undefined;
          });
        });
      } catch (err) {
        delivery.failInput(node, send, err, done, { service, operation });
      }
    });

    node.on('close', (done) => inFlight.close(done));
  }

  RED.nodes.registerType('mavlink-system', MavlinkSystemNode);
}

function protocolFor(service) {
  switch (service) {
    case 'logs': return logProtocol;
    case 'files': return ftpProtocol;
    case 'parameters': return parameterProtocol;
    default: break; // This space intentionally left blank (§5)
  }
  return undefined;
}

function machineOptions(context) {
  const {
    service,
    operation,
    config,
    msg,
    payload,
    connNode,
    profile,
    target,
    identityId,
    send,
    node,
  } = context;
  const shared = {
    send: (message) => connNode.send(message, {
      band: bandFor(service, operation),
      target,
      identityId,
    }),
    subscribe: (filter, handler) => connNode.subscribe(filter, handler),
    target,
    timeoutMs: Number(config.timeoutMs),
    maxRetries: Number(config.maxRetries),
    onProgress: (update) => send([
      null,
      record(node, service, operation, target, { result: 'progress', ...update }),
    ]),
  };

  switch (`${service}|${operation}`) {
    case 'logs|list':
      return shared;
    case 'logs|download':
      return {
        ...shared,
        id: payload.id === undefined ? config.logId : payload.id,
        size: payload.size,
      };
    case 'files|list':
    case 'files|download':
      return {
        ...shared,
        source: connNode.resolveSourceIds(identityId),
        path: payload.path === undefined ? config.path : payload.path,
      };
    case 'files|upload':
      return {
        ...shared,
        source: connNode.resolveSourceIds(identityId),
        path: msg.path === undefined ? config.path : msg.path,
        data: payload,
      };
    case 'parameters|backup':
      return {
        ...shared,
        encoding: resolvedEncoding(config, payload, connNode, target, profile),
      };
    case 'parameters|restore':
      return {
        ...shared,
        encoding: resolvedEncoding(config, payload, connNode, target, profile),
        params: payload,
      };
    default: break; // This space intentionally left blank (§5)
  }
  return undefined;
}

function bandFor(service, operation) {
  switch (`${service}|${operation}`) {
    case 'logs|list':
    case 'logs|download':
    case 'files|list':
    case 'files|download':
    case 'files|upload':
    case 'parameters|backup':
      return BAND.BULK;
    case 'parameters|restore':
      return BAND.CONTROL;
    default: break; // This space intentionally left blank (§5)
  }
  return undefined;
}

function resolvedEncoding(config, payload, connNode, target, profile) {
  const payloadEncoding = payload.paramEncoding;
  const configuredEncoding = payloadEncoding === undefined
    ? config.paramEncoding
    : payloadEncoding;
  const encoding = payloadEncoding === undefined && configuredEncoding === 'auto'
    ? undefined
    : configuredEncoding;
  return resolveParamEncoding({
    encoding,
    capabilities: capabilitiesFromPeer(connNode, target),
    firmware: profile.firmware,
  });
}

function finish(node, send, done, msg, service, operation, target, outcome) {
  const status = record(node, service, operation, target, statusFields(outcome));
  if (outcome.result === 'succeeded') {
    delivery.applyActionStatus(node, 'ok', successBadge(service, operation, outcome));
    send([successMessage(service, operation, outcome, msg), status]);
    done();
    return;
  }
  if (outcome.result === 'cancelled') {
    done();
    return;
  }
  delivery.applyActionStatus(node, 'error', `${service} ${operation} failed`);
  send([null, status]);
  done();
}

function record(node, service, operation, target, fields) {
  return delivery.makeStatusRecord(node.type, {
    service,
    operation,
    ...fields,
    target: { ...target },
  });
}

function statusFields(outcome) {
  const {
    data: _data,
    entries: _entries,
    params: _params,
    ...fields
  } = outcome;
  return fields;
}

function successMessage(service, operation, outcome, msg) {
  const output = { ...msg };
  switch (`${service}|${operation}`) {
    case 'logs|list':
    case 'files|list':
      output.payload = outcome.entries;
      return output;
    case 'logs|download':
      output.payload = outcome.data;
      output.logId = outcome.id;
      return output;
    case 'files|download':
      output.payload = outcome.data;
      return output;
    case 'files|upload':
      output.payload = { bytes: outcome.bytes };
      return output;
    case 'parameters|backup':
      output.payload = outcome.params;
      return output;
    case 'parameters|restore':
      output.payload = { restored: outcome.restored };
      return output;
    default: break; // This space intentionally left blank (§5)
  }
  return output;
}

function successBadge(service, operation, outcome) {
  switch (`${service}|${operation}`) {
    case 'logs|list': return `${outcome.count} logs`;
    case 'logs|download': return `log ${outcome.id} downloaded`;
    case 'files|list': return `${outcome.count} files`;
    case 'files|download': return 'file downloaded';
    case 'files|upload': return `${outcome.bytes} bytes uploaded`;
    case 'parameters|backup': return `${outcome.count} params backed up`;
    case 'parameters|restore': return `${outcome.restored} params restored`;
    default: break; // This space intentionally left blank (§5)
  }
  return undefined;
}

module.exports = registerMavlinkSystem;
module.exports.machineOptions = machineOptions;
module.exports.statusFields = statusFields;
module.exports.successMessage = successMessage;
