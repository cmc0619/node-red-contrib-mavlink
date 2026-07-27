'use strict';

/**
 * Subscription registry (DESIGN.md §7 "Subscriptions"). In nodes subscribe to a
 * Connection; the Connection delivers each decoded message as a **copy per
 * subscriber**, or one Function node mutating a payload corrupts what every
 * other subscriber sees. A subscription is unregistered in the subscriber's own
 * `close`, or a redeployed flow leaves the old node still receiving — so
 * {@link SubscriptionRegistry#subscribe} returns an unsubscribe handle.
 *
 * An optional filter narrows delivery by message name, sysid, and compid. This
 * is an efficiency convenience for the caller; the copy guarantee is the part
 * that is not optional.
 */

const { deepCopy } = require('./clone');

/**
 * @typedef {object} SubscriptionFilter
 * @property {string} [message]  match `decoded.name`
 * @property {number} [sysid]  match `decoded.sysid`
 * @property {number} [compid]  match `decoded.compid`
 */

/**
 * @typedef {object} DecodedMessage
 * @property {string} name
 * @property {number} sysid
 * @property {number} compid
 * @property {Object<string, *>} fields
 */

class SubscriptionRegistry {
  constructor() {
    /** @type {Map<number, {filter: SubscriptionFilter, handler: Function}>} */
    this._subs = new Map();
    this._nextId = 1;
  }

  /**
   * Register a subscriber.
   *
   * @param {SubscriptionFilter|null} filter  null / {} matches everything
   * @param {(msg: DecodedMessage) => void} handler
   * @returns {() => void} unsubscribe; idempotent
   */
  subscribe(filter, handler) {
    const id = this._nextId;
    this._nextId += 1;
    this._subs.set(id, { filter: filter || {}, handler });
    return () => {
      this._subs.delete(id);
    };
  }

  /**
   * Deliver a decoded message to every matching subscriber, each getting its
   * own deep copy.
   *
   * @param {DecodedMessage} decoded
   * @returns {number} how many subscribers received it
   */
  dispatch(decoded) {
    let delivered = 0;
    for (const { filter, handler } of this._subs.values()) {
      if (!matches(filter, decoded)) continue;
      handler(deepCopy(decoded));
      delivered += 1;
    }
    return delivered;
  }

  /** @returns {number} number of active subscriptions */
  size() {
    return this._subs.size;
  }

  /** Drop every subscription (teardown). */
  clear() {
    this._subs.clear();
  }
}

/**
 * @param {SubscriptionFilter} filter
 * @param {DecodedMessage} decoded
 * @returns {boolean}
 */
function matches(filter, decoded) {
  if (filter.message !== undefined && filter.message !== decoded.name) return false;
  if (filter.sysid !== undefined && filter.sysid !== decoded.sysid) return false;
  if (filter.compid !== undefined && filter.compid !== decoded.compid) return false;
  return true;
}

module.exports = { SubscriptionRegistry };
