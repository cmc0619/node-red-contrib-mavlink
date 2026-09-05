'use strict';

/**
 * Mission upload state machine (DESIGN.md §9 "Upload").
 *
 *   MISSION_COUNT → the vehicle requests items by sequence → send each →
 *   MISSION_ACK
 *
 * **The vehicle chooses the order** and may re-request an item it already
 * received; the machine answers whatever sequence it asks for rather than
 * assuming a walk from zero. It answers in the format requested — a
 * `MISSION_REQUEST_INT` is satisfied with `MISSION_ITEM_INT`, a legacy
 * `MISSION_REQUEST` with `MISSION_ITEM` — never the other form (§9).
 *
 * **A failed upload fails.** A non-zero `MISSION_ACK`, or a request for an item
 * outside the declared range, ends the transfer as a failure. It never sends a
 * `MISSION_CLEAR_ALL`: a vehicle left with a partial mission is recoverable,
 * one silently emptied is not (§9 "A failed upload fails").
 */

const { MissionTransfer } = require('./transfer');
const { buildCount, buildItem, buildItemInt } = require('./items');
const { MAV_MISSION_RESULT } = require('./types');

class MissionUpload extends MissionTransfer {
  /**
   * @param {object} opts  see {@link MissionTransfer}
   * @param {object[]} opts.items  canonical items to upload, index = sequence
   */
  constructor(opts) {
    super(opts);
    this._items = opts.items;
    /** @type {number} sequence last answered, for the abort record */
    this._lastSeq = -1;
    /** @type {Set<number>} distinct sequences answered, for the ack phase gate */
    this._answered = new Set();
  }

  _begin() {
    this._count = this._items.length;
    this._onProgress({ phase: 'count', count: this._count, missionType: this._missionType });
    // Declaring the count opens the transfer. If the vehicle never requests an
    // item (or acks an empty upload), the step timeout resends the count.
    this._step('count', buildCount(this._target, this._count, this._missionType));
  }

  /** @returns {number|undefined} */
  _stalledSeq() {
    return this._lastSeq >= 0 ? this._lastSeq : undefined;
  }

  /** @returns {string[]} the names `_onMessage` handles (subscription filter) */
  _messages() {
    return ['MISSION_REQUEST_INT', 'MISSION_REQUEST', 'MISSION_ACK'];
  }

  /** @param {{name: string, fields: object}} decoded */
  _onMessage(decoded) {
    const f = decoded.fields;
    if (!this._typeMatches(f)) return;

    switch (decoded.name) {
      case 'MISSION_REQUEST_INT':
        this._answer(Number(f.seq), true);
        return;
      case 'MISSION_REQUEST':
        this._answer(Number(f.seq), false);
        return;
      case 'MISSION_ACK':
        this._onAck(Number(f.type));
        return;
      default: break; // This space intentionally left blank (§5)
    }
  }

  /**
   * Answer a request for `seq` in the carrier form the vehicle asked for.
   *
   * @param {number} seq
   * @param {boolean} intForm  true for MISSION_REQUEST_INT → MISSION_ITEM_INT
   */
  _answer(seq, intForm) {
    this._lastSeq = seq;
    const item = this._items[seq];
    if (item === undefined) {
      // The vehicle asked for a sequence we never declared — the transfer
      // cannot complete. Fail; never clear.
      this._abort(`vehicle requested item ${seq} outside declared count ${this._count}`, seq);
      return;
    }

    // Progress is a sequence never answered before (the frontier), not a
    // distinct label: a vehicle alternating re-requests for two old items
    // changes the label every time and would re-arm the deadline forever.
    const frontier = !this._answered.has(seq);
    this._answered.add(seq);
    this._onProgress({
      phase: 'item',
      seq,
      count: this._count,
      format: intForm ? 'int' : 'float',
      missionType: this._missionType,
    });

    const message = intForm
      ? buildItemInt(item, this._target, seq, this._missionType)
      : buildItem(item, this._target, seq, this._missionType);
    // Treat the answer as a step: if the vehicle neither re-requests nor acks,
    // resend this item up to the ceiling, then abort naming the sequence (§9).
    this._step(`item ${seq}`, message, frontier);
  }

  /**
   * True once the upload has delivered everything the vehicle should ack: an
   * empty upload (count 0), or every declared sequence answered at least once.
   * The vehicle chooses the request order and may re-request, so this counts
   * distinct answered sequences rather than assuming the last one was
   * `count - 1` (§9 "The vehicle chooses the order").
   *
   * @returns {boolean}
   */
  _expectingAck() {
    return this._count === 0 || this._answered.size >= this._count;
  }

  /**
   * Terminal `MISSION_ACK` from the vehicle.
   *
   * An error ack fails the upload immediately, at any phase. A vehicle's only
   * channel for "count too big", "can't allocate", or "another GCS is
   * mid-upload" is an error MISSION_ACK sent right after MISSION_COUNT,
   * before any item request (ArduPilot MissionItemProtocol emits NO_SPACE /
   * ERROR / DENIED exactly there) — gating errors on delivery progress makes
   * the most common rejection a silent multi-retry stall that ends with the
   * vehicle's reason code discarded. MAVSDK and QGC both fail unconditionally
   * on any error code, and stale-ack protection comes from the mission_type
   * filter plus subscription lifetime, not from a phase gate.
   *
   * Two deliberate exceptions:
   *   - `INVALID_SEQUENCE` is dropped. ArduPilot emits it mid-transfer for a
   *     duplicated/reordered item on a lossy link while keeping the transfer
   *     alive on its side; treating it as terminal would abort healthy
   *     uploads. (QGC carries the same exemption.) A genuinely wedged
   *     transfer still fails via the step-retry ceiling.
   *   - A premature ACCEPTED — before every declared item was requested — is
   *     a protocol violation, not a success: settling `succeeded` would
   *     report a mission the vehicle cannot actually hold. It fails loudly
   *     (MAVSDK: ProtocolError; QGC: VehicleAckError), never ignored.
   *
   * @param {number} type  a `MAV_MISSION_RESULT`
   */
  _onAck(type) {
    if (type === MAV_MISSION_RESULT.ACCEPTED) {
      if (!this._expectingAck()) {
        this._settle({
          result: 'failed',
          phase: 'ack',
          reason: `vehicle accepted after ${this._answered.size} of ${this._count} items were delivered — protocol error`,
        });
        return;
      }
      this._settle({ result: 'succeeded', phase: 'done', count: this._count });
      return;
    }
    if (type === MAV_MISSION_RESULT.INVALID_SEQUENCE) return;
    this._rejected('upload', type);
  }
}

module.exports = { MissionUpload };
