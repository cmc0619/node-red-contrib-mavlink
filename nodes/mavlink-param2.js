'use strict';

module.exports = function registerMavlinkParam2(RED) {
  require('./mavlink-param')(RED, 'mavlink-param2');
};
