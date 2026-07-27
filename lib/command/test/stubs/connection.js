'use strict';

/**
 * Minimal connection stub for lib/command tests (brief §12.6: "if lib/delivery
 * missing, stub minimal status-record helpers under lib/command/test/stubs/
 * only — do not write lib/delivery").
 *
 * Provides the same surface the mavlink-command node reaches on connNode:
 *   subscribe(filter, handler) → unsubscribe handle
 *   send(message, options) → void
 *   peerTable  — minimal peer-table stub with snapshot() and _peers
 *
 * Tests that exercise AckWaiter / completion can inject these stubs instead
 * of needing a live Connection runtime.
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

/**
 * Minimal connection stub.
 *
 * Delivered COMMAND_ACK messages are injected via `stub.injectAck(fields)`.
 */
class StubConnection {
  constructor() {
    this._handlers = [];
    this.peerTable = new StubPeerTable();
    this.sent = [];
  }

  /**
   * @param {object|null} filter
   * @param {Function} handler
   * @returns {() => void}
   */
  subscribe(filter, handler) {
    const entry = { filter, handler };
    this._handlers.push(entry);
    return () => {
      const idx = this._handlers.indexOf(entry);
      if (idx >= 0) this._handlers.splice(idx, 1);
    };
  }

  /**
   * @param {{name: string, fields: object}} message
   * @param {object} [_options]
   */
  send(message, _options) {
    this.sent.push(message);
  }

  /**
   * Deliver a COMMAND_ACK to all subscribers whose filter matches.
   *
   * @param {object} fields  e.g. { command: 400, result: 0 }
   */
  injectAck(fields) {
    const decoded = {
      name: 'COMMAND_ACK',
      sysid: 1,
      compid: 1,
      fields,
    };
    for (const { filter, handler } of this._handlers) {
      if (!filter || !filter.message || filter.message === decoded.name) {
        handler(decoded);
      }
    }
  }

  /** Deliver any decoded message to subscribers. */
  injectMessage(decoded) {
    for (const { filter, handler } of this._handlers) {
      const nameMatch = !filter || !filter.message || filter.message === decoded.name;
      const sysidMatch = !filter || !filter.sysid || filter.sysid === decoded.sysid;
      const compidMatch = !filter || !filter.compid || filter.compid === decoded.compid;
      if (nameMatch && sysidMatch && compidMatch) handler(decoded);
    }
  }
}

module.exports = { StubConnection, StubPeerTable };
