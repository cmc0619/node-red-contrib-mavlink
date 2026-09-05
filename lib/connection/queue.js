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
 * @property {string} target  destination key (`sysid.compid`, '' when
 *   untargeted); part of the Streaming coalescing key
 * @property {string} [coalesceKey]  explicit Streaming coalescing key; derived
 *   from identity, message name and target when omitted
 */

/**
 * @typedef {object} QueueItem
 * @property {number} band  the band the item was enqueued on (its DSCP class)
 * @property {*} message
 * @property {string} identityId
 * @property {string} target
 * @property {number} enqueuedAt  clock value at enqueue, for ageing and tie-break
 * @property {number} seq  monotonic insertion counter, the stable tie-breaker
 * @property {number} dscp  DSCP mark for the item's band
 */

class OutboundQueue {
  /**
   * @param {object} [options]
   * @param {() => number} [options.now]  clock source (ms); injectable for tests
   * @param {Object<number, number>} [options.capacities]  per-band depth caps (tests)
   * @param {number} [options.ageStepMs]  ms per one-band age promotion (tests)
   */
  constructor(options = {}) {
    this._now = options.now || Date.now;
    this._ageStepMs = options.ageStepMs || AGE_STEP_MS;
    this._capacity = { ...DEFAULT_CAPACITY, ...(options.capacities || {}) };
    /**
     * Storage is one FIFO per band, so dequeue compares only the band heads:
     * within a band the head has the earliest enqueuedAt (ageing cannot lift a
     * later item past it) and the lowest seq (it wins the tie-break), so no
     * other item in the band can ever win selection. Emergency, Control and
     * Bulk never lose an item except from the head, so they are plain arrays
     * behind a head cursor.
     *
     * @type {Object<number, {items: QueueItem[], head: number}>}
     */
    this._fifos = {
      [BAND.EMERGENCY]: { items: [], head: 0 },
      [BAND.CONTROL]: { items: [], head: 0 },
      [BAND.BULK]: { items: [], head: 0 },
    };
    this._counts = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };
    /**
     * Streaming coalescing index — and the Streaming band's FIFO: the band
     * only ever loses a mid-queue item to replacement, which mutates the
     * existing slot in place, so the Map's insertion order is the order each
     * key first arrived and its first entry is the band's oldest. A slot
     * keeps its original `enqueuedAt` and `seq` across replacements, so
     * ageing and `_bestItem`'s head-only comparison stay consistent with
     * that order: no non-head slot can be older (earlier first arrival) or
     * win the seq tie-break.
     *
     * @type {Map<string, QueueItem>}
     */
    this._coalesce = new Map();
    /**
     * Liveness index, keyed by identity — the Liveness band's FIFO, by the
     * same argument as {@link OutboundQueue#_coalesce}.
     *
     * @type {Map<string, QueueItem>}
     */
    this._liveness = new Map();
    this._seq = 0;
  }

  /**
   * @param {EnqueueRequest} request
   * @returns {QueueItem|undefined} the accepted item; an unrecognised band
   *   returns undefined and enqueues nothing (§5)
   * @throws {QueueOverflowError} on Control, Bulk or Emergency overflow
   */
  enqueue(request) {
    const { band, message, identityId } = request;
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

    switch (band) {
      case BAND.LIVENESS: return this._enqueueLiveness(item);
      case BAND.STREAMING: return this._enqueueStreaming(item, request.coalesceKey);
      case BAND.EMERGENCY: return this._enqueueBounded(item, 'emergency stop dropped');
      case BAND.CONTROL: return this._enqueueBounded(item, 'control action dropped');
      case BAND.BULK: return this._enqueueBulk(item);
      default: break; // This space intentionally left blank (§5)
    }
    return undefined; // nothing matched: no behavior selected (§5)
  }

  /**
   * Liveness holds at most one outstanding heartbeat per identity: enqueuing a
   * second for the same identity replaces the first rather than queueing two.
   *
   * @param {QueueItem} item
   * @returns {QueueItem}
   */
  _enqueueLiveness(item) {
    // delete-then-set, never a bare set: the replacement carries a fresh seq
    // and must move to the band tail, and Map.set on an existing key would
    // keep the old position.
    if (this._liveness.delete(item.identityId)) this._counts[BAND.LIVENESS] -= 1;
    this._liveness.set(item.identityId, item);
    this._counts[BAND.LIVENESS] += 1;
    return item;
  }

  /**
   * Streaming coalesces per (identity, message, target): the newest value wins
   * and the stale one is dropped rather than sent late. The replacement
   * mutates the queued slot in place, inheriting its `enqueuedAt` and Map
   * position — otherwise a producer outrunning the link would re-enqueue at
   * the tail on every tick, resetting its own age and seq so the slot never
   * promotes and never drops as the oldest on overflow. On overflow the
   * oldest streaming item is dropped, which is free.
   *
   * @param {QueueItem} item
   * @param {string} [explicitKey]
   * @returns {QueueItem}
   */
  _enqueueStreaming(item, explicitKey) {
    const key = explicitKey || streamingKey(item);
    const existing = this._coalesce.get(key);
    if (existing) {
      existing.message = item.message;
      return existing;
    }
    item.coalesceKey = key;
    if (this._counts[BAND.STREAMING] >= this._capacity[BAND.STREAMING]) {
      // The Map's first entry is the band's oldest (insertion order = first
      // arrival per key — a replacement keeps its slot).
      this._coalesce.delete(this._coalesce.keys().next().value);
      this._counts[BAND.STREAMING] -= 1;
    }
    this._coalesce.set(key, item);
    this._counts[BAND.STREAMING] += 1;
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
   * @returns {QueueItem|null}
   */
  dequeue() {
    const best = this._bestItem(this._now());
    if (best) this._removeHead(best);
    return best;
  }

  /**
   * Find the item that currently wins priority and age ordering. Only the five
   * band heads compete: no non-head item can beat its own band's head (see the
   * `_fifos` invariant), so the global winner is always among the heads.
   *
   * @param {number} now
   * @returns {QueueItem|null}
   */
  _bestItem(now) {
    let best = null;
    let bestBand = Infinity;
    for (let band = BAND.EMERGENCY; band <= BAND.BULK; band += 1) {
      const item = this._bandHead(band);
      if (!item) continue;
      const effective = this._effectiveBand(item, now);
      if (effective < bestBand || (effective === bestBand && item.seq < best.seq)) {
        best = item;
        bestBand = effective;
      }
    }
    return best;
  }

  /**
   * @param {number} band
   * @returns {QueueItem|null|undefined} the oldest item currently on `band`
   */
  _bandHead(band) {
    if (band === BAND.LIVENESS) return this._liveness.values().next().value;
    if (band === BAND.STREAMING) return this._coalesce.values().next().value;
    const fifo = this._fifos[band];
    return fifo.head < fifo.items.length ? fifo.items[fifo.head] : null;
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

  /** @param {QueueItem} item  pushed onto its band's array FIFO (bands 0/2/4) */
  _push(item) {
    this._fifos[item.band].items.push(item);
    this._counts[item.band] += 1;
  }

  /** @param {QueueItem} item  the head of its band, as chosen by `_bestItem` */
  _removeHead(item) {
    if (item.band === BAND.LIVENESS) {
      this._liveness.delete(item.identityId);
    } else if (item.band === BAND.STREAMING) {
      this._coalesce.delete(item.coalesceKey);
    } else {
      const fifo = this._fifos[item.band];
      fifo.head += 1;
      if (fifo.head * 2 >= fifo.items.length) {
        // Amortised O(1): the copy is no longer than the pops since the last
        // compaction, and without it the array would grow without bound.
        fifo.items = fifo.items.slice(fifo.head);
        fifo.head = 0;
      }
    }
    this._counts[item.band] -= 1;
  }

  /** Discard everything queued (teardown). */
  clear() {
    for (const band of [BAND.EMERGENCY, BAND.CONTROL, BAND.BULK]) {
      this._fifos[band] = { items: [], head: 0 };
    }
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
  return `${item.identityId}\u0000${item.message.name}\u0000${item.target}`;
}

module.exports = { OutboundQueue, QueueOverflowError };
