'use strict';

const { deepCopy } = require('../connection/clone');

/** Must match peer-table emissions (DESIGN.md §8 / peer-table.js header). */
const DEFAULT_EVENTS = [
  'peer-new',
  'component-new',
  'heartbeat',
  'stale',
  'expired',
  'endpoint-added',
  'primary-changed',
  'multi-endpoint',
  'profile-mismatch',
  'statustext',
];

/**
 * Return a JSON-safe snapshot from the Connection-owned peer table, optionally
 * narrowed to one system/component. The returned object is detached from the
 * table so Function nodes cannot mutate connection state.
 *
 * Required, not optional: the node checks its Connection resolves before
 * calling, and every Connection owns a PeerTable — including a disabled one
 * (`mavlink-connection.js` hands it an empty table rather than none). Answering
 * `[]` for an unreadable table would report "0 peers", which reads as a real
 * answer rather than a fault.
 *
 * @param {import('../connection/peer-table').PeerTable} peerTable
 * @param {{sysid?: number, compid?: number}} [filter]
 * @returns {object[]}
 */
function snapshotPeers(peerTable, filter = {}) {
  const source = peerTable.snapshot();
  const sysid = filter.sysid === undefined || filter.sysid === '' ? null : Number(filter.sysid);
  const compid = filter.compid === undefined || filter.compid === '' ? null : Number(filter.compid);
  return deepCopy(source)
    .filter((peer) => sysid === null || peer.sysid === sysid)
    .map((peer) => ({
      ...peer,
      components: (peer.components || []).filter(
        (component) => compid === null || component.compid === compid
      ),
    }))
    .filter((peer) => peer.components.length > 0 || compid === null);
}

/**
 * Subscribe to peer-table edge events and emit flow records for transitions and
 * the live STATUSTEXT feed. Returns a close handle for node teardown.
 *
 * @param {object} peerTable EventEmitter-like table
 * @param {{events?: string[]}} options
 * @param {(record: object) => void} emit
 * @returns {{close: Function}}
 */
function createStateFeed(peerTable, options, emit) {
  const events = options && options.events && options.events.length ? options.events : DEFAULT_EVENTS;
  const listeners = [];
  for (const event of events) {
    const listener = (payload) => emit(recordFor(event, payload || {}));
    peerTable.on(event, listener);
    listeners.push({ event, listener });
  }
  return {
    close() {
      for (const { event, listener } of listeners) {
        peerTable.off(event, listener);
      }
    },
  };
}

/**
 * @param {string} event
 * @param {object} payload
 * @returns {object}
 */
function recordFor(event, payload) {
  const kind = event === 'statustext' ? 'statustext' : 'transition';
  return {
    kind,
    event,
    sysid: payload.sysid,
    compid: payload.compid,
    text: payload.text,
    severity: payload.severity,
    endpoint: payload.endpoint,
    component: payload.component,
    at: Date.now(),
  };
}

module.exports = {
  DEFAULT_EVENTS,
  snapshotPeers,
  createStateFeed,
};
