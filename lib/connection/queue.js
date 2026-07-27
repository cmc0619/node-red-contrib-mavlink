'use strict';

/**
 * The outbound queue (DESIGN.md §7 "Queue bands" and "Scheduling is the
 * driver's"). Depth is held here, in the driver, not in the OS socket buffer:
 * the socket buffer is FIFO with no notion of priority, so writing everything
 * into it defeats the band scheme at the kernel boundary. The driver keeps the
 * socket buffer shallow and calls {@link OutboundQueue#dequeue} one message at
 * a time, waiting for the transport to accept each before dequeuing the next.
 *
 * Every message carries a band. Priority is not importance — it is what happens
 * if the message is late (§7). The five bands and their handling:
 *
 *   0 Emergency  never coalesced, never dropped, never delayed; overflow is a
 *                fault, not a drop.
 *   1 Liveness   at most one outstanding per identity; enqueuing a second for
 *                the same identity replaces the first (never queue two).
 *   2 Control    ordered, not coalesced; overflow raises rather than silently
 *                discarding a user-initiated action.
 *   3 Streaming  coalesced per (message, target, identity); last value wins;
 *                overflow drops the oldest (free — the newest supersedes it).
 *   4 Bulk       latency-tolerant; overflow rejects the newest with an error;
 *                must not starve anything above.
 *
 * Ageing promotes a waiting item toward Control and no further, so a long bulk
 * transfer makes progress instead of starving, without ever preempting a
 * heartbeat or an emergency stop.
 */

const {
  BAND,
  BAND_NAME,
  DSCP,
  AGE_CLAMP_BAND,
  DEFAULT_CAPACITY,
  AGE_STEP_MS,
  isBand,
} = require('./bands');

/**
 * Thrown when a bounded band overflows in a way the spec says must be loud:
 * Control (a user action would be silently lost), Bulk (the newest is rejected),
 * or Emergency (a fault condition). Streaming overflow never throws — it drops
 * the oldest, which is free.
 */
class QueueOverflowError extends Error {
  /**
   * @param {number} band  the overflowing band
   * @param {string} detail  what was attempted
   */
  constructor(band, detail) {
    super(`outbound queue overflow on band ${band} (${BAND_NAME[band]}): ${detail}`);
    this.name = 'QueueOverflowError';
    this.band = band;
    this.bandName = BAND_NAME[band];
  }
}

/**
 * @typedef {object} EnqueueRequest
 * @property {number} band  0..4
 * @property {*} message  opaque payload handed back verbatim on dequeue
 * @property {string} identityId  the local identity this send belongs to;
 *   always part of the Liveness and Streaming keys so two identities sharing a
 *   connection never collapse into each other's traffic (§7)
 * @property {string} [target]  destination key (e.g. `sysid.compid`); part of
 *   the Streaming coalescing key
 * @property {string} [coalesceKey]  explicit Streaming coalescing key; derived
 *   from identity, message name and target when omitted
 */

/**
 * @typedef {object} QueueItem
 * @property {number} band  the band the item was enqueued on (its DSCP class)
 * @property {*} message
 * @property {string} identityId
 * @property {string|undefined} target
 * @property {number} enqueuedAt  clock value at enqueue, for ageing and tie-break
 * @property {number} seq  monotonic insertion counter, the stable tie-breaker
 * @property {number} dscp  DSCP mark for the item's band
 */

