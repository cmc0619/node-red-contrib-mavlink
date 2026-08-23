'use strict';

/**
 * Mission clear state machine (DESIGN.md §9 "Clear").
 *
 *   MISSION_CLEAR_ALL → MISSION_ACK
 *
 * This one is destructive and nothing gates it: selecting Clear in the editor
 * is the decision (§14.93). The machine erases the plan of the requested type
 * and reports the vehicle's ack. A non-zero ack is a failure reported verbatim.
 */

const { MissionTransfer } = require('./transfer');
const { buildClearAll } = require('./items');
const { missionResultName, MAV_MISSION_RESULT } = require('./types');

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
    if (decoded.name !== 'MISSION_ACK') return;
    const f = decoded.fields;
    if (!this._typeMatches(f)) return;

    const type = Number(f.type);
    if (type === MAV_MISSION_RESULT.ACCEPTED) {
      this._settle({ result: 'succeeded', phase: 'done' });
      return;
    }
    this._settle({
      result: 'failed',
      phase: 'ack',
      resultCode: type,
      reason: `vehicle rejected clear: ${missionResultName(type)}`,
    });
  }
}

module.exports = { MissionClear };
