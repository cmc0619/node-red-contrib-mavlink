'use strict';

const { posix: remotePath } = require('node:path');

const {
  MAX_DATA_BYTES,
  OPCODE,
  NAK_ERROR,
  buildRequest,
  decodePayload,
} = require('./items');

const NAK_ERROR_NAME = Object.freeze({
  [NAK_ERROR.FAIL]: 'failure',
  [NAK_ERROR.FAIL_ERRNO]: 'errno failure',
  [NAK_ERROR.INVALID_DATA_SIZE]: 'invalid data size',
  [NAK_ERROR.INVALID_SESSION]: 'invalid session',
  [NAK_ERROR.NO_SESSIONS_AVAILABLE]: 'no sessions available',
  [NAK_ERROR.EOF]: 'end of file',
  [NAK_ERROR.UNKNOWN_COMMAND]: 'unknown command',
  [NAK_ERROR.FILE_EXISTS]: 'file exists',
  [NAK_ERROR.FILE_PROTECTED]: 'file protected',
  [NAK_ERROR.FILE_NOT_FOUND]: 'file not found',
});

const SEQUENCE_STEP = 2;

// Peers cache the last reply by the request sequence. Advancing by two for
// each new request leaves the reply sequence in between and prevents a new
// machine from accidentally replaying a previous conversation.
let nextSequenceNumber = 0;

/** @returns {number} */
function takeSequence() {
  const sequence = nextSequenceNumber;
  nextSequenceNumber = (sequence + SEQUENCE_STEP) & 0xffff;
  return sequence;
}

/** @param {number} sequence @returns {number} */
function replySequence(sequence) {
  return (sequence + 1) & 0xffff;
}

/**
 * One sequential MAVLink FTP conversation.
 */
class FtpMachine {
  /**
   * @param {string} operation
   * @param {object} opts
   */
  constructor(operation, opts) {
    this._operation = operation;
    this._send = opts.send;
    this._subscribe = opts.subscribe;
    this._target = opts.target;
    this._source = opts.source;
    this._path = opts.path;
    this._data = opts.data;
    this._entriesInput = opts.entries;
    this._timeoutMs = opts.timeoutMs;
    this._maxRetries = opts.maxRetries;
    this._onProgress = opts.onProgress;
    this._now = opts.now || Date.now;
    this._setTimeout = opts.setTimeout || setTimeout;
    this._clearTimeout = opts.clearTimeout || clearTimeout;
    this._unsubscribe = null;
    this._timer = null;
    this._current = null;
    this._session = null;
    this._cleanup = null;
    this._settled = false;
    this._resolve = null;
    this._startMs = 0;
    this._child = null;

    this._listOffset = 0;
    this._entries = [];
    this._fileSize = 0;
    this._offset = 0;
    this._chunks = [];
  }

  /** @returns {Promise<object>} */
  start() {
    return new Promise((resolve) => {
      this._resolve = resolve;
      this._startMs = this._now();
      const handler = (decoded) => {
        if (this._settled) return;
        try {
          this._handleMessage(decoded);
        } catch (err) {
          this._fail('protocol', `FTP response failed: ${err.message}`, this._currentProtocol());
        }
      };
      const filter = {
        message: 'FILE_TRANSFER_PROTOCOL',
        ...(this._target.sysid !== 0 ? { sysid: this._target.sysid } : {}),
        ...(this._target.compid !== 0 ? { compid: this._target.compid } : {}),
        trustedOnly: true,
      };

      try {
        this._unsubscribe = this._subscribe(filter, handler);
      } catch (err) {
        this._fail('subscribe', `FTP subscription failed: ${err.message}`);
        return;
      }

      try {
        this._begin();
      } catch (err) {
        this._fail('send', `FTP request failed: ${err.message}`);
      }
    });
  }

  cancel() {
    if (this._child) {
      this._child.cancel();
      this._child = null;
      this._settle({ result: 'cancelled', phase: 'cancelled', reason: 'transfer cancelled' });
      return;
    }
    if (this._cleanup) {
      this._cleanup = null;
      this._finalize({ result: 'cancelled', phase: 'cancelled', reason: 'transfer cancelled' });
      return;
    }
    this._settle({ result: 'cancelled', phase: 'cancelled', reason: 'transfer cancelled' });
  }

  _begin() {
    let begin;
    switch (this._operation) {
      case 'list':
        begin = this._beginList;
        break;
      case 'download':
        begin = this._beginDownload;
        break;
      case 'upload':
        begin = this._beginUpload;
        break;
      case 'create-directory':
        begin = this._beginCreateDirectory;
        break;
      case 'backup':
        begin = this._beginBackup;
        break;
      case 'restore':
        begin = this._beginRestore;
        break;
      default: break; // This space intentionally left blank (§5)
    }
    begin.call(this);
  }

