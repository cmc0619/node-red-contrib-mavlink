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
const { buildRequestList, buildRequestInt, buildAck, isGlobalFrame, DEG_E7 } = require('./items');
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
        this._onItem(f, true);
        return;
      case 'MISSION_ITEM':
        this._onItem(f, false);
        return;
      case 'MISSION_ACK':
        // A vehicle-sent MISSION_ACK belongs to the download protocol only as
        // an early refusal of MISSION_REQUEST_LIST (e.g. UNSUPPORTED for a
        // fence type it does not carry), which arrives *before* any
        // MISSION_COUNT. Once the count is in and items are flowing, the only
        // legitimate ack is the one *we* send to close the transfer; a
        // MISSION_ACK from the vehicle then is stale (a leftover from a prior
        // transfer or a duplicate) and must not abort an in-progress download.
        // Phase-gate on the count and let the step timer drive any real stall.
        if (this._count !== null) return;
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
    // A MISSION_COUNT once the item walk has started is a retransmission of the
    // count we already hold (the vehicle answering a request-list it saw twice).
    // Re-entering would restart the walk, and a *smaller* stale count would
    // silently truncate the mission yet still report success. Phase-gate on the
    // count, exactly as the ack handler above does (§9 "Download").
    if (this._count !== null) return;

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

  /**
   * @param {object} f  MISSION_ITEM(_INT) fields
   * @param {boolean} intForm  true for a MISSION_ITEM_INT (degE7 lat/lon)
   */
  _onItem(f, intForm) {
    if (this._count === null) return; // no count yet — not our item
    const seq = Number(f.seq);
    if (seq !== this._expectedSeq) return; // stray/duplicate; the timer retries

    this._items[seq] = canonicalItem(f, intForm);
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

/**
 * Normalize a received item into a canonical item whose `x`/`y` are in the same
 * domain the upload builders expect (float degrees for a global frame, metres
 * otherwise). A `MISSION_ITEM_INT` carries global lat/lon as `degE7` integers;
 * store them back as degrees so a download → upload round-trip does not
 * double-scale (`buildItemInt` re-multiplies by 1e7). A legacy `MISSION_ITEM`
 * is already float degrees, and non-global frames carry metres in either
 * carrier, so both pass through unscaled (§9 "Coordinate frames").
 *
 * @param {object} f  received item fields
 * @param {boolean} intForm  true when the carrier was MISSION_ITEM_INT
 * @returns {object} canonical item
 */
function canonicalItem(f, intForm) {
  const item = { ...f };
  if (intForm && isGlobalFrame(f.frame === undefined ? 0 : f.frame)) {
    if (f.x !== undefined && f.x !== null) item.x = Number(f.x) / DEG_E7;
    if (f.y !== undefined && f.y !== null) item.y = Number(f.y) / DEG_E7;
  }
  return item;
}

module.exports = { MissionDownload };
