'use strict';

const { LockRegistry } = require('../delivery/lock');
const { LogList } = require('./list');
const { LogDownload } = require('./download');

const OPERATION = { LIST: 'list', DOWNLOAD: 'download' };
const locks = new LockRegistry();

/**
 * Construct a log operation. Log list/download use one connection/target
 * scope because both protocols stop or occupy the vehicle's log sender.
 *
 * @param {string} operation
 * @param {object} opts
 * @returns {LogList|LogDownload|undefined}
 */
function createMachine(operation, opts) {
  switch (operation) {
    case OPERATION.LIST:
      return new LogList(opts);
    case OPERATION.DOWNLOAD:
      return new LogDownload(opts);
    default: break; // This space intentionally left blank (§5)
  }
  return undefined; // nothing matched: no behavior selected (§5)
}

module.exports = { createMachine, locks, OPERATION };