  _beginList() {
    this._listOffset = 0;
    this._entries = [];
    const path = Buffer.from(this._path);
    this._progress({ phase: 'request-list' });
    this._sendRequest(OPCODE.LIST_DIRECTORY, 0, 0, path, path.length, 'list');
  }

  _beginDownload() {
    const path = Buffer.from(this._path);
    this._progress({ phase: 'open', operation: 'download' });
    this._sendRequest(OPCODE.OPEN_FILE_RO, 0, 0, path, path.length, 'open');
  }

  _beginUpload() {
    const path = Buffer.from(this._path);
    this._progress({ phase: 'open', operation: 'upload' });
    this._sendRequest(OPCODE.CREATE_FILE, 0, 0, path, path.length, 'create');
  }

  _beginCreateDirectory() {
    const path = Buffer.from(this._path);
    this._progress({ phase: 'create-directory', path: this._path });
    this._sendRequest(OPCODE.CREATE_DIRECTORY, 0, 0, path, path.length, 'create-directory');
  }

  _beginBackup() {
    this._progress({ phase: 'backup', root: this._path });
    this._runComposite(async () => {
      const queue = [{ absolute: this._path, relative: '' }];
      const directories = [];
      const files = [];
      while (!this._settled && queue.length > 0) {
        const directory = queue.shift();
        const outcome = await this._startChild('list', { path: directory.absolute });
        if (this._settled) return;
        if (outcome.result !== 'succeeded') {
          this._settle(childOutcome(outcome));
          return;
        }
        for (const entry of outcome.entries) {
          switch (entry.type) {
            case 'directory':
              if (entry.name === '.' || entry.name === '..') break;
              {
                const relative = remotePath.join(directory.relative, entry.name);
                directories.push(relative);
                queue.push({
                  absolute: remotePath.join(directory.absolute, entry.name),
                  relative,
                });
              }
              break;
            case 'file':
              files.push({
                absolute: remotePath.join(directory.absolute, entry.name),
                relative: remotePath.join(directory.relative, entry.name),
              });
              break;
            default: break; // This space intentionally left blank (§5)
          }
        }
      }
      for (const file of files) {
        const outcome = await this._startChild('download', { path: file.absolute });
        if (this._settled) return;
        if (outcome.result !== 'succeeded') {
          this._settle(childOutcome(outcome));
          return;
        }
        file.data = outcome.data.toString('base64');
      }
      this._finish({
        root: this._path,
        directories,
        files: files.map((file) => ({ path: file.relative, data: file.data })),
      });
    });
  }

  _beginRestore() {
    this._progress({ phase: 'restore', root: this._path });
    this._runComposite(async () => {
      const directories = this._entriesInput.directories;
      const files = this._entriesInput.files;
      let restoredDirectories = 0;
      let restoredFiles = 0;
      let bytes = 0;
      const rootOutcome = await this._restoreDirectory(this._path);
      if (this._settled) return;
      if (rootOutcome.result !== 'succeeded') {
        this._settle({
          ...childOutcome(rootOutcome),
          restoredDirectories,
          restoredFiles,
          bytes,
        });
        return;
      }
      for (const relative of directories) {
        const outcome = await this._restoreDirectory(remotePath.join(this._path, relative));
        if (this._settled) return;
        if (outcome.result !== 'succeeded') {
          this._settle({
            ...childOutcome(outcome),
            restoredDirectories,
            restoredFiles,
            bytes,
          });
          return;
        }
        restoredDirectories += 1;
      }
      for (const file of files) {
        const outcome = await this._startChild('upload', {
          path: remotePath.join(this._path, file.path),
          data: Buffer.from(file.data, 'base64'),
        });
        if (this._settled) return;
        if (outcome.result !== 'succeeded') {
          this._settle({
            ...childOutcome(outcome),
            restoredDirectories,
            restoredFiles,
            bytes,
          });
          return;
        }
        restoredFiles += 1;
        bytes += outcome.bytes;
      }
      this._finish({ restoredDirectories, restoredFiles, bytes });
    });
  }

  async _restoreDirectory(path) {
    const outcome = await this._startChild('create-directory', { path });
    if (this._settled || outcome.result === 'succeeded') return outcome;
    if (outcome.protocol?.errorCode !== NAK_ERROR.FILE_EXISTS) return outcome;
    return this._startChild('list', { path });
  }

