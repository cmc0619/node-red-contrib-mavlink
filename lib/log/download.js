'use strict';

const { LogTransfer } = require('./transfer');
const { buildRequestData } = require('./items');

const LOG_DATA_BYTES = 90;
const LOG_REQUEST_BYTES = LOG_DATA_BYTES * 128;

/**
 * LOG_REQUEST_DATA → LOG_DATA assembler. A selected log is assembled into one
 * Buffer for the flow; no file is opened or written here. Received ranges are
 * retained so an out-of-order or duplicate packet cannot make a hole look
 * complete, and timeout retries ask only for the first missing range.
 */
class LogDownload extends LogTransfer {
  constructor(opts) {
    super(opts);
    this._id = opts.id;
    this._buffer = Buffer.alloc(0);
    this._ranges = [];
    this._eofSize = null;
    this._windowStart = 0;
    this._windowEnd = LOG_REQUEST_BYTES;
  }

  _messages() { return ['LOG_DATA']; }

  _begin() {
    this._onProgress({ phase: 'request-data', id: this._id });
    this._requestWindow(this._windowStart);
  }

  _onMessage(decoded) {
    const f = decoded.fields;
    if (Number(f.id) !== Number(this._id)) return;

    const ofs = Number(f.ofs);
    const count = Number(f.count);
    if (count === 0) {
      this._eofSize = ofs;
      this._onProgress({ phase: 'eof', id: this._id, size: ofs });
      this._maybeComplete();
      if (!this._settled) this._requestGap();
      return;
    }

    const bytes = Buffer.from(f.data).subarray(0, count);
    if (bytes.length === 0) return;
    const end = ofs + bytes.length;
    if (this._rangeCovered(ofs, end)) return;

    if (end > this._buffer.length) {
      // The LOG_ENTRY size is only a hint. Grow geometrically when a live log
      // is larger than that hint so a multi-megabyte download does not copy
      // the whole prefix for every 90-byte packet.
      let capacity = this._buffer.length || LOG_DATA_BYTES;
      while (capacity < end) capacity *= 2;
      const expanded = Buffer.alloc(capacity);
      this._buffer.copy(expanded);
      this._buffer = expanded;
    }
    bytes.copy(this._buffer, ofs);
    this._addRange(ofs, end);
    this._noteProgress();

    this._onProgress({
      phase: 'data',
      id: this._id,
      ofs,
      count: bytes.length,
      size: this._contiguousEnd(),
    });
    // Window requests and full-packet gap retries are aligned to 90-byte
    // payloads. A shorter reply is the final data packet; a full window needs
    // another request so exact-multiple logs can receive zero-count EOF.
    if (bytes.length < LOG_DATA_BYTES) this._eofSize = end;
    this._maybeComplete();
    if (!this._settled) this._requestGap();
  }

  _requestGap() {
    if (this._eofSize !== null) {
      const gap = this._missingRange();
      if (gap) {
        this._request(gap.start, gap.count);
        return;
      }
    }
    this._maybeComplete();
    if (this._settled) return;
    if (this._windowComplete()) this._requestWindow(this._windowEnd);
  }

  _requestWindow(ofs) {
    this._windowStart = ofs;
    this._windowEnd = ofs + LOG_REQUEST_BYTES;
    this._step(`offset ${ofs}`, buildRequestData(this._target, this._id, ofs, LOG_REQUEST_BYTES));
  }

  _request(ofs, count) {
    this._step(`offset ${ofs}`, buildRequestData(this._target, this._id, ofs, count));
  }

  _retryStep() {
    const gap = this._missingRange();
    if (gap) {
      return {
        label: `offset ${gap.start}`,
        message: buildRequestData(this._target, this._id, gap.start, gap.count),
      };
    }
    this._maybeComplete();
    if (this._settled) return null;
    if (this._windowComplete()) {
      const ofs = this._windowEnd;
      this._windowStart = ofs;
      this._windowEnd = ofs + LOG_REQUEST_BYTES;
      return {
        label: `offset ${ofs}`,
        message: buildRequestData(this._target, this._id, ofs, LOG_REQUEST_BYTES),
      };
    }
    return null;
  }

  _missingRange() {
    const start = this._windowStart;
    const limit = this._eofSize === null
      ? this._windowEnd
      : Math.min(this._eofSize, this._windowEnd);

    let cursor = start;
    for (const [rangeStart, rangeEnd] of this._ranges) {
      if (rangeStart > cursor) {
        return { start: cursor, count: Math.min(rangeStart - cursor, limit - cursor) };
      }
      if (rangeEnd > cursor) cursor = rangeEnd;
      if (cursor >= limit) return null;
    }
    return cursor < limit ? { start: cursor, count: limit - cursor } : null;
  }

  _maybeComplete() {
    const limit = this._eofSize;
    if (limit !== null && this._contiguousEnd() >= limit) this._settleSuccess(limit);
  }

  _windowComplete() {
    return this._rangeCovered(this._windowStart, this._windowEnd);
  }

  _settleSuccess(size) {
    if (this._settled) return;
    this._settle({
      result: 'succeeded',
      phase: 'done',
      id: this._id,
      size,
      data: Buffer.from(this._buffer.subarray(0, size)),
    });
  }

  _rangeCovered(start, end) {
    return this._ranges.some(([left, right]) => start >= left && end <= right);
  }

  _addRange(start, end) {
    const merged = [];
    let nextStart = start;
    let nextEnd = end;
    let inserted = false;
    for (const [left, right] of this._ranges) {
      if (right < nextStart) {
        merged.push([left, right]);
      } else if (nextEnd < left) {
        if (!inserted) {
          merged.push([nextStart, nextEnd]);
          inserted = true;
        }
        merged.push([left, right]);
      } else {
        nextStart = Math.min(nextStart, left);
        nextEnd = Math.max(nextEnd, right);
      }
    }
    if (!inserted) merged.push([nextStart, nextEnd]);
    this._ranges = merged;
  }

  _contiguousEnd() {
    if (this._ranges.length === 0 || this._ranges[0][0] !== 0) return 0;
    let end = this._ranges[0][1];
    for (let i = 1; i < this._ranges.length && this._ranges[i][0] <= end; i += 1) {
      end = Math.max(end, this._ranges[i][1]);
    }
    return end;
  }

}

module.exports = { LogDownload, LOG_DATA_BYTES, LOG_REQUEST_BYTES };
