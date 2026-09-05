'use strict';

/**
 * Mission clear state machine (DESIGN.md §9 "Clear").
 *
 *   MISSION_CLEAR_ALL → MISSION_ACK
 *
 * Erases the plan of the requested type and reports the vehicle's ack. A
 * non-zero ack is a failure reported verbatim.
 */

const { MissionTransfer } = require('./transfer');
const { buildClearAll } = require('./items');
const { MAV_MISSION_RESULT } = require('./types');

class MissionClear extends MissionTransfer {
  _begin() {
    this._onProgress({ phase: 'clear', missionType: this._missionType });
    this._step('clear-all', buildClearAll(this._target, this._missionType));
  }

  /** @returns {string[]} the names `_onMessage` handles (subscription filter) */
  _messages() {
    return ['MISSION_ACK'];
  }

  /** @param {{name: string, fields: object}} decoded */
  _onMessage(decoded) {
    const f = decoded.fields;
    if (!this._typeMatches(f)) return;

    const type = Number(f.type);
    if (type === MAV_MISSION_RESULT.ACCEPTED) {
      this._settle({ result: 'succeeded', phase: 'done' });
      return;
    }
    this._rejected('clear', type);
  }
}

module.exports = { MissionClear };