class OutboundQueue {
  /**
   * @param {object} [options]
   * @param {() => number} [options.now]  clock source (ms); injectable for tests
   * @param {Object<number, number>} [options.capacities]  per-band depth caps
   * @param {number} [options.ageStepMs]  ms per one-band age promotion
   */
  constructor(options = {}) {
    this._now = options.now || Date.now;
    this._ageStepMs = options.ageStepMs || AGE_STEP_MS;
    this._capacity = { ...DEFAULT_CAPACITY, ...(options.capacities || {}) };
    /** @type {QueueItem[]} */
    this._items = [];
    this._counts = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };
    /** @type {Map<string, QueueItem>} Streaming coalescing index. */
    this._coalesce = new Map();
    /** @type {Map<string, QueueItem>} Liveness index, keyed by identity. */
    this._liveness = new Map();
    this._seq = 0;
  }

  /**
   * @param {EnqueueRequest} request
   * @returns {QueueItem} the accepted item
   * @throws {QueueOverflowError} on Control, Bulk or Emergency overflow
   */
  enqueue(request) {
    const { band, message, identityId } = request;
    if (!isBand(band)) throw new Error(`invalid band ${band}`);

    const item = {
      band,
      message,
      identityId,
      target: request.target,
      enqueuedAt: this._now(),
      seq: this._seq,
      dscp: DSCP[band],
    };
    this._seq += 1;

    if (band === BAND.LIVENESS) return this._enqueueLiveness(item);
    if (band === BAND.STREAMING) return this._enqueueStreaming(item, request.coalesceKey);
    if (band === BAND.EMERGENCY) return this._enqueueBounded(item, 'emergency stop dropped');
    if (band === BAND.CONTROL) return this._enqueueBounded(item, 'control action dropped');
    return this._enqueueBulk(item);
  }

  /**
   * Liveness holds at most one outstanding heartbeat per identity: enqueuing a
   * second for the same identity replaces the first rather than queueing two.
   *
   * @param {QueueItem} item
   * @returns {QueueItem}
   */
  _enqueueLiveness(item) {
    const existing = this._liveness.get(item.identityId);
    if (existing) this._remove(existing);
    this._liveness.set(item.identityId, item);
    this._push(item);
    return item;
  }

  /**
   * Streaming coalesces per (identity, message, target): the newest value wins
   * and the stale one is dropped rather than sent late. On overflow the oldest
   * streaming item is dropped, which is free.
   *
   * @param {QueueItem} item
   * @param {string} [explicitKey]
   * @returns {QueueItem}
   */
  _enqueueStreaming(item, explicitKey) {
    const key = explicitKey || streamingKey(item);
    item.coalesceKey = key;
    const existing = this._coalesce.get(key);
    if (existing) {
      this._remove(existing);
    } else if (this._counts[BAND.STREAMING] >= this._capacity[BAND.STREAMING]) {
      this._remove(this._oldestOfBand(BAND.STREAMING));
    }
    this._coalesce.set(key, item);
    this._push(item);
    return item;
  }

  /**
   * Emergency and Control are ordered and never coalesced; overflow is loud.
   *
   * @param {QueueItem} item
   * @param {string} detail
   * @returns {QueueItem}
   */
  _enqueueBounded(item, detail) {
    if (this._counts[item.band] >= this._capacity[item.band]) {
      throw new QueueOverflowError(item.band, detail);
    }
    this._push(item);
    return item;
  }

  /**
   * Bulk rejects the newest with an error on overflow so it never starves the
   * bands above by growing without bound.
   *
   * @param {QueueItem} item
   * @returns {QueueItem}
   */
  _enqueueBulk(item) {
    if (this._counts[BAND.BULK] >= this._capacity[BAND.BULK]) {
      throw new QueueOverflowError(BAND.BULK, 'bulk transfer rejected (queue full)');
    }
    this._push(item);
    return item;
  }

  /**
   * Remove and return the highest-priority item, applying ageing: the effective
   * band of a waiting item rises toward Control with age, and ties break by
   * insertion order (oldest first). Returns null when empty.
   *
   * @param {number} [now]
   * @returns {QueueItem|null}
   */
  dequeue(now = this._now()) {
    if (this._items.length === 0) return null;
    let best = null;
    let bestBand = Infinity;
    for (const item of this._items) {
      const effective = this._effectiveBand(item, now);
      if (effective < bestBand || (effective === bestBand && item.seq < best.seq)) {
        best = item;
        bestBand = effective;
      }
    }
    this._remove(best);
    return best;
  }

  /**
   * Peek at the item {@link OutboundQueue#dequeue} would return, without
   * removing it.
   *
   * @param {number} [now]
   * @returns {QueueItem|null}
   */
  peek(now = this._now()) {
    if (this._items.length === 0) return null;
    let best = null;
    let bestBand = Infinity;
    for (const item of this._items) {
      const effective = this._effectiveBand(item, now);
      if (effective < bestBand || (effective === bestBand && item.seq < best.seq)) {
        best = item;
        bestBand = effective;
      }
    }
    return best;
  }

  /**
   * The band an item competes at after ageing. Emergency, Liveness and Control
   * never age (they are already at or above the clamp); Streaming and Bulk rise
   * one band per {@link ageStepMs}, clamped at Control so they can never reach
   * Liveness or Emergency.
   *
   * @param {QueueItem} item
   * @param {number} now
   * @returns {number}
   */
  _effectiveBand(item, now) {
    if (item.band <= AGE_CLAMP_BAND) return item.band;
    const steps = Math.floor((now - item.enqueuedAt) / this._ageStepMs);
    const promoted = item.band - steps;
    return promoted < AGE_CLAMP_BAND ? AGE_CLAMP_BAND : promoted;
  }

  /**
   * @param {number} band
   * @returns {QueueItem} the oldest item currently on `band`
   */
  _oldestOfBand(band) {
    let oldest = null;
    for (const item of this._items) {
      if (item.band === band && (oldest === null || item.seq < oldest.seq)) oldest = item;
    }
    return oldest;
  }

  /** @param {QueueItem} item */
  _push(item) {
    this._items.push(item);
    this._counts[item.band] += 1;
  }

  /** @param {QueueItem} item */
  _remove(item) {
    const index = this._items.indexOf(item);
    if (index === -1) return;
    this._items.splice(index, 1);
    this._counts[item.band] -= 1;
    if (item.band === BAND.STREAMING && this._coalesce.get(item.coalesceKey) === item) {
      this._coalesce.delete(item.coalesceKey);
    }
    if (item.band === BAND.LIVENESS && this._liveness.get(item.identityId) === item) {
      this._liveness.delete(item.identityId);
    }
  }

  /** @returns {number} total items queued across all bands */
  size() {
    return this._items.length;
  }

  /**
   * @param {number} band
   * @returns {number} items currently queued on `band`
   */
  sizeOf(band) {
    return this._counts[band];
  }

  /** @returns {boolean} */
  isEmpty() {
    return this._items.length === 0;
  }

  /** Discard everything queued (teardown). */
  clear() {
    this._items = [];
    this._counts = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };
    this._coalesce.clear();
    this._liveness.clear();
  }
}

/**
 * Streaming coalescing key. Always includes the identity so two identities
 * sharing a connection never collapse into each other's setpoint stream (§7).
 *
 * @param {QueueItem} item
 * @returns {string}
 */
function streamingKey(item) {
  const name = message2name(item.message);
  return `${item.identityId}\u0000${name}\u0000${item.target || ''}`;
}

/**
 * @param {*} message
 * @returns {string} the message's name, for keying; '' when it carries none
 */
function message2name(message) {
  if (message && typeof message === 'object' && typeof message.name === 'string') {
    return message.name;
  }
  return '';
}

module.exports = { OutboundQueue, QueueOverflowError };
