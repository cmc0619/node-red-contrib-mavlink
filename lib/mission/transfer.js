'use strict';

/**
 * Base mission transfer state machine (DESIGN.md §9 "Mission protocol"). The
 * three concrete machines — {@link module:lib/mission/download},
 * {@link module:lib/mission/upload}, {@link module:lib/mission/clear} — share
 * one skeleton: subscribe to the target's `MISSION_*` replies, drive the
 * conversation on the **Bulk** band (§7), retry a stalled step up to a
 * ceiling, abort naming the stalled sequence rather than hanging forever
 * (§9 "Retry per item, with a ceiling"), and bound a transfer making no
 * progress with a deadline the per-step machinery cannot defeat — one that
 * resets only when the transfer makes progress: a distinct step by default,
 * or whatever narrower notion the subclass passes to `_step`.
 *
 * The promise, subscriptions, step timeout and retry bookkeeping are the
 * shared skeleton's (lib/delivery/transfer.js); this base adds the deadline,
 * `mission_type` matching, the addressed-to-another-GCS gate, the stalled
 * sequence on an abort, and the cancel frame.
 */

const {
  DEFAULT_TRANSFER_DEADLINE_MS,
  MAV_MISSION_RESULT,
  missionResultName,
} = require('./types');
const { buildAck } = require('./items');
const { ackAddressedTo } = require('../command/ack');
const { Transfer } = require('../delivery/transfer');

/** @typedef {{ name: string, fields: object }} DecodedMessage */

/**
 * @typedef {object} TransferOutcome
 * @property {'succeeded'|'failed'|'cancelled'} result
 * @property {string} phase      terminal phase ('done', 'ack', 'aborted', ...)
 * @property {number} missionType
 * @property {number} elapsed    ms from start to settle
 * @property {number} [count]    item count where known
 * @property {object[]} [items]  downloaded items (download only)
 * @property {number} [resultCode]  MAV_MISSION_RESULT on an error ack
 * @property {string} [reason]   human-readable failure detail
 * @property {number} [seq]      stalled sequence on an abort
 */

class MissionTransfer extends Transfer {
  /**
   * @param {object} opts  Transfer options (lib/delivery/transfer.js) plus:
   * @param {number} opts.missionType  a `MAV_MISSION_TYPE`
   * @param {{sysid: number, compid: number}} [opts.sourceIds]  our own source
   *   identity, for ack attribution (§9/§10) — a reply explicitly addressed
   *   to a *different* GCS on a shared link (MISSION_*'s own
   *   target_system/target_component fields) is ignored, the same gate
   *   {@link module:lib/command/ack.ackAddressedTo} applies to COMMAND_ACK.
   *   Omitted only by tests exercising the state machine directly; the node
   *   always resolves and passes it
   */
  constructor(opts) {
    super(opts);
    this._missionType = opts.missionType;
    this._sourceIds = opts.sourceIds;
    this._deadlineTimer = null;
  }

  /**
   * True when a message's `mission_type` matches the transfer's (§9 "The
   * `mission_type` on every message must match the one requested"). A peer
   * that omits the extension arrives as 0 — the deserializer zero-fills
   * (DESIGN.md §14.65) — so a legacy mission message matches MISSION and
   * mismatches fence/rally.
   *
   * @param {object} fields
   * @returns {boolean}
   */
  _typeMatches(fields) {
    return Number(fields.mission_type) === this._missionType;
  }

  /**
   * Source-attribution gate for an inbound reply. MISSION_* acknowledgements
   * carry target_system/target_component; MISSION_CURRENT does not, so the
   * concrete machine overrides this narrow hook rather than weakening all
   * transfers.
   *
   * @param {DecodedMessage} decoded
   * @returns {boolean}
   */
  _acceptMessage(decoded) {
    return !this._sourceIds || ackAddressedTo(decoded.fields, this._sourceIds);
  }

