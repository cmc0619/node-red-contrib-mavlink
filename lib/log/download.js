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
 * opts.size supplies an exact byte boundary when the peer omits EOF packets.
 */
class LogDownload extends LogTransfer {
  constructor(opts) {
    super(opts);
    this._id = opts.id;
    this._buffer = Buffer.alloc(0);
    this._ranges = [];
    this._eofSize = null;
    this._expectedSize = opts.size === undefined ? null : opts.size;
    this._windowStart = 0;
    this._windowEnd = LOG_REQUEST_BYTES;
  }

  _messages() { return ['LOG_DATA']; }

  _begin() {
    this._onProgress({ phase: 'request-data', id: this._id });
    this._maybeComplete();
    if (!this._settled) this._requestWindow(this._windowStart);
  }

  _onMessage(decoded) {
    const fields = decoded.fields;
    if (Number(fields.id) !== Number(this._id)) return;

    const ofs = Number(fields.ofs);
    const count = Number(fields.count);
    if (count === 0) {
      this._eofSize = ofs;
      this._onProgress({ phase: 'eof', id: this._id, size: ofs });
      this._maybeComplete();
      if (!this._settled) this._requestGap();
      return;
    }

    const bytes = Buffer.from(fields.data).subarray(0, count);
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
    // payloads, so a short reply is normally the last data packet; a full
    // window needs another request so exact-multiple logs can receive the
    // zero-count EOF. That is an inference, and a peer may also short-read
    // mid-log, so it does not run when the caller supplied the exact byte
    // count: there the end is already known, and letting a short read move it
    // earlier would settle a truncated log as a complete one.
    if (bytes.length < LOG_DATA_BYTES && this._expectedSize === null) this._eofSize = end;
    this._maybeComplete();
    if (!this._settled) this._requestGap();
  }

  _requestGap() {
    // Gated on the peer's EOF, not on _knownEnd(): while the stream is still
    // running, bytes ahead of the cursor are merely unsent, and chasing them
    // would put a LOG_REQUEST_DATA behind every packet. A caller-supplied
    // length says where the log ends, not that the peer has finished sending.
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
    const label = `offset ${ofs} count ${count}`;
    if (this._stepLabel === label) return;
    this._step(label, buildRequestData(this._target, this._id, ofs, count));
  }

  _retryStep() {
    const gap = this._missingRange();
    if (gap) {
      return {
        label: `offset ${gap.start} count ${gap.count}`,
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
    const known = this._knownEnd();
    const limit = known === null ? this._windowEnd : Math.min(known, this._windowEnd);

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

  /**
   * The log's end offset once anything establishes it: the peer's own EOF when
   * it has spoken, otherwise the exact byte count the caller supplied. Null
   * while neither is known — the ArduPilot case, where only an EOF ends it.
   *
   * @returns {number|null}
   */
  _knownEnd() {
    return this._eofSize === null ? this._expectedSize : this._eofSize;
  }

  _maybeComplete() {
    const limit = this._knownEnd();
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
