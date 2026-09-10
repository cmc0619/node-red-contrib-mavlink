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
 * The mission is not among them. Parameters, geofence, rally points and the
 * onboard files are the vehicle's configuration — set once and expensive to
 * lose. A mission is the task loaded for one flight, and the Mission node
 * already downloads and uploads one; carrying it here backed up a per-flight
 * payload as if it were system state.
 *
 * @type {string[]}
 */
const BUNDLE_SECTIONS = ['parameters', 'fence', 'rally', 'files'];

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
  const done = {};
  const failed = {};
  for (const section of sectionsFor(context)) {
    if (signal.aborted) return { result: 'cancelled', phase: 'cancelled' };
    const stepContext = { ...context, service: section, payload: sectionPayload(context, section) };
    const release = protocolFor(section).locks.acquire(connNode.id, target, missionTypeFor(section));
    if (!release) {
      failed[section] = {
        phase: 'locked',
        reason: `${section} is already in progress for this target`,
      };
      continue;
    }
    try {
      const outcome = await runMachine(bundleMachine(stepContext), signal);
      // Cancellation is the operator's own answer and stops the whole bundle;
      // a section that merely failed does not, so the run keeps going and the
      // outcome names it.
      if (signal.aborted || outcome.result === 'cancelled') return { ...outcome, section };
      if (outcome.result === 'succeeded') done[section] = outcome;
      else failed[section] = { phase: outcome.phase, reason: outcome.reason };
    } finally {
      release();
    }
  }
  switch (operation) {
    case 'backup': return backupOutcome(done, failed);
    case 'restore': return restoreOutcome(done, failed);
    default: break; // This space intentionally left blank (§5)
  }
  return undefined;
}

/**
 * Report what a backup captured, whether or not every section managed it.
 * Discarding the sections that did transfer because a later one could not —
 * the files step on a vehicle with no card is the ordinary case — threw away
 * a capture that cannot be retaken from a vehicle later reflashed, and a
 * bundle missing a section is already what a segmented restore accepts.
 *
 * A short bundle settles as `partial`, never `succeeded`: reporting an
 * incomplete capture as a complete one is the false success §9 names, and
 * this is the point where the outcome is reported.
 *
 * @param {Object<string, object>} done  succeeded sections, by section
 * @param {Object<string, object>} failed  the rest, by section
 * @returns {object}
 */
function backupOutcome(done, failed) {
  const captured = Object.keys(done);
  if (captured.length === 0) return { result: 'failed', phase: 'done', failed };
  const bundle = Object.fromEntries(
    captured.map((section) => [section, bundleValue(section, done[section])])
  );
  if (Object.keys(failed).length === 0) return { result: 'succeeded', phase: 'done', bundle };
  return { result: 'partial', phase: 'done', bundle, failed };
}

/**
 * Report the sections a restore wrote. It also keeps going past a failed
 * section: stopping never rolled the earlier ones back, so it left the
 * vehicle in the same mixed state while writing less of what was asked for.
 *
 * An object carrying no section at all runs no engine, and reporting that as
 * a restore is the false success §9 names — settled here, where the outcome
 * is reported, not by vetting the payload.
 *
 * @param {Object<string, object>} done  succeeded sections, by section
 * @param {Object<string, object>} failed  the rest, by section
 * @returns {object}
 */
function restoreOutcome(done, failed) {
  const written = Object.keys(done);
  if (written.length === 0 && Object.keys(failed).length === 0) {
    return { result: 'failed', phase: 'empty', reason: 'no section to restore' };
  }
  if (written.length === 0) return { result: 'failed', phase: 'done', failed };
  const sections = Object.fromEntries(
    written.map((section) => [section, restoreCount(section, done[section])])
  );
  if (Object.keys(failed).length === 0) {
    return { result: 'succeeded', phase: 'done', restored: true, sections };
  }
  return { result: 'partial', phase: 'done', restored: true, sections, failed };
}

/**
 * The saved bundle's shape for one captured section. Each engine names its
 * result fields differently, and this is the only place that knows which of
 * them the stored object carries.
 *
 * @param {string} section
 * @param {object} outcome  that section's succeeded outcome
 * @returns {*}
 */
function bundleValue(section, outcome) {
  switch (section) {
    case 'parameters': return outcome.params;
    case 'fence':
    case 'rally': return jsonSafeItems(outcome.items);
    case 'files': return {
      root: outcome.root,
      directories: outcome.directories,
      files: outcome.files,
    };
    default: break; // This space intentionally left blank (§5)
  }
  return undefined; // nothing matched: no behavior selected (§5)
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
      return parameterProtocol.createMachine(context.operation, options);
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
    case 'fence':
    case 'rally': return missionProtocol;
    default: break; // This space intentionally left blank (§5)
  }
  return undefined;
}

/**
 * The plan type a section transfers under, which the bundle also passes as its
 * lock scope: every plan type shares one lock registry and this value is the
 * only thing keeping them apart, including from a Mission node working the
 * same vehicle. A section that is not a plan has neither, and that
 * `undefined` carries weight — it is what makes the bundle's files step take
 * the same lock as a standalone Files transfer, which passes no scope of its
 * own.
 *
 * The switch keys on the service name, not on what missionTypeValue returns,
 * because missionTypeValue forwards a name it does not know unchanged: test
 * the result and 'files' would scope itself by its own name and stop
 * colliding with the transfer it must wait for.
 *
 * @param {string} service
 * @returns {number|undefined}
 */
function missionTypeFor(service) {
  switch (service) {
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
    case 'fence|backup':
    case 'rally|backup':
      return {
        ...shared,
        missionType: missionTypeFor(service),
        sourceIds: connNode.resolveSourceIds(identityId),
      };
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
  if (outcome.result === 'partial') {
    // What did transfer rides output 0: a bundle missing a section is worth
    // keeping and a segmented restore already accepts one. The badge and the
    // record name the sections that did not, so nothing reads it as complete.
    const missing = Object.keys(outcome.failed).join(', ');
    delivery.applyActionStatus(node, 'error', `${operation} without ${missing}`);
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
