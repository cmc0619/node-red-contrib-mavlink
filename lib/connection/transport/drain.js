'use strict';

/**
 * Write one frame to a stream and settle `callback` once the stream has
 * taken it: at once when `write` returns true, on the next `drain` when the
 * stream applied back-pressure, or with an error when the transport releases
 * every settle function in `pending` on close or error — the transport's
 * lifecycle listeners own that release, so a quiet write-local close handler
 * cannot beat peer demotion or the runtime's ERROR.
 *
 * @param {{write: Function, once: Function, removeListener: Function}} stream
 * @param {Buffer} buffer
 * @param {Set<Function>} pending  the transport's live settle functions
 * @param {(err?: Error) => void} callback
 * @returns {void}
 */
function writeDrained(stream, buffer, pending, callback) {
  let done = false;
  function onDrain() {
    finish();
  }
  function finish(err) {
    if (done) return;
    done = true;
    pending.delete(finish);
    stream.removeListener('drain', onDrain);
    callback(err);
  }
  pending.add(finish);
  if (stream.write(buffer)) {
    finish();
    return;
  }
  stream.once('drain', onDrain);
}

module.exports = { writeDrained };
