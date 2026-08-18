'use strict';

const { deepCopy } = require('../connection/clone');
const { modeNameFor } = require('../vehicle/modes');

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
  'armed-changed',
  'mode-changed',
  'landed-changed',
  'gps-fix-changed',
  'home-changed',
  'sensor-health-changed',
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
 * `modes` is the mode-name resolution context (`lib/vehicle/modes.js`
 * ModeContext without the component — firmware, family, bundle). When given,
 * each component whose `flightMode` the ladder resolves gains a `modeName`
 * beside the raw number; an unresolved mode simply stays a number. The live
 * component is looked up per record so the vehicle-published cache — held on
 * the table, not the snapshot — gets its first say.
 *
 * @param {import('../connection/peer-table').PeerTable} peerTable
 * @param {{sysid?: number, compid?: number}} [filter]
 * @param {{firmware?: string, vehicleFamily?: string, bundle?: object}} [modes]
 * @returns {object[]}
 */
function snapshotPeers(peerTable, filter = {}, modes) {
  const source = peerTable.snapshot();
  const sysid = filter.sysid === undefined || filter.sysid === '' ? null : Number(filter.sysid);
  const compid = filter.compid === undefined || filter.compid === '' ? null : Number(filter.compid);
  const peers = deepCopy(source)
    .filter((peer) => sysid === null || peer.sysid === sysid)
    .map((peer) => ({
      ...peer,
      components: peer.components.filter(
        (component) => compid === null || component.compid === compid
      ),
    }))
    .filter((peer) => peer.components.length > 0 || compid === null);
  if (modes) {
    for (const peer of peers) {
      for (const component of peer.components) {
        const name = modeNameFor(component.flightMode, {
          ...modes,
          component: peerTable.getComponent(peer.sysid, component.compid),
        });
        if (name !== undefined) component.modeName = name;
      }
    }
  }
  return peers;
}

/**
 * Subscribe to peer-table edge events and emit flow records for transitions and
 * the live STATUSTEXT feed. Returns a close handle for node teardown.
 *
 * With a `modes` context (see {@link snapshotPeers}), a `mode-changed` record
 * gains `fromName`/`toName` for whichever side the mode-name ladder resolves;
 * the raw numbers ride unchanged either way.
 *
 * @param {object} peerTable EventEmitter-like table
 * @param {{events?: string[], modes?: object}} options
 * @param {(record: object) => void} emit
 * @returns {{close: Function}}
 */
function createStateFeed(peerTable, options, emit) {
  const events = options.events && options.events.length ? options.events : DEFAULT_EVENTS;
  const modes = options.modes;
  const listeners = [];

  /**
   * Name enrichment for the one event that carries mode numbers.
   *
   * @param {string} event
   * @param {object} payload
   * @returns {{fromName?: string, toName?: string}|undefined}
   */
  function names(event, payload) {
    switch (event) {
      case 'mode-changed': {
        if (!modes) return undefined;
        const ctx = {
          ...modes,
          component: peerTable.getComponent(payload.sysid, payload.compid),
        };
        return {
          fromName: modeNameFor(payload.from, ctx),
          toName: modeNameFor(payload.to, ctx),
        };
      }
      default: break; // This space intentionally left blank (§5)
    }
    return undefined; // nothing matched: no behavior selected (§5)
  }

  for (const event of events) {
    const listener = (payload) => emit(recordFor(event, payload, names(event, payload)));
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
 * @param {{fromName?: string, toName?: string}} [names]  resolved mode names
 *   (mode-changed only); unresolved sides stay undefined and serialize away
 * @returns {object}
 */
function recordFor(event, payload, names) {
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
    from: payload.from,
    to: payload.to,
    changed: payload.changed,
    ...names,
    at: Date.now(),
  };
}

module.exports = {
  DEFAULT_EVENTS,
  snapshotPeers,
  createStateFeed,
};
