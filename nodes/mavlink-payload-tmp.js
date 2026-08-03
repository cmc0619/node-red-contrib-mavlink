'use strict';

/**
 * THROWAWAY — delete this file, its .html, and the package.json entry once the
 * Payload dialog design is settled.
 *
 * Two editor designs for the same node, side by side on one canvas:
 *
 *   mavlink-payload-tmp1  Topic → Verb → Gimbal path, three cascading selects
 *                         (the shipped picker), with the form body generated
 *                         from the recipe + dialect.
 *   mavlink-payload-tmp2  One grouped Action select, same generated body.
 *
 * The picker is the only difference. Both share the shipped runtime, so
 * whichever wins can be lifted into `mavlink-payload.html` unchanged.
 */

const registerMavlinkPayload = require('./mavlink-payload');

/** Generated rows are per-verb, so the editor saves one object, not 30 fields. */
const readValues = (config) => config.values || {};

module.exports = function registerMavlinkPayloadTmp(RED) {
  registerMavlinkPayload(RED, { type: 'mavlink-payload-tmp1', readValues });
  registerMavlinkPayload(RED, { type: 'mavlink-payload-tmp2', readValues });
};