  _runComposite(run) {
    run().catch((err) => {
      if (!this._settled) this._fail('protocol', `FTP operation failed: ${err.message}`);
    });
  }

  _startChild(operation, options) {
    const child = new FtpMachine(operation, {
      send: this._send,
      subscribe: this._subscribe,
      target: this._target,
      source: this._source,
      timeoutMs: this._timeoutMs,
      maxRetries: this._maxRetries,
      onProgress: (update) => this._progress(update),
      now: this._now,
      setTimeout: this._setTimeout,
      clearTimeout: this._clearTimeout,
      ...options,
    });
    this._child = child;
    return child.start().then((outcome) => {
      if (this._child === child) this._child = null;
      return outcome;
    });
  }

  /**
   * @param {number} opcode
   * @param {number} session
   * @param {number} offset
   * @param {Buffer} data
   * @param {number} size
   * @param {string} phase
   */
  _sendRequest(opcode, session, offset, data, size, phase) {
    const seq = takeSequence();
    const message = buildRequest(this._target, seq, opcode, session, offset, data, size);
    this._current = {
      opcode,
      session,
      offset,
      size,
      phase,
      seq,
      replySeq: replySequence(seq),
      retries: 0,
      message,
      data,
    };
    this._armTimer();
    this._sendCurrent();
  }

  _sendCurrent() {
    if (this._settled) return;
    try {
      this._send(this._current.message);
    } catch (err) {
      this._fail('send', `${this._current.phase} send failed: ${err.message}`);
    }
  }

  _armTimer() {
    this._clearTimer();
    this._timer = this._setTimeout(() => this._onTimeout(), this._timeoutMs);
  }

  _onTimeout() {
    if (this._settled) return;
    if (this._current.retries < this._maxRetries) {
      this._current.retries += 1;
      this._progress({
        phase: 'retry',
        step: this._current.phase,
        retry: this._current.retries,
      });
      this._armTimer();
      this._sendCurrent();
      return;
    }
    this._fail(
      'timeout',
      `FTP request ${this._current.phase} timed out after ${this._maxRetries} retries`,
      this._currentProtocol(),
    );
  }

  _handleMessage(decoded) {
    if (this._settled || !this._current || !this._sourceMatches(decoded)) return;
    if (!this._destinationMatches(decoded.fields)) return;

    const response = decodePayload(decoded.fields.payload);
    if (!this._responseMatches(response)) return;

    switch (response.opcode) {
      case OPCODE.ACK:
        this._handleAck(response);
        break;
      case OPCODE.NAK:
        this._handleNak(response);
        break;
      default: break; // This space intentionally left blank (§5)
    }
  }

  /** @param {object} decoded @returns {boolean} */
  _sourceMatches(decoded) {
    if (this._target.sysid !== 0 && Number(decoded.sysid) !== Number(this._target.sysid)) {
      return false;
    }
    return this._target.compid === 0
      || Number(decoded.compid) === Number(this._target.compid);
  }

  /** @param {object} fields @returns {boolean} */
  _destinationMatches(fields) {
    return (fields.target_system === 0 || Number(fields.target_system) === Number(this._source.sysid))
      && (fields.target_component === 0 || Number(fields.target_component) === Number(this._source.compid));
  }

  /** @param {object} response @returns {boolean} */
  _responseMatches(response) {
    const current = this._current;
    return response.seq === current.replySeq
      && response.reqOpcode === current.opcode
      && (current.opcode === OPCODE.OPEN_FILE_RO
        || current.opcode === OPCODE.CREATE_FILE
        || response.session === current.session)
      && response.offset === current.offset;
  }

  /** @param {object} response */
  _handleAck(response) {
    const current = this._current;
    this._clearTimer();
    switch (current.opcode) {
      case OPCODE.LIST_DIRECTORY:
        this._listAck(response);
        break;
      case OPCODE.OPEN_FILE_RO:
        this._openAck(response);
        break;
      case OPCODE.READ_FILE:
        this._readAck(response);
        break;
      case OPCODE.CREATE_FILE:
        this._createAck(response);
        break;
      case OPCODE.CREATE_DIRECTORY:
        this._finish({ path: this._path });
        break;
      case OPCODE.WRITE_FILE:
        this._writeAck(response);
        break;
      case OPCODE.TERMINATE_SESSION:
        this._cleanupSucceeded();
        break;
      default: break; // This space intentionally left blank (§5)
    }
  }

