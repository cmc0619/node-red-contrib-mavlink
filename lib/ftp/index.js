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
 * @returns {FtpMachine}
 */
function createMachine(operation, opts) {
  return new FtpMachine(operation, opts);
}

module.exports = { createMachine, locks, OPERATION };
