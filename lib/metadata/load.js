'use strict';

/**
 * Failure-tolerant load of the metadata package (DESIGN.md §6).
 *
 * Palette nodes must still register when `mavlink-mappings` is missing; catalog
 * routes then answer 503 until dependencies are installed. One require path,
 * one optional RED.log line — not a try/catch pasted into every node.
 *
 * @param {string} logLabel  e.g. `mavlink-command`
 * @param {object} [RED]     Node-RED runtime (for RED.log)
 * @returns {{ api: object|null, error: Error|null }}
 */
function loadMetadata(logLabel, RED) {
  try {
    return { api: require('./index'), error: null };
  } catch (err) {
    if (RED && RED.log && typeof RED.log.error === 'function') {
      RED.log.error(`[${logLabel}] catalog unavailable: ${err.message}`);
    }
    return { api: null, error: err };
  }
}

module.exports = { loadMetadata };
