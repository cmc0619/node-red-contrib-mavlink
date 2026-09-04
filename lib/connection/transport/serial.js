'use strict';

/**
 * Serial transport (DESIGN.md §3, §7, §8). The transport is a thin,
 * event-emitting wrapper over the optional `serialport` package. It keeps the
 * same driver contract as UDP/TCP: write one frame, wait until the underlying
 * stream accepts/drains it, then release the driver's queue callback.
 *
 * `serialport` is deliberately lazy-loaded from `open()` so UDP/TCP installs can
 * load without the optional native dependency. Tests can inject `SerialPort`
 * directly through constructor deps.
 *
 * Events: `listening`, `message` ({ buffer, address, port }), `error`, `close`.
 */

const { EventEmitter } = require('node:events');

/** Soft failure: serial writes need an opened port. */
const SERIAL_NO_DESTINATION = 'SERIAL_NO_DESTINATION';

/**
 * @typedef {object} SerialConfig
 * @property {string} path  serial port path, e.g. /dev/ttyUSB0 or COM3
 * @property {number} baudRate  serial baud rate (the editor owns the default)
 * @property {number} [highWaterMark]  shallow stream buffer for driver pacing (tests)
 */

class SerialTransport extends EventEmitter {
  /**
   * @param {SerialConfig} config
   * @param {object} [deps]
   * @param {Function} [deps.SerialPort]  injected SerialPort class for tests
   */
  constructor(config, deps = {}) {
    super();
    this.mode = 'serial';
    this._config = config;
    this._SerialPort = deps.SerialPort || null;
    this._port = null;
    this._open = false;
    this._closed = false;
    /** @type {Set<(err?: Error) => void>} */
    this._pendingWrites = new Set();
  }

  /**
   * Open the serial port. Resolves after the port reports open and emits the
   * transport-level `listening` event used by the connection runtime.
   *
   * @returns {Promise<void>}
   */
  open() {
    return new Promise((resolve, reject) => {
      const SerialPort = this._SerialPort || loadSerialPort();
      const options = {
        path: this._config.path,
        baudRate: this._config.baudRate,
        autoOpen: false,
      };
      if (this._config.highWaterMark !== undefined) {
        options.highWaterMark = this._config.highWaterMark;
      }

      const port = new SerialPort(options);
      this._port = port;

      port.prependListener('error', (err) => {
        this._open = false;
        // Emit before failing pending writes so the runtime clears `_ready`
        // before the send callback resumes the queue pump.
        this.emit('error', err);
        this._failPendingWrites(err);
      });
      port.on('data', (buffer) => {
        this.emit('message', { buffer, address: this._config.path, port: 0 });
      });
      port.prependListener('close', () => {
        this._open = false;
        const err = new Error('Serial port closed');
        err.code = 'SERIAL_DISCONNECTED';
        if (!this._closed) this.emit('error', err);
        this._failPendingWrites(err);
        this.emit('close');
      });

      const onOpenError = (err) => {
        port.removeListener('error', onOpenError);
        reject(err);
      };
      port.once('error', onOpenError);

      port.open((err) => {
        port.removeListener('error', onOpenError);
        if (err) {
          reject(err);
          return;
        }
        if (this._closed) {
          // close() raced the open callback — release the device handle.
          port.close(() => {});
          resolve();
          return;
        }
        this._open = true;
        this.emit('listening');
        resolve();
      });
    });
  }

  /**
   * Send one frame on the serial stream. The endpoint argument is accepted for
   * the shared transport contract; serial links always write to the open port.
   *
   * @param {Buffer} buffer
   * @param {{address: string, port: number}|null} endpoint
   * @param {(err?: Error) => void} callback
   */
  send(buffer, endpoint, callback) {
    void endpoint;
    if (!this._port || !this._open) {
      const err = new Error('Serial send has no destination (port is not open)');
      err.code = SERIAL_NO_DESTINATION;
      callback(err);
      return;
    }

    const port = this._port;
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      this._pendingWrites.delete(finish);
      port.removeListener('drain', onDrain);
      callback(err);
    };
    const onDrain = () => finish();

    this._pendingWrites.add(finish);
    if (port.write(buffer)) {
      finish();
      return;
    }
    // Close/error release pending writes via the port lifecycle listeners so a
    // quiet write-local close handler cannot resume the pump first.
    port.once('drain', onDrain);
  }

  /** @param {Error} err */
  _failPendingWrites(err) {
    const pending = [...this._pendingWrites];
    this._pendingWrites.clear();
    for (const finish of pending) finish(err);
  }

  /**
   * Close the serial port. Always invokes `callback` so Node-RED redeploys do
   * not hang if close is called before open completes.
   *
   * @param {() => void} callback
   */
  close(callback) {
    if (this._closed) {
      this._failPendingWrites(new Error('Serial transport closed'));
      callback();
      return;
    }
    this._closed = true;
    this._failPendingWrites(new Error('Serial transport closed'));
    if (!this._port) {
      callback();
      return;
    }
    if (!this._open) {
      // Two ways here with a port in hand. open() still in flight: its
      // callback releases the handle when it sees `_closed`, so returning is
      // right. Port errored *after* opening: serialport keeps
      // the OS handle held through an error — `isOpen` still true — and
      // skipping the close leaks the device, so the reconnect redial (and
      // the next deploy) find it busy.
      if (this._port.isOpen) {
        this._port.close(() => callback());
        return;
      }
      callback();
      return;
    }
    this._port.close(() => callback());
  }
}

function loadSerialPort() {
  try {
    const serialport = require('serialport');
    return serialport.SerialPort || serialport;
  } catch (err) {
    // The missing module must be `serialport` itself. Node puts the require
    // stack inside `message`, so a loose match also catches a MODULE_NOT_FOUND
    // raised *inside* an installed serialport — a missing native binding —
    // and would report a broken install as an absent optional dependency
    //: the port listing would answer 200 with an empty list instead
    // of the 500 a broken install earns.
    if (err.code === 'MODULE_NOT_FOUND' && /Cannot find module 'serialport'/.test(err.message)) {
      const missing = new Error(
        "Serial transport requires optional dependency 'serialport'. Install 'serialport' to use serial connections."
      );
      missing.code = 'SERIALPORT_MISSING';
      throw missing;
    }
    throw err;
  }
}

/**
 * Host serial ports, for the Connection editor's path suggestions. The
 * optional `serialport` dependency being absent is an empty list rather than
 * a failure: UDP and TCP installs never carry it, and the path field takes
 * free text either way. Async so a real listing failure — a permissions
 * error, a broken native binding — reaches the caller as a rejection instead
 * of a synchronous throw from a function that returns a promise.
 *
 * No module cache of its own: `require` already caches, and `loadSerialPort`
 * is the one loader (§3).
 *
 * @returns {Promise<object[]>} serialport PortInfo records; [] when absent
 */
async function listSerialPorts() {
  try {
    return await loadSerialPort().list();
  } catch (err) {
    if (err.code === 'SERIALPORT_MISSING') return [];
    throw err;
  }
}

module.exports = { SerialTransport, SERIAL_NO_DESTINATION, listSerialPorts };
