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
 *   - {@link OutboundQueue} / {@link QueueOverflowError}  — the band queue (§7)
 *   - {@link PeerTable}  — sysid-keyed peer table (§8)
 *   - {@link SubscriptionRegistry}  — copy-per-subscriber delivery (§7)
 *   - {@link HeartbeatScheduler}  — per-identity 1 Hz emission (§7)
 *   - {@link SigningState}  — link id, sequence, replay, timestamp policy (§7)
 *   - {@link createTransport}  — UDP / TCP / serial factory
 *   - {@link createWire}  — node-mavlink framing adapter (lazy-loaded)
 *   - band constants and DSCP marks
 */

const { Connection, STATE } = require('./runtime');
const { OutboundQueue, QueueOverflowError } = require('./queue');
const { PeerTable } = require('./peer-table');
const { SubscriptionRegistry } = require('./subscriptions');
const { HeartbeatScheduler, buildHeartbeat } = require('./heartbeat');
const { SigningState, timestampFromMs, ONE_MINUTE_UNITS } = require('./signing');
const {
  createTransport,
  UdpTransport,
  TcpTransport,
  SerialTransport,
  UDP_NO_DESTINATION,
  UDP_INCOMPLETE_DESTINATION,
  TCP_NO_DESTINATION,
  TCP_PEER_GONE,
  SERIAL_NO_DESTINATION,
  TRANSPORT_QUIET_SEND_CODES,
} = require('./transport');
const { createWire } = require('./wire');
const { deepCopy } = require('./clone');
const { BAND, BAND_NAME, DSCP, AGE_CLAMP_BAND } = require('./bands');

module.exports = {
  Connection,
  STATE,
  OutboundQueue,
  QueueOverflowError,
  PeerTable,
  SubscriptionRegistry,
  HeartbeatScheduler,
  buildHeartbeat,
  SigningState,
  timestampFromMs,
  ONE_MINUTE_UNITS,
  createTransport,
  UdpTransport,
  TcpTransport,
  SerialTransport,
  UDP_NO_DESTINATION,
  UDP_INCOMPLETE_DESTINATION,
  TCP_NO_DESTINATION,
  TCP_PEER_GONE,
  SERIAL_NO_DESTINATION,
  TRANSPORT_QUIET_SEND_CODES,
  createWire,
  deepCopy,
  BAND,
  BAND_NAME,
  DSCP,
  AGE_CLAMP_BAND,
};
