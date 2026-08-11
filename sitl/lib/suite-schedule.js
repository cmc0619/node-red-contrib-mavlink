'use strict';

/**
 * Selective SITL fleet restart + suite run order.
 *
 * Examples are numbered to match run order: none → ap-* → px4-* → ap-fleet → fleet.
 * `restart` names a container set that must be cold before the example runs.
 * `none` skips docker restart (params/companion/payload that do not need AGL reset).
 *
 * Override: SITL_RESTART=fleet forces a full fleet restart every example.
 */

const AP_FLEET = ['nrc-ap-1', 'nrc-ap-2', 'nrc-ap-3', 'nrc-ap-4', 'nrc-ap-5'];
const PX4_FLEET = [
  'nrc-px4-11',
  'nrc-px4-12',
  'nrc-px4-13',
  'nrc-px4-14',
  'nrc-px4-15',
];
const ALL_VEHICLES = [
  ...AP_FLEET,
  ...PX4_FLEET,
  'nrc-ap-companion-20',
  'nrc-px4-companion-21',
  'nrc-ap-payload-31',
];

/** @type {Record<string, string[]>} */
const RESTART_SETS = {
  none: [],
  'ap-1': ['nrc-ap-1'],
  'ap-2': ['nrc-ap-2'],
  'ap-12': ['nrc-ap-1', 'nrc-ap-2'],
  'ap-fleet': [...AP_FLEET],
  'px4-1': ['nrc-px4-11'],
  fleet: [...ALL_VEHICLES],
};

/**
 * @param {string} [restart]
 * @param {{ forceFleet?: boolean }} [opts]
 * @returns {string[]}
 */
function containersForRestart(restart, opts = {}) {
  if (opts.forceFleet || process.env.SITL_RESTART === 'fleet') {
    return [...RESTART_SETS.fleet];
  }
  const key = restart && Object.prototype.hasOwnProperty.call(RESTART_SETS, restart)
    ? restart
    : 'fleet';
  return [...RESTART_SETS[key]];
}

/**
 * PX4 lab helpers apply only to PX4 containers in the restart set (or none).
 * @param {string[]} containers
 * @returns {string[]}
 */
function px4ContainersIn(containers) {
  const set = new Set(containers);
  return PX4_FLEET.filter((c) => set.has(c));
}

module.exports = {
  ALL_VEHICLES,
  AP_FLEET,
  PX4_FLEET,
  RESTART_SETS,
  containersForRestart,
  px4ContainersIn,
};
