'use strict';

/**
 * Mission download state machine (DESIGN.md §9 "Download").
 *
 *   MISSION_REQUEST_LIST → MISSION_COUNT → request each item by sequence →
 *   MISSION_ACK
 *
 * A count of zero terminates immediately with an ack — there are no items to
 * wait for. Every reply's `mission_type` must match the requested one; a
 * vehicle answering about a different type is a mismatch, not a mission, and is
 * ignored (the step timeout then retries the request).
 */

const { MissionTransfer } = require('./transfer');
const { buildRequestList, buildRequestInt, buildAck } = require('./items');
const { missionResultName, MAV_MISSION_RESULT } = require('./types');

class MissionDownload extends MissionTransfer {
  _begin() {
    /** @type {object[]} received items, sparse until complete */
    this._items = [];
    /** @type {number|null} declared item count, null until MISSION_COUNT */
    this._count = null;
    /** @type {number} sequence we are currently requesting */
    this._expectedSeq = 0;

    this._onProgress({ phase: 'request-list', missionType: this._missionType });
    this._step('request-list', buildRequestList(this._target, this._missionType));
  }

  /** @returns {number|undefined} */
  _stalledSeq() {
    return this._count === null ? undefined : this._expectedSeq;
  }

  /** @param {{name: string, fields: object}} decoded */
  _onMessage(decoded) {
    const f = decoded.fields;
    if (!this._typeMatches(f)) return;

    switch (decoded.name) {
      case 'MISSION_COUNT':
        this._onCount(f);
        return;
      case 'MISSION_ITEM_INT':
      case 'MISSION_ITEM':
        this._onItem(f);
        return;
      case 'MISSION_ACK':
        // An unsolicited ack mid-download is the vehicle refusing the request
        // (e.g. UNSUPPORTED for a fence type it does not carry). Success acks
        // are ours to send, so a non-zero type here is a failure.
        if (Number(f.type) !== MAV_MISSION_RESULT.ACCEPTED) {
          this._settle({
            result: 'failed',
            phase: 'ack',
            resultCode: Number(f.type),
            reason: `vehicle rejected download: ${missionResultName(Number(f.type))}`,
          });
        }
        return;
      default:
        return;
    }
  }

  /** @param {object} f  MISSION_COUNT fields */
  _onCount(f) {
    this._count = Number(f.count);
    this._onProgress({ phase: 'count', count: this._count, missionType: this._missionType });

    if (this._count === 0) {
      // Nothing to fetch — ack immediately and finish (§9 "A count of zero
      // terminates immediately with an ack").
      this._send(buildAck(this._target, this._missionType));
      this._settle({ result: 'succeeded', phase: 'done', count: 0, items: [] });
      return;
    }
    this._requestItem(0);
  }

  /** @param {object} f  MISSION_ITEM(_INT) fields */
  _onItem(f) {
    if (this._count === null) return; // no count yet — not our item
    const seq = Number(f.seq);
    if (seq !== this._expectedSeq) return; // stray/duplicate; the timer retries

    this._items[seq] = { ...f };
    this._onProgress({
      phase: 'item',
      seq,
      count: this._count,
      missionType: this._missionType,
    });

    if (seq === this._count - 1) {
      this._send(buildAck(this._target, this._missionType));
      this._settle({
        result: 'succeeded',
        phase: 'done',
        count: this._count,
        items: this._items.slice(),
      });
      return;
    }
    this._requestItem(seq + 1);
  }

  /** @param {number} seq */
  _requestItem(seq) {
    this._expectedSeq = seq;
    this._step(`item ${seq}`, buildRequestInt(this._target, seq, this._missionType));
  }
}

module.exports = { MissionDownload };
