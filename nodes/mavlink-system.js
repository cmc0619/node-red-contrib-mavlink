'use strict';

/**
 * mavlink-system — run the bounded onboard log, file, and parameter services.
 * The protocol modules own each exchange; this node resolves the Connection
 * and target, selects a service, and shapes the two-output action contract.
 */

const logProtocol = require('../lib/log');
const ftpProtocol = require('../lib/ftp');
const parameterProtocol = require('../lib/param/backup');
const { jsonSafeValue } = parameterProtocol;
const missionProtocol = require('../lib/mission');
const { missionTypeValue } = require('../lib/mission/types');
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
        delivery.applyActionStatus(node, 'sending', `${service} ${operation}…`);
        const runner = createRunner(context);
        await inFlight.track((signal) => runner(signal).then((outcome) => {
          finish(node, send, done, msg, service, operation, target, outcome);
          return outcome;
        }));
      } catch (err) {
        delivery.failInput(node, send, err, done, { service, operation });
      }
    });

    node.on('close', (done) => inFlight.close(done));
  }

  RED.nodes.registerType('mavlink-system', MavlinkSystemNode);
}

function createRunner(context) {
  switch (context.service) {
    case 'backup': return (signal) => runBundle(context, signal);
    case 'logs':
    case 'files':
      return (signal) => runSingle(context, signal);
    default: break; // This space intentionally left blank (§5)
  }
  return undefined;
}

async function runSingle(context, signal) {
  const { service, operation, connNode, target } = context;
  const protocol = protocolFor(service);
  const machine = createSingleMachine(context);
  const release = protocol.locks.acquire(connNode.id, target);
  if (!release) {
    return {
      result: 'failed',
      phase: 'locked',
      reason: `a ${service} operation is already in progress for this target`,
    };
  }
  try {
    return await runMachine(machine, signal);
  } finally {
    release();
  }
}

function createSingleMachine(context) {
  const options = machineOptions(context);
  switch (context.service) {
    case 'logs': return logProtocol.createMachine(context.operation, options);
    case 'files': return new ftpProtocol.FtpMachine(context.operation, options);
    default: break; // This space intentionally left blank (§5)
  }
  return undefined;
}

