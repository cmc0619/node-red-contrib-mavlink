'use strict';

const { LockRegistry } = require('../delivery/lock');
const { FtpMachine } = require('./machine');

const locks = new LockRegistry();

module.exports = { FtpMachine, locks };