  /**
   * A step, plus the no-progress deadline.
   *
   * @param {string} label  used in the abort reason
   * @param {DecodedMessage} message
   * @param {boolean} [progressed]  whether this step is progress, which earns
   *   a fresh no-progress deadline. Default: a distinct label. Re-entering the
   *   same step is not progress — upload's same-seq re-request livelock
   *   re-steps forever, and that is exactly what the deadline has to bound —
   *   and a vehicle-driven machine may know better than the label: upload
   *   passes whether the sequence was ever answered before, so alternating
   *   re-requests of two old items, each a distinct label, stay bounded too.
   */
  _step(label, message, progressed = label !== this._stepLabel) {
    if (progressed) this._armDeadline();
    super._step(label, message);
  }

  /**
   * (Re)arm the no-progress deadline, the bound the per-step ceiling cannot
   * defeat: the ceiling resets on every advance, and upload's steps are driven
   * by the vehicle, so a peer re-requesting the same sequence forever resets it
   * indefinitely. Only a distinct step re-arms it, so it terminates a transfer
   * making no progress without racing a large mission over a slow link (§9).
   */
  _armDeadline() {
    if (this._deadlineTimer !== null) this._clearTimeout(this._deadlineTimer);
    this._deadlineTimer = this._setTimeout(
      () =>
        this._abort(
          `no progress at ${this._stepLabel} for ${DEFAULT_TRANSFER_DEADLINE_MS} ms (transfer deadline)`
        ),
      DEFAULT_TRANSFER_DEADLINE_MS
    );
  }

  /** Every progress update names the mission type. */
  _progress(update) {
    super._progress({ ...update, missionType: this._missionType });
  }

  /**
   * The sequence number a subclass considers stalled, for the abort record.
   * Overridden where a numeric sequence exists.
   *
   * @returns {number|undefined}
   */
  _stalledSeq() {
    return undefined;
  }

  /**
   * The vehicle answered MISSION_ACK with a rejection: settle failed on the
   * ack phase, naming the MAV_MISSION_RESULT.
   *
   * @param {string} op  upload | download | clear
   * @param {number} type  a `MAV_MISSION_RESULT`
   */
  _rejected(op, type) {
    this._settle({
      result: 'failed',
      phase: 'ack',
      resultCode: type,
      reason: `vehicle rejected ${op}: ${missionResultName(type)}`,
    });
  }

  /**
   * Abort with a failure outcome naming the stalled sequence. Subclasses
   * never turn an abort into a different operation — a failed upload must
   * not degrade into a clear (§9).
   *
   * @param {string} reason
   * @param {number} [seq]
   */
  _abort(reason, seq = this._stalledSeq()) {
    this._settle({ result: 'failed', phase: 'aborted', reason, seq });
  }

  /** @param {Partial<TransferOutcome>} outcome */
  _settle(outcome) {
    if (this._settled) return;
    if (this._deadlineTimer !== null) {
      this._clearTimeout(this._deadlineTimer);
      this._deadlineTimer = null;
    }
    super._settle({ missionType: this._missionType, ...outcome });
  }

  /**
   * Cancel a transfer in flight (node close). Notifies the wire, then resolves
   * with a cancelled outcome so the awaiting node can clean up.
   */
  cancel() {
    if (this._settled) return;
    // An operator cancel notifies the wire (§9 mission rules): a
    // MISSION_ACK with OPERATION_CANCELLED lets the vehicle exit the transfer
    // immediately instead of waiting out its own timeout. Best-effort — cancel
    // runs on teardown, the link may be gone. Internal aborts are not cancels:
    // the vehicle side already observed the failure or owns the deadline.
    try {
      this._send(buildAck(this._target, this._missionType, MAV_MISSION_RESULT.OPERATION_CANCELLED));
    } catch (_err) {
      // Swallowed: the settle below is the outcome that matters on teardown.
    }
    super.cancel();
  }
}

module.exports = { MissionTransfer };