  /** @param {object} response */
  _handleNak(response) {
    const code = response.data[0];
    let handled = false;
    switch (this._current.opcode) {
      case OPCODE.LIST_DIRECTORY:
        if (code === NAK_ERROR.EOF) {
          this._finish({ entries: this._entries, count: this._entries.length });
          handled = true;
        }
        break;
      case OPCODE.READ_FILE:
        if (code === NAK_ERROR.EOF) {
          this._finish({ data: this._downloadData() });
          handled = true;
        }
        break;
      default: break; // This space intentionally left blank (§5)
    }
    if (handled) return;
    const name = NAK_ERROR_NAME[code] || `error ${code}`;
    const protocol = responseProtocol(response, code);
    if (code === NAK_ERROR.FAIL_ERRNO) protocol.errno = response.data[1];
    this._fail('ack', `FTP NAK: ${name}`, protocol);
  }

  /** @param {object} response */
  _listAck(response) {
    const page = parseDirectory(response.data);
    if (page.count === 0) {
      this._fail('protocol', 'FTP directory acknowledgement contained no entries', responseProtocol(response));
      return;
    }
    this._entries.push(...page.entries);
    this._listOffset += page.count;
    this._progress({ phase: 'entry', count: this._entries.length });
    const path = Buffer.from(this._path);
    this._sendRequest(OPCODE.LIST_DIRECTORY, 0, this._listOffset, path, path.length, 'list');
  }

  /** @param {object} response */
  _openAck(response) {
    if (response.size !== 4 || response.data.length < 4) {
      this._fail('protocol', 'FTP open acknowledgement omitted the file size', responseProtocol(response));
      return;
    }
    this._session = response.session;
    this._fileSize = response.data.readUInt32LE(0);
    this._offset = 0;
    this._chunks = [];
    this._progress({ phase: 'opened', size: this._fileSize });
    this._sendRead();
  }

  _sendRead() {
    const size = this._offset < this._fileSize
      ? Math.min(MAX_DATA_BYTES, this._fileSize - this._offset)
      : MAX_DATA_BYTES;
    this._sendRequest(OPCODE.READ_FILE, this._session, this._offset, Buffer.alloc(0), size, 'read');
  }

  /** @param {object} response */
  _readAck(response) {
    const current = this._current;
    if (response.size === 0 || response.size > current.size || response.data.length < response.size) {
      this._fail('protocol', 'FTP read acknowledgement carried an invalid data size', responseProtocol(response));
      return;
    }
    const bytes = response.data.subarray(0, response.size);
    this._chunks.push(Buffer.from(bytes));
    this._offset += bytes.length;
    this._progress({ phase: 'data', offset: this._offset, bytes: bytes.length, size: this._fileSize });
    this._sendRead();
  }

  /** @param {object} response */
  _createAck(response) {
    if (response.size !== 0 && (response.size !== 4 || response.data.length < 4)) {
      this._fail('protocol', 'FTP create acknowledgement carried data', responseProtocol(response));
      return;
    }
    this._session = response.session;
    this._offset = 0;
    this._progress({ phase: 'opened', session: this._session });
    if (this._data.length === 0) {
      this._finish({ bytes: 0 });
      return;
    }
    this._sendWrite();
  }

  _sendWrite() {
    const data = this._data.subarray(this._offset, this._offset + MAX_DATA_BYTES);
    this._sendRequest(OPCODE.WRITE_FILE, this._session, this._offset, data, data.length, 'write');
  }

  /** @param {object} response */
  _writeAck(response) {
    const current = this._current;
    if (response.size !== 0 && (response.size !== 4 || response.data.length < 4)) {
      this._fail('protocol', 'FTP write acknowledgement carried data', responseProtocol(response));
      return;
    }
    const bytesWritten = response.size === 0
      ? current.data.length
      : response.data.readUInt32LE(0);
    if (bytesWritten === 0 || bytesWritten > current.data.length) {
      this._fail('protocol', 'FTP write acknowledgement made no valid progress', responseProtocol(response));
      return;
    }
    this._offset += bytesWritten;
    this._progress({ phase: 'data', offset: this._offset, bytes: bytesWritten, size: this._data.length });
    if (this._offset >= this._data.length) {
      this._finish({ bytes: this._data.length });
      return;
    }
    this._sendWrite();
  }

  /** @param {object} outcome */
  _finish(outcome) {
    this._settle({ result: 'succeeded', phase: 'done', ...outcome });
  }

  /**
   * @param {string} phase
   * @param {string} reason
   * @param {object} [protocol]
   */
  _fail(phase, reason, protocol) {
    if (this._cleanup) {
      this._cleanupFailed(reason, protocol);
      return;
    }
    this._settle({
      result: 'failed',
      phase,
      reason,
      ...(protocol === undefined ? {} : { protocol }),
    });
  }

