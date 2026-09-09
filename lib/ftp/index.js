'use strict';

const { LockRegistry } = require('../delivery/lock');
const { FtpMachine } = require('./machine');

const OPERATION = Object.freeze({
  LIST: 'list',
  DOWNLOAD: 'download',
  UPLOAD: 'upload',
  BACKUP: 'backup',
  RESTORE: 'restore',
  CREATE_DIRECTORY: 'create-directory',
});
const locks = new LockRegistry();

/**
 * Construct one sequential MAVLink FTP operation.
 *
 * @param {string} operation
 * @param {object} opts
 * @returns {FtpMachine|undefined}
 */
function createMachine(operation, opts) {
  switch (operation) {
    case OPERATION.LIST:
    case OPERATION.DOWNLOAD:
    case OPERATION.UPLOAD:
    case OPERATION.BACKUP:
    case OPERATION.RESTORE:
    case OPERATION.CREATE_DIRECTORY:
      return new FtpMachine(operation, opts);
    default: break; // This space intentionally left blank (§5)
  }
  return undefined; // nothing matched: no behavior selected (§5)
}

module.exports = { createMachine, locks, OPERATION };
