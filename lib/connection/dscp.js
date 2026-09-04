'use strict';

/**
 * Optional DSCP/TOS marking for IP transports (DESIGN.md §7).
 *
 * Node does not expose `setsockopt(IP_TOS/IPV6_TCLASS)` on `dgram` or `net`
 * sockets, so marking rides the optional `sockopt` package, lazy-loaded on the
 * first real mark attempt. Without it, sends continue unmarked and the queue
 * behaviour is unchanged. The warning is emitted once per process through the
 * provided Node-RED logger; nothing downstream depends on the mark being
 * honoured.
 */

const IPPROTO_IP = 0;
const IP_TOS = 1;
const IPPROTO_IPV6 = 41;
const IPV6_TCLASS = 67;

let sockoptLoaded = false;
let sockopt = null;
let warned = false;

/**
 * Last TOS byte successfully applied, per socket. The pump marks before every
 * frame, so an unchanged value must not cost a setsockopt syscall each time.
 * Only success populates it: unavailable/failed backends keep their exact
 * per-call soft-fail behaviour, and a replaced socket simply misses here.
 *
 * @type {WeakMap<object, number>}
 */
const appliedTos = new WeakMap();

/**
 * Best-effort mark of a live IP socket. Returns false when marking is
 * unavailable or fails; callers must still send the packet.
 *
 * @param {object} socket  a `dgram.Socket` or `net.Socket`
 * @param {number} dscp  six-bit DSCP value
 * @param {object} [options]
 * @param {'ipv4'|'ipv6'|'IPv4'|'IPv6'|string} [options.family]
 * @param {object} [options.logger]  optional Node-RED-style logger
 * @param {Function|false} [options.marker]  test hook receiving (socket, tos, options)
 * @returns {boolean}
 */
function markSocket(socket, dscp, options = {}) {
  // The six-bit DSCP class shifted into the TOS / Traffic Class byte. `dscp`
  // has one producer, the table in `lib/connection/bands.js`.
  const tos = dscp * 4;
  if (appliedTos.get(socket) === tos) return true;
  const marker = selectMarker(socket, options);
  if (!marker) {
    warnOnce(options.logger, 'DSCP marking unavailable: no socket TOS backend is installed');
    return false;
  }

  try {
    marker(socket, tos, options);
    appliedTos.set(socket, tos);
    return true;
  } catch (err) {
    // The marker is third-party code; whatever it throws must not escape a
    // best-effort boundary the pump calls with the queue held draining.
    const detail = err && err.message ? err.message : String(err);
    warnOnce(options.logger, `DSCP marking unavailable: ${detail}`);
    return false;
  }
}

/**
 * @param {object} socket
 * @param {object} options
 * @returns {Function|false|null}
 */
function selectMarker(socket, options) {
  if (Object.prototype.hasOwnProperty.call(options, 'marker')) {
    return options.marker;
  }
  return loadSockopt() ? markWithSockopt : null;
}

/**
 * @returns {{setsockopt: Function}|null}
 */
function loadSockopt() {
  if (sockoptLoaded) return sockopt;
  sockoptLoaded = true;
  if (process.platform !== 'linux') return sockopt;
  try {
    sockopt = require('sockopt');
  } catch {
    sockopt = null;
  }
  return sockopt;
}

/**
 * @param {object} socket
 * @param {number} tos
 * @param {object} options
 */
function markWithSockopt(socket, tos, options) {
  const opt = socketOption(options.family);
  // `sockopt` obtains the fd through Node's deprecated socket handle, which
  // logs one deprecation warning per process. A contributed node must not
  // mutate host warning policy (process.noDeprecation) to hide it.
  sockopt.setsockopt(socket, opt.level, opt.option, tos);
}

/**
 * Linux socket option constants for TOS / Traffic Class.
 *
 * @param {string|undefined} family
 * @returns {{level: number, option: number}}
 */
function socketOption(family) {
  if (isIpv6(family)) return { level: IPPROTO_IPV6, option: IPV6_TCLASS };
  return { level: IPPROTO_IP, option: IP_TOS };
}

/**
 * @param {string|undefined} family
 * @returns {boolean}
 */
function isIpv6(family) {
  if (typeof family !== 'string') return false;
  return family.toLowerCase().includes('6');
}

/**
 * @param {object|undefined} logger
 * @param {string} message
 */
function warnOnce(logger, message) {
  if (warned) return;
  warned = true;
  if (logger && typeof logger.warn === 'function') logger.warn(message);
}

module.exports = { markSocket };
