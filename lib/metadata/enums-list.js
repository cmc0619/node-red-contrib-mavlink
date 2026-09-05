'use strict';

/**
 * Editor-facing MAVLink enum catalog (DESIGN.md §6).
 *
 * Shared dropdown source for config/palette editors that need dialect enum
 * entries outside a message or command catalog.
 */

const { mapEnumEntries } = require('./commands-list');

const DEFAULT_ENUM_NAMES = [
  'MAV_TYPE',
  'MAV_AUTOPILOT',
  'MAV_COMPONENT',
  'MAV_STATE',
  'MAV_MODE',
  'SPEED_TYPE',
  'CAMERA_MODE',
  'MAV_MOUNT_MODE',
  'ORBIT_YAW_BEHAVIOUR',
  'MAV_DO_REPOSITION_FLAGS',
];

/**
 * Merge requested enum names into the editor default set.
 *
 * @param {string} names  comma-joined enum names, as the `?names=` query sends them
 * @returns {string[]}
 */
function enumNames(names) {
  const selected = new Set(DEFAULT_ENUM_NAMES);
  for (const name of names.split(',')) selected.add(name);
  return Array.from(selected);
}

/**
 * @param {object} bundle  {@link DialectBundle}
 * @param {string} dialectName
 * @param {string} names  comma-joined enum names
 * @returns {{dialect: string, enums: Object<string, object[]>}}
 */
function catalogEnumsFromBundle(bundle, dialectName, names) {
  const enums = {};

  for (const enumName of enumNames(names)) {
    const table = bundle.enums[enumName];
    if (!table || !Array.isArray(table.entries)) continue;
    enums[enumName] = mapEnumEntries(table);
  }

  return { dialect: dialectName, enums };
}

module.exports = {
  DEFAULT_ENUM_NAMES,
  catalogEnumsFromBundle,
};
