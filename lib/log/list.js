'use strict';

const { LogTransfer } = require('./transfer');
const { buildRequestList } = require('./items');

/**
 * LOG_REQUEST_LIST → LOG_ENTRY collector. The first LOG_ENTRY pins the
 * advertised count and high id; duplicates do not count twice, and completion
 * requires every id in that advertised range. This handles both 0-based PX4
 * and 1-based ArduPilot logs without assuming one indexing convention.
 */
class LogList extends LogTransfer {
  constructor(opts) {
    super(opts);
    this._entries = new Map();
    this._numLogs = null;
    this._lastLogNum = null;
  }

  _messages() { return ['LOG_ENTRY']; }

  _begin() {
    this._onProgress({ phase: 'request-list' });
    this._requestRange(0, 0xffff);
  }

  _onMessage(decoded) {
    const f = decoded.fields;
    const id = Number(f.id);
    const numLogs = Number(f.num_logs);
    const lastLogNum = Number(f.last_log_num);

    if (numLogs === 0) {
      this._settle({ result: 'succeeded', phase: 'done', count: 0, entries: [] });
      return;
    }
    if (this._numLogs === null) {
      this._numLogs = numLogs;
      this._lastLogNum = lastLogNum;
    }

    const expectedStart = this._expectedStart();
    if (id < expectedStart || id > this._lastLogNum) return;
    if (this._entries.has(id)) return;

    this._entries.set(id, {
      id,
      numLogs: this._numLogs,
      lastLogNum: this._lastLogNum,
      timeUtc: Number(f.time_utc),
      size: Number(f.size),
    });
    this._noteProgress();
    this._onProgress({ phase: 'entry', id, count: this._numLogs });

    if (this._complete()) {
      const entries = [...this._entries.values()].sort((a, b) => a.id - b.id);
      this._settle({
        result: 'succeeded',
        phase: 'done',
        count: entries.length,
        entries,
      });
    }
  }

  _expectedStart() {
    if (this._numLogs === null || this._lastLogNum === null) return 0;
    return this._lastLogNum - this._numLogs + 1;
  }

  _complete() {
    if (this._numLogs === null || this._lastLogNum === null) return false;
    const first = this._expectedStart();
    for (let id = first; id <= this._lastLogNum; id += 1) {
      if (!this._entries.has(id)) return false;
    }
    return true;
  }

  _missingRange() {
    if (this._numLogs === null || this._lastLogNum === null) {
      return { start: 0, end: 0xffff };
    }
    const first = this._expectedStart();
    for (let id = first; id <= this._lastLogNum; id += 1) {
      if (!this._entries.has(id)) {
        let end = id;
        while (end < this._lastLogNum && !this._entries.has(end + 1)) end += 1;
        return { start: id, end };
      }
    }
    return null;
  }

  _requestRange(start, end) {
    const message = buildRequestList(this._target, start, end);
    this._step(`entries ${start}-${end}`, message);
  }

  _retryStep() {
    const range = this._missingRange();
    if (!range) return null;
    return {
      label: `entries ${range.start}-${range.end}`,
      message: buildRequestList(this._target, range.start, range.end),
    };
  }
}

module.exports = { LogList };
