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
        await inFlight.track((signal) => run(context, signal).then((outcome) => {
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

/**
 * The bundle's sections in transfer order. Each is the service that owns it,
 * so the same word is the key in the backup object, the protocol, the mission
 * type and the lock scope.
 *
 * @type {string[]}
 */
const BUNDLE_SECTIONS = ['parameters', 'mission', 'fence', 'rally', 'files'];

/** A mission engine spells the bundle's operations as transfer directions. */
const MISSION_OPERATION = { backup: 'download', restore: 'upload' };

function run(context, signal) {
  switch (context.service) {
    case 'backup': return runBundle(context, signal);
    case 'logs':
    case 'files': return runSingle(context, signal);
    default: break; // This space intentionally left blank (§5)
  }
  return undefined;
}

async function runSingle(context, signal) {
  const { service, connNode, target } = context;
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
    return await Promise.resolve().then(() => {
      if (signal.aborted) return { result: 'cancelled', phase: 'cancelled' };
      started = true;
      const startedRun = machine.start();
      if (signal.aborted) machine.cancel();
      return startedRun;
    });
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}

async function runBundle(context, signal) {
  const { operation, connNode, target } = context;
  const result = {};
  for (const section of sectionsFor(context)) {
    if (signal.aborted) return { result: 'cancelled', phase: 'cancelled' };
    const stepContext = { ...context, service: section, payload: sectionPayload(context, section) };
    const release = protocolFor(section).locks.acquire(connNode.id, target, missionTypeFor(section));
    if (!release) {
      return {
        result: 'failed',
        phase: 'locked',
        section,
        reason: `${section} is already in progress for this target`,
      };
    }
    try {
      const outcome = await runMachine(bundleMachine(stepContext), signal);
      if (signal.aborted || outcome.result === 'cancelled') return { ...outcome, section };
      if (outcome.result !== 'succeeded') return { ...outcome, section };
      result[section] = outcome;
    } finally {
      release();
    }
  }
  switch (operation) {
    case 'backup':
      return {
        result: 'succeeded',
        phase: 'done',
        bundle: {
          parameters: result.parameters.params,
          mission: jsonSafeItems(result.mission.items),
          fence: jsonSafeItems(result.fence.items),
          rally: jsonSafeItems(result.rally.items),
          files: {
            root: result.files.root,
            directories: result.files.directories,
            files: result.files.files,
          },
        },
      };
    case 'restore':
      // An object carrying no section runs no engine. Reporting that as a
      // restore is the false success §9 names, and the honest place to settle
      // it is here, where the outcome is reported, not by vetting the payload.
      if (Object.keys(result).length === 0) {
        return { result: 'failed', phase: 'empty', reason: 'no section to restore' };
      }
      return {
        result: 'succeeded',
        phase: 'done',
        restored: true,
        sections: Object.fromEntries(
          Object.entries(result).map(([name, outcome]) => [name, restoreCount(name, outcome)])
        ),
      };
    default: break; // This space intentionally left blank (§5)
  }
  return undefined;
}

/**
 * Backup covers every section. Restore covers the sections the bundle in hand
 * actually carries, so an object holding one section restores only that one
 * and a bundle that lost a section to a failed backup restores the rest.
 *
 * @param {object} context
 * @returns {string[]}
 */
function sectionsFor(context) {
  switch (context.operation) {
    case 'backup': return BUNDLE_SECTIONS;
    case 'restore': return BUNDLE_SECTIONS.filter((section) => section in context.payload);
    default: break; // This space intentionally left blank (§5)
  }
  return undefined;
}

/**
 * A backup step reads the node's own payload; a restore step reads the slice
 * of the saved bundle that its section owns.
 *
 * @param {object} context
 * @param {string} section
 * @returns {*}
 */
function sectionPayload(context, section) {
  switch (context.operation) {
    case 'backup': return context.payload;
    case 'restore': return context.payload[section];
    default: break; // This space intentionally left blank (§5)
  }
  return undefined;
}

function bundleMachine(context) {
  const options = machineOptions(context);
  switch (context.service) {
    case 'parameters':
      return new parameterProtocol.ParamBackupRestore(context.operation, options);
    case 'mission':
    case 'fence':
    case 'rally':
      return missionProtocol.createMachine(MISSION_OPERATION[context.operation], options);
    case 'files':
      return new ftpProtocol.FtpMachine(context.operation, options);
    default: break; // This space intentionally left blank (§5)
  }
  return undefined;
}

/**
 * Mission items carry the same nonfinite floats parameters do, so a saved
 * bundle keeps NaN and negative zero through JSON (lib/param/backup.js).
 *
 * @param {object[]} items
 * @returns {object[]}
 */
function jsonSafeItems(items) {
  return items.map((item) => Object.fromEntries(
    Object.entries(item).map(([key, value]) => [key, jsonSafeValue(value)])
  ));
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
    case 'mission':
    case 'fence':
    case 'rally': return missionProtocol;
    default: break; // This space intentionally left blank (§5)
  }
  return undefined;
}

/**
 * The plan type a section transfers under, which the bundle also passes as its
 * lock scope: mission, fence and rally share one lock registry and this value
 * is the only thing keeping them apart. A section that is not a plan has
 * neither, and that `undefined` carries weight — it is what makes the bundle's
 * files step take the same lock as a standalone Files transfer, which passes
 * no scope of its own.
 *
 * The switch keys on the service name, not on what missionTypeValue returns,
 * because neither test on the result works: MAV_MISSION_TYPE_MISSION is 0, so
 * any falsy check drops the mission's own scope, and missionTypeValue forwards
 * a name it does not know unchanged, so 'files' would scope itself by its name
 * and stop colliding with the transfer it must wait for.
 *
 * @param {string} service
 * @returns {number|undefined}
 */
function missionTypeFor(service) {
  switch (service) {
    case 'mission':
    case 'fence':
    case 'rally': return missionTypeValue(service);
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
    // Everything this node does is a transfer: log listings and downloads,
    // file trees, and the backup bundle's own reads and replays. A restore is
    // a saved file going back, not an operator writing a parameter, so it
    // queues behind control traffic like the rest (§10 bands).
    send: (message) => connNode.send(message, {
      band: BAND.BULK,
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
        path: msg.path === undefined ? config.path : msg.path,
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
    case 'mission|backup':
    case 'fence|backup':
    case 'rally|backup':
      return {
        ...shared,
        missionType: missionTypeFor(service),
        sourceIds: connNode.resolveSourceIds(identityId),
      };
    case 'mission|restore':
    case 'fence|restore':
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
    default: break; // This space intentionally left blank (§5)
  }
  return undefined;
}

module.exports = registerMavlinkSystem;
module.exports.machineOptions = machineOptions;
module.exports.statusFields = statusFields;
module.exports.successMessage = successMessage;
