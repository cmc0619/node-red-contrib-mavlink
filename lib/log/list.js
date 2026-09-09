'use strict';

const { LogTransfer } = require('./transfer');
const { buildRequestList } = require('./items');

/**
 * Collect the advertised number of distinct log entries. IDs and last_log_num
 * are peer metadata; completion does not infer an indexing convention.
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
    this._step('list', buildRequestList(this._target));
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

    if (this._entries.size === this._numLogs) {
      const entries = [...this._entries.values()].sort((a, b) => a.id - b.id);
      this._settle({
        result: 'succeeded',
        phase: 'done',
        count: entries.length,
        entries,
      });
    }
  }

  _retryStep() {
    return { label: 'list', message: buildRequestList(this._target) };
  }
}

module.exports = { LogList };
