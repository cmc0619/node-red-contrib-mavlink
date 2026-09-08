'use strict';

/**
 * MAVLink mission current-selection state machine (DESIGN.md §9 "Set current").
 *
 *   MISSION_SET_CURRENT → MISSION_CURRENT
 *
 * The request is target-addressed, while the response is an addressless
 * broadcast status. A matching source is supplied by MissionTransfer's
 * subscription filter and the echoed core sequence is the only response
 * correlation available. There is no COMMAND_ACK or MISSION_ACK in this
 * exchange.
 */

const { MissionTransfer } = require('./transfer');
const { buildSetCurrent } = require('./items');

class MissionSetCurrent extends MissionTransfer {
  constructor(opts) {
    super(opts);
    this._seq = opts.seq;
  }

  _begin() {
    this._onProgress({ phase: 'set-current', seq: this._seq, missionType: this._missionType });
    this._step('set-current', buildSetCurrent(this._target, this._seq));
  }

  /** @returns {number|undefined} */
  _stalledSeq() {
    return this._seq;
  }

  /** @returns {string[]} the names `_onMessage` handles */
  _messages() {
    return ['MISSION_CURRENT'];
  }

  /**
   * `MISSION_CURRENT` has no target_system/target_component fields. The
   * subscription opened by MissionTransfer still filters the response source
   * to the request target; only the explicit-address attribution gate is
   * bypassed for this addressless status frame.
   */
  _acceptMessage(_decoded) {
    return true;
  }

  /** @param {{name: string, fields: object}} decoded */
  _onMessage(decoded) {
    if (Number(decoded.fields.seq) !== Number(this._seq)) return;
    this._settle({ result: 'succeeded', phase: 'done', seq: this._seq });
  }

  /**
   * Set-current has no MISSION_ACK cancel message. Reuse MissionTransfer's
   * teardown/settle path without sending the transfer cancel frame used by
   * item-transfer machines.
   */
  cancel() {
    if (this._settled) return;
    this._settle({ result: 'cancelled', phase: 'cancelled', reason: 'transfer cancelled' });
  }
}

module.exports = { MissionSetCurrent };
