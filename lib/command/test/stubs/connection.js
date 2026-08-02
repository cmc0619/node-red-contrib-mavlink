'use strict';

/**
 * Minimal peer-table stub for lib/command completion tests.
 */

const { EventEmitter } = require('node:events');

/**
 * Minimal peer-table stub.  `_peers` is a plain Map so completion.js can
 * access it directly (the same way the production code does).
 */
class StubPeerTable extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<number, {sysid: number, components: Map<number, object>}>} */
    this._peers = new Map();
  }

  /**
   * Inject a fake component so completion checks have data to read.
   *
   * @param {number} sysid
   * @param {number} compid
   * @param {object} fields  component fields (armed, flightMode, position, etc.)
   */
  setComponent(sysid, compid, fields) {
    if (!this._peers.has(sysid)) {
      this._peers.set(sysid, { sysid, components: new Map() });
    }
    const existing = this._peers.get(sysid).components.get(compid) || { compid };
    this._peers.get(sysid).components.set(compid, { ...existing, ...fields, compid });
  }

  snapshot() {
    const out = [];
    for (const peer of this._peers.values()) {
      const components = [];
      for (const comp of peer.components.values()) {
        components.push({ ...comp });
      }
      out.push({ sysid: peer.sysid, components });
    }
    return out;
  }
}

module.exports = { StubPeerTable };
