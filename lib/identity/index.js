'use strict';

/**
 * Local Identity helpers (DESIGN.md §7, §13).
 */

const { ROLE_PRESETS } = require('./presets');
const { resolveIdentity } = require('./resolve');
const { heartbeatFields } = require('./heartbeat');

module.exports = {
  ROLE_PRESETS,
  resolveIdentity,
  heartbeatFields,
};