  /** @param {object} outcome */
  _settle(outcome) {
    if (this._settled || this._cleanup) return;
    const session = this._session;
    this._session = null;
    if (session !== null && outcome.result !== 'cancelled') {
      this._cleanup = { outcome, session };
      try {
        this._sendRequest(
          OPCODE.TERMINATE_SESSION,
          session,
          0,
          Buffer.alloc(0),
          0,
          'cleanup',
        );
      } catch (err) {
        this._cleanupFailed(`FTP terminate-session send failed: ${err.message}`);
      }
      return;
    }
    if (session !== null) {
      this._finalize(outcome, session);
      return;
    }
    this._finalize(outcome);
  }

  /** @param {string} reason @param {object} [protocol] */
  _cleanupFailed(reason, protocol) {
    const cleanup = this._cleanup;
    if (!cleanup) return;
    this._cleanup = null;
    if (cleanup.outcome.result === 'succeeded') {
      this._finalize({
        ...cleanup.outcome,
        result: 'failed',
        phase: 'cleanup',
        reason,
        protocol: protocol || { opcode: OPCODE.TERMINATE_SESSION, session: cleanup.session },
      });
      return;
    }
    this._finalize({ ...cleanup.outcome, cleanupError: reason });
  }

  _cleanupSucceeded() {
    const cleanup = this._cleanup;
    if (!cleanup) return;
    this._cleanup = null;
    this._finalize(cleanup.outcome);
  }

  /** @param {object} outcome @param {number|null} [bestEffortSession] */
  _finalize(outcome, bestEffortSession = null) {
    if (this._settled) return;
    this._settled = true;
    this._clearTimer();
    const unsubscribe = this._unsubscribe;
    this._unsubscribe = null;
    if (unsubscribe) unsubscribe();
    const terminal = { elapsed: this._now() - this._startMs, ...outcome };
    if (bestEffortSession !== null) {
      try {
        const sequence = takeSequence();
        this._send(buildRequest(
          this._target,
          sequence,
          OPCODE.TERMINATE_SESSION,
          bestEffortSession,
          0,
          Buffer.alloc(0),
          0,
        ));
      } catch (err) {
        terminal.cleanupError = `FTP terminate-session send failed: ${err.message}`;
      }
    }
    this._resolve(terminal);
  }

  _clearTimer() {
    if (this._timer !== null) {
      this._clearTimeout(this._timer);
      this._timer = null;
    }
  }

  /** @param {object} update */
  _progress(update) {
    if (this._settled) return;
    this._onProgress(update);
  }

  /** @returns {object} */
  _currentProtocol() {
    const current = this._current;
    return {
      seq: current.seq,
      opcode: current.opcode,
      session: current.session,
      offset: current.offset,
    };
  }

  _downloadData() {
    return Buffer.concat(this._chunks);
  }
}

/** @param {object} response @param {number} [errorCode] @returns {object} */
function responseProtocol(response, errorCode) {
  return {
    seq: response.seq,
    opcode: response.opcode,
    reqOpcode: response.reqOpcode,
    session: response.session,
    offset: response.offset,
    ...(errorCode === undefined ? {} : { errorCode }),
  };
}

/** @param {object} outcome @returns {object} */
function childOutcome(outcome) {
  const { elapsed: _elapsed, ...terminal } = outcome;
  return terminal;
}

/**
 * Parse one directory acknowledgement. Every nonempty NUL-delimited record
 * advances the peer's index, including skip and malformed records.
 *
 * @param {Buffer} data
 * @returns {{entries:Array<object>,count:number}}
 */
function parseDirectory(data) {
  const entries = [];
  let count = 0;
  let start = 0;
  while (start < data.length) {
    let end = data.indexOf(0, start);
    if (end < 0) end = data.length;
    const record = data.subarray(start, end);
    if (record.length > 0) {
      count += 1;
      const entry = parseDirectoryRecord(record);
      if (entry) entries.push(entry);
    }
    start = end + 1;
  }
  return { entries, count };
}

/** @param {Buffer} record @returns {object|null} */
function parseDirectoryRecord(record) {
  const text = record.toString('utf8');
  const type = text[0];
  const body = text.slice(1);
  switch (type) {
    case 'F': {
      const tab = body.indexOf('\t');
      if (tab < 0) return null;
      const size = Number(body.slice(tab + 1));
      if (!Number.isFinite(size)) return null;
      return { name: body.slice(0, tab), type: 'file', size };
    }
    case 'D':
      return { name: body, type: 'directory', size: 0 };
    case 'S':
      return null;
    default: break; // This space intentionally left blank (§5)
  }
  return null;
}

module.exports = { FtpMachine, parseDirectory };
