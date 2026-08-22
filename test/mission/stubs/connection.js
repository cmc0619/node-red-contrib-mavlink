'use strict';

/**
 * Fixture helpers for the mission state-machine tests (DESIGN.md §13 "Pain
 * points testable with fixtures alone"). No real sockets: a {@link StubConnection}
 * records outbound messages and, via a test-supplied `onSend` script, delivers
 * scripted inbound `MISSION_*` replies to its subscribers — the vehicle side of
 * the conversation. {@link FakeTimers} drives the retry/timeout paths
 * deterministically without wall-clock waits.
 */

/**
 * Minimal Connection surface the mission machines consume: `subscribe(filter,
 * handler) → unsubscribe` and `send(message, options)`. The stub matches the
 * real SubscriptionRegistry filter semantics (message/sysid/compid, undefined
 * matches all).
 */
class StubConnection {
  constructor() {
    this._subs = [];
    /** @type {Array<{message: object, options: object}>} */
    this.sent = [];
    this._onSend = null;
    this.id = 'stub-conn';
  }

  /**
   * @param {object|null} filter
   * @param {Function} handler
   * @returns {() => void}
   */
  subscribe(filter, handler) {
    const entry = { filter: filter || {}, handler };
    this._subs.push(entry);
    return () => {
      const i = this._subs.indexOf(entry);
      if (i >= 0) this._subs.splice(i, 1);
    };
  }

  /** @returns {number} live subscriptions, for asserting teardown */
  subscriberCount() {
    return this._subs.length;
  }

  /**
   * @param {{name: string, fields: object}} message
   * @param {object} [options]
   */
  send(message, options) {
    this.sent.push({ message, options });
    if (this._onSend) this._onSend(message, (decoded) => this.inject(decoded), options);
  }

  /**
   * Register the scripted vehicle. Called for every outbound message with
   * `(message, deliver, options)`, where `deliver(decoded)` injects an inbound
   * reply to subscribers.
   *
   * @param {(message: object, deliver: (decoded: object) => void, options: object) => void} fn
   */
  onSend(fn) {
    this._onSend = fn;
  }

  /**
   * Deliver a decoded message to matching subscribers. Defaults sysid/compid to
   * 1 so a machine subscribed to target 1/1 receives it.
   *
   * @param {object} decoded  { name, fields, [sysid], [compid] }
   * @returns {number} matching subscribers delivered to (mirrors
   *   SubscriptionRegistry.dispatch)
   */
  inject(decoded) {
    const d = { sysid: 1, compid: 1, ...decoded };
    let delivered = 0;
    for (const { filter, handler } of this._subs.slice()) {
      if (filter.message !== undefined && filter.message !== d.name) continue;
      if (filter.sysid !== undefined && filter.sysid !== d.sysid) continue;
      if (filter.compid !== undefined && filter.compid !== d.compid) continue;
      handler(d);
      delivered += 1;
    }
    return delivered;
  }

  /** @returns {string[]} names of outbound messages, in send order */
  sentNames() {
    return this.sent.map((s) => s.message.name);
  }
}

/**
 * Deterministic timer source. `setTimeout`/`clearTimeout` mirror the globals'
 * shape; {@link FakeTimers#flush} fires every pending timer in due order,
 * re-collecting timers scheduled during a callback (so retry chains complete).
 */
class FakeTimers {
  constructor() {
    this._timers = new Map();
    this._id = 1;
    this.now = 0;
  }

  setTimeout(fn, ms) {
    const id = this._id;
    this._id += 1;
    this._timers.set(id, { fn, at: this.now + ms });
    return id;
  }

  clearTimeout(id) {
    this._timers.delete(id);
  }

  /**
   * Advance to and fire pending timers until none remain (or a safety cap is
   * hit), advancing `now` to each timer's scheduled time.
   *
   * @param {number} [maxSteps]
   */
  flush(maxSteps = 1000) {
    let steps = 0;
    while (this._timers.size && steps < maxSteps) {
      const next = Math.min(...[...this._timers.values()].map((t) => t.at));
      this.now = next;
      for (const [id, t] of [...this._timers.entries()]) {
        if (t.at <= this.now && this._timers.has(id)) {
          this._timers.delete(id);
          t.fn();
        }
      }
      steps += 1;
    }
  }

  /** @returns {number} number of pending timers */
  pending() {
    return this._timers.size;
  }
}

/**
 * Deps that route a machine's timers through a {@link FakeTimers} instance.
 *
 * @param {FakeTimers} clock
 * @returns {{setTimeout: Function, clearTimeout: Function, now: () => number}}
 */
function fakeDeps(clock) {
  return {
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeout: (id) => clock.clearTimeout(id),
    now: () => clock.now,
  };
}

module.exports = { StubConnection, FakeTimers, fakeDeps };
