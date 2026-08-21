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
 * ignored (the step timeout then retries the request). Item requests prefer
 * `MISSION_REQUEST_INT`, with a one-shot fallback to the legacy
 * `MISSION_REQUEST` for pre-INT autopilots (see {@link MissionDownload#_onStepExhausted}).
 * An error `MISSION_ACK` from the vehicle ends the download at any phase,
 * carrying its result code — the same rule as upload (§14).
 */

const { MissionTransfer } = require('./transfer');
const {
  buildRequestList,
  buildRequestInt,
  buildRequest,
  buildAck,
  isGlobalFrame,
} = require('./items');
const { DEG_E7 } = require('../command/carrier');
const { missionResultName, MAV_MISSION_RESULT } = require('./types');

class MissionDownload extends MissionTransfer {
  _begin() {
    /** @type {object[]} received items, sparse until complete */
    this._items = [];
    /** @type {number|null} declared item count, null until MISSION_COUNT */
    this._count = null;
    /** @type {number} sequence we are currently requesting */
    this._expectedSeq = 0;
    /** @type {boolean} request carrier; flips to legacy once, then sticks */
    this._useInt = true;

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
        this._onAck(Number(f.type));
        return;
      default: break; // This space intentionally left blank (§5)
    }
  }

  /**
   * Vehicle-sent `MISSION_ACK`. An error ack ends the download at any phase,
   * carrying the vehicle's result code — same rule as upload (§9, §14 "An
   * early error MISSION_ACK is the rejection"): before the count it is the
   * refusal of `MISSION_REQUEST_LIST` (e.g. UNSUPPORTED for a fence type the
   * stack does not carry), and mid-walk a `DENIED`/`ERROR`/`NO_SPACE` is the
   * vehicle abandoning the transfer — gating it on phase turned that into an
   * opaque step-timeout with the reason code discarded. Stale-ack protection
   * is the `mission_type` filter and the subscription lifetime, not a phase
   * gate.
   *
   * Two codes are not terminal:
   *   - `INVALID_SEQUENCE` is dropped — ArduPilot emits it mid-transfer for a
   *     duplicated request while keeping the transfer alive (same exemption
   *     as upload); the step timer drives recovery.
   *   - `ACCEPTED` is ignored. Upload fails a premature ACCEPTED because it
   *     is that transfer's success signal arriving impossibly early; in a
   *     download the closing ack is the one *we* send, a vehicle ACCEPTED is
   *     never this transfer's answer, so it cannot fake a success — only
   *     abort a healthy walk if treated as terminal.
   *
   * @param {number} type  a `MAV_MISSION_RESULT`
   */
  _onAck(type) {
    if (type === MAV_MISSION_RESULT.ACCEPTED) return;
    if (type === MAV_MISSION_RESULT.INVALID_SEQUENCE) return;
    this._settle({
      result: 'failed',
      phase: 'ack',
      resultCode: type,
      reason: `vehicle rejected download: ${missionResultName(type)}`,
    });
  }

  /** @param {object} f  MISSION_COUNT fields */
  _onCount(f) {
    // Only the first count opens the item walk. A MISSION_COUNT arriving
    // mid-walk is a retransmission (the vehicle resends it for every
    // duplicated MISSION_REQUEST_LIST, and ArduPilot also emits one alongside
    // an INVALID_SEQUENCE ack) — restarting from it would discard progress,
    // reset the retry ceiling (a livelock under sustained duplication), and,
    // for a smaller stale count, truncate the mission while keeping stale
    // high-index items. Ignore it and let the in-flight item step's timer
    // drive recovery — QGC's shape; MAVSDK restarts here and duplicates items.
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
    const build = this._useInt ? buildRequestInt : buildRequest;
    // The carrier is part of the label so the INT→legacy fallback at item 0 is
    // a *distinct* step: the fallback counts as progress and starts on a fresh
    // no-progress deadline rather than inheriting what the INT attempts spent.
    this._step(
      `item ${seq}${this._useInt ? '' : ' legacy'}`,
      build(this._target, seq, this._missionType)
    );
  }

  /**
   * A pre-INT autopilot answers `MISSION_REQUEST_LIST` with a count but
   * ignores `MISSION_REQUEST_INT` entirely, so the INT-only walk stalls at
   * item 0 with zero items received. When exactly that step exhausts its
   * retries, fall back to the legacy `MISSION_REQUEST` once and stick with it
   * for the rest of the walk. Any later stall — including the fallback step
   * itself — aborts normally: a vehicle that already answered an INT request
   * speaks INT, and its silence means something else.
   */
  _onStepExhausted() {
    if (this._useInt && this._count !== null && this._expectedSeq === 0) {
      this._useInt = false;
      this._onProgress({ phase: 'fallback', seq: 0, missionType: this._missionType });
      this._requestItem(0);
      return;
    }
    super._onStepExhausted();
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
  if (intForm && isGlobalFrame(f.frame)) {
    item.x = Number(f.x) / DEG_E7;
    item.y = Number(f.y) / DEG_E7;
  }
  return item;
}

module.exports = { MissionDownload };
