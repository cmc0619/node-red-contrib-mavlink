'use strict';

/**
 * Connection runtime (DESIGN.md §7, §8, §12 step 4). The Connection config node
 * (`nodes/mavlink-connection.js`) is thin: it reads config, resolves the bound
 * Vehicle Profile and Local Identities, and constructs a {@link Connection}
 * here — all the queue-band, peer-table, subscription, heartbeat, signing, and
 * lifecycle logic lives in this library (§2).
 *
 * Public surface:
 *   - {@link Connection} / {@link STATE}  — the runtime and its state machine
 *   - {@link PeerTable}  — sysid-keyed peer table (§8)
 */

const { Connection, STATE } = require('./runtime');
const { PeerTable } = require('./peer-table');

module.exports = {
  Connection,
  STATE,
  PeerTable,
};
