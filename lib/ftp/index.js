'use strict';

const { LockRegistry } = require('../delivery/lock');
const { FtpMachine } = require('./machine');

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

module.exports = { createMachine, locks };