async function runMachine(machine, signal) {
  let started = false;
  const cancel = () => {
    if (started) machine.cancel();
  };
    signal.addEventListener('abort', cancel, { once: true });
  try {
    const run = Promise.resolve().then(() => {
      if (signal.aborted) return { result: 'cancelled', phase: 'cancelled' };
      started = true;
      const startedRun = machine.start();
      if (signal.aborted) machine.cancel();
      return startedRun;
    });
    return await run;
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}

async function runBundle(context, signal) {
  const { operation, connNode, target } = context;
  const input = operation === 'restore' ? context.payload : undefined;
  const sections = operation === 'backup'
    ? [
      ['parameters', 'backup'],
      ['mission', 'backup'],
      ['fence', 'backup'],
      ['rally', 'backup'],
      ['files', 'backup'],
    ]
    : [
      ['parameters', 'restore'],
      ['mission', 'restore'],
      ['fence', 'restore'],
      ['rally', 'restore'],
      ['files', 'restore'],
    ];
  const result = {};
  for (const [section, stepOperation] of sections) {
    if (signal.aborted) return { result: 'cancelled', phase: 'cancelled' };
    const step = bundleStep(context, section, stepOperation, input);
    const release = step.protocol.locks.acquire(connNode.id, target, step.scope);
    if (!release) {
      return {
        result: 'failed',
        phase: 'locked',
        section,
        reason: `${section} is already in progress for this target`,
      };
    }
    try {
      const outcome = await runMachine(step.machine, signal);
      if (signal.aborted || outcome.result === 'cancelled') {
        return { ...outcome, section };
      }
      if (outcome.result !== 'succeeded') return { ...outcome, section };
      result[section] = outcome;
    } finally {
      release();
    }
  }
  if (operation === 'backup') {
    return {
      result: 'succeeded',
      phase: 'done',
      bundle: {
        parameters: result.parameters.params,
        mission: result.mission.items,
        fence: result.fence.items,
        rally: result.rally.items,
        files: {
          root: result.files.root,
          directories: result.files.directories,
          files: result.files.files,
        },
      },
    };
  }
  return {
    result: 'succeeded',
    phase: 'done',
    restored: true,
    sections: Object.fromEntries(Object.entries(result).map(([name, outcome]) => [name, restoreCount(name, outcome)])),
  };
}

function bundleStep(context, section, operation, input) {
  const missionSection = section === 'mission' || section === 'fence' || section === 'rally';
  const service = missionSection ? 'missions' : section;
  const payload = operation === 'restore' ? input[section] : context.payload;
  const stepContext = { ...context, service, operation, payload };
  let protocol;
  let scope;
  let machine;
  switch (section) {
    case 'parameters':
      protocol = parameterProtocol;
      machine = new parameterProtocol.ParamBackupRestore(operation, machineOptions(stepContext));
      break;
    case 'mission':
    case 'fence':
    case 'rally':
      protocol = missionProtocol;
      scope = missionTypeFor(section === 'mission' ? 'missions' : section);
      machine = missionProtocol.createMachine(
        operation === 'backup' ? 'download' : 'upload',
        machineOptions({
          ...stepContext,
          service: section === 'mission' ? 'missions' : section,
        })
      );
      break;
    case 'files':
      protocol = ftpProtocol;
      machine = new ftpProtocol.FtpMachine(operation, machineOptions(
        operation === 'backup'
          ? { ...stepContext, payload: { path: context.msg.path } }
          : stepContext
      ));
      break;
    default: break; // This space intentionally left blank (§5)
  }
  return { protocol, scope, machine };
}

function restoreCount(section, outcome) {
  switch (section) {
    case 'parameters': return outcome.restored;
    case 'mission':
    case 'fence':
    case 'rally': return outcome.count;
    case 'files': return {
      files: outcome.restoredFiles,
      directories: outcome.restoredDirectories,
      bytes: outcome.bytes,
    };
    default: break; // This space intentionally left blank (§5)
  }
  return undefined;
}

function protocolFor(service) {
  switch (service) {
    case 'logs': return logProtocol;
    case 'files': return ftpProtocol;
    case 'parameters': return parameterProtocol;
    case 'missions':
    case 'fences':
    case 'rally': return missionProtocol;
    default: break; // This space intentionally left blank (§5)
  }
  return undefined;
}

function missionTypeFor(service) {
  switch (service) {
    case 'missions': return missionTypeValue('mission');
    case 'fences': return missionTypeValue('fence');
    case 'rally': return missionTypeValue('rally');
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
    case 'files|backup':
      return {
        ...shared,
        source: connNode.resolveSourceIds(identityId),
        path: payload.path === undefined ? config.path : payload.path,
      };
    case 'files|restore':
      return {
        ...shared,
        source: connNode.resolveSourceIds(identityId),
        path: msg.path === undefined ? config.path : msg.path,
        entries: payload,
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
    case 'missions|backup':
    case 'fences|backup':
    case 'rally|backup':
      return {
        ...shared,
        missionType: missionTypeFor(service),
        sourceIds: connNode.resolveSourceIds(identityId),
      };
    case 'missions|restore':
    case 'fences|restore':
    case 'rally|restore':
      return {
        ...shared,
        missionType: missionTypeFor(service),
        sourceIds: connNode.resolveSourceIds(identityId),
        items: payload,
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
    case 'files|backup':
    case 'files|restore':
    case 'parameters|backup':
    case 'missions|backup':
    case 'fences|backup':
    case 'rally|backup':
    case 'missions|restore':
    case 'fences|restore':
    case 'rally|restore':
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
    items: _items,
    files: _files,
    directories: _directories,
    bundle: _bundle,
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
    case 'files|backup':
      output.payload = {
        root: outcome.root,
        directories: outcome.directories,
        files: outcome.files,
      };
      return output;
    case 'files|restore':
      output.payload = {
        bytes: outcome.bytes,
        restoredFiles: outcome.restoredFiles,
        restoredDirectories: outcome.restoredDirectories,
      };
      return output;
    case 'backup|backup':
      output.payload = outcome.bundle;
      return output;
    case 'backup|restore':
      output.payload = { restored: outcome.restored, sections: outcome.sections };
      return output;
    case 'parameters|backup':
      output.payload = outcome.params;
      return output;
    case 'parameters|restore':
      output.payload = { restored: outcome.restored };
      return output;
    case 'missions|backup':
    case 'fences|backup':
    case 'rally|backup':
      output.payload = outcome.items.map((item) => Object.fromEntries(
        Object.entries(item).map(([key, value]) => [key, jsonSafeValue(value)])
      ));
      return output;
    case 'missions|restore':
    case 'fences|restore':
    case 'rally|restore':
      output.payload = { restored: outcome.count };
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
    case 'files|backup': return `${outcome.files.length} files backed up`;
    case 'files|restore': return `${outcome.restoredFiles} files restored`;
    case 'backup|backup': return 'backup complete';
    case 'backup|restore': return 'restore complete';
    case 'parameters|backup': return `${outcome.count} params backed up`;
    case 'parameters|restore': return `${outcome.restored} params restored`;
    case 'missions|backup':
    case 'fences|backup':
    case 'rally|backup': return `${outcome.count} ${service} backed up`;
    case 'missions|restore':
    case 'fences|restore':
    case 'rally|restore': return `${outcome.count} ${service} restored`;
    default: break; // This space intentionally left blank (§5)
  }
  return undefined;
}

module.exports = registerMavlinkSystem;
module.exports.machineOptions = machineOptions;
module.exports.statusFields = statusFields;
module.exports.successMessage = successMessage;
