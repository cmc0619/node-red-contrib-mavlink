'use strict';

/**
 * Test doubles for the Connection runtime (DESIGN.md §13 "mock dgram"). None of
 * these register tests; `node --test` runs every `.js` under `test/`, so this
 * file is side-effect-free on require.
 *
 * - {@link mockDgram} — a `dgram`-shaped module whose sockets are in-memory
 *   EventEmitters. `socket.receive()` injects an inbound datagram; `socket.sent`
 *   records every outbound one; `send`'s callback is the release the driver
 *   waits on.
 * - {@link fakeWire} — a trivial JSON wire so the runtime's queue driver, peer
 *   table, and subscription plumbing are exercised without `node-mavlink`.
 * - {@link fakeTimers} — non-firing interval stubs that record clear() calls so
 *   teardown can be asserted.
 */

const { EventEmitter } = require('node:events');

/**
 * @returns {{module: object, sockets: object[]}} a dgram-shaped module and the
 *   list of sockets it has created (newest last)
 */
function mockDgram() {
  const sockets = [];
  const module = {
    createSocket() {
      const socket = new EventEmitter();
      socket.sent = [];
      socket.closed = false;
      socket.bind = (port, address) => {
        socket.boundTo = { port, address };
        setTimeout(() => socket.emit('listening'), 0);
      };
      socket.send = (buffer, port, address, callback) => {
        socket.sent.push({ buffer, port, address });
        setTimeout(() => callback(), 0);
      };
      socket.close = (callback) => {
        socket.closed = true;
        setTimeout(() => {
          socket.emit('close');
          if (callback) callback();
        }, 0);
      };
      socket.setSendBufferSize = () => {};
      socket.address = () => socket.boundTo || {};
      // Inject an inbound datagram, as though a peer sent it.
      socket.receive = (buffer, rinfo) => socket.emit('message', buffer, rinfo);
      sockets.push(socket);
      return socket;
    },
  };
  return { module, sockets };
}

/**
 * A JSON wire. `serialize` folds the outbound message and its context into a
 * buffer; `decode` parses an inbound datagram buffer back into DecodedFrame(s).
 * Tests build inbound datagrams with {@link frameBuffer}.
 *
 * @returns {{serialize: Function, decode: Function}}
 */
function fakeWire() {
  return {
    serialize(message, ctx) {
      return Buffer.from(
        JSON.stringify({
          name: message.name,
          sysid: ctx.sysid,
          compid: ctx.compid,
          seq: ctx.seq,
          sign: !!ctx.sign,
          timestamp: ctx.timestamp,
          fields: message.fields,
        })
      );
    },
    decode(buffer) {
      const parsed = JSON.parse(buffer.toString());
      return Array.isArray(parsed) ? parsed : [parsed];
    },
  };
}

/**
 * Build an inbound datagram buffer carrying one DecodedFrame, with signing
 * fields defaulted to an unsigned frame.
 *
 * @param {object} frame  partial DecodedFrame ({ name, sysid, compid, fields })
 * @returns {Buffer}
 */
function frameBuffer(frame) {
  return Buffer.from(
    JSON.stringify({
      signaturePresent: false,
      signatureValid: false,
      linkId: null,
      timestamp: null,
      fields: {},
      ...frame,
    })
  );
}

/**
 * Interval stubs that never fire on their own (tests drive `tick()` / `sweep()`
 * explicitly) but record how many were cleared, so teardown is assertable.
 *
 * @returns {{setInterval: Function, clearInterval: Function, cleared: () => number, active: () => number}}
 */
function fakeTimers() {
  let created = 0;
  let cleared = 0;
  return {
    setInterval() {
      created += 1;
      return { unref() {} };
    },
    clearInterval() {
      cleared += 1;
    },
    cleared: () => cleared,
    active: () => created - cleared,
  };
}

/**
 * A controllable clock.
 *
 * @param {number} [start]
 * @returns {{now: () => number, set: (t: number) => void, advance: (dt: number) => void}}
 */
function fakeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    set: (value) => {
      t = value;
    },
    advance: (dt) => {
      t += dt;
    },
  };
}

module.exports = { mockDgram, fakeWire, frameBuffer, fakeTimers, fakeClock };
