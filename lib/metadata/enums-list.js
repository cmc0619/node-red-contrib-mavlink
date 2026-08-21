'use strict';

/**
 * Editor-facing MAVLink enum catalog (DESIGN.md §6).
 *
 * Shared dropdown source for config/palette editors that need dialect enum
 * entries outside a message or command catalog.
 */

const { loadBundled } = require('./bundled');
const { resolveBundledDialect, mapEnumEntries } = require('./commands-list');

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
 * @param {string[]|string|undefined|null} names
 * @returns {string[]}
 */
function enumNames(names) {
  const selected = new Set(DEFAULT_ENUM_NAMES);
  const list = Array.isArray(names) ? names : String(names || '').split(',');
  for (const name of list) {
    const trimmed = String(name || '').trim();
    if (trimmed) selected.add(trimmed);
  }
  return Array.from(selected);
}

/**
 * @param {object} bundle  {@link DialectBundle}
 * @param {string} [dialectName]
 * @param {string[]|string} [names]
 * @returns {{dialect: string, enums: Object<string, object[]>}}
 */
function catalogEnumsFromBundle(bundle, dialectName, names) {
  const dialect = dialectName || (bundle && bundle.dialect) || 'unknown';
  const enums = {};

  for (const enumName of enumNames(names)) {
    const table = bundle.enums[enumName];
    if (!table || !Array.isArray(table.entries)) continue;
    enums[enumName] = mapEnumEntries(table);
  }

  return { dialect, enums };
}

/**
 * Full enum catalog for one bundled dialect.
 *
 * @param {string} dialect
 * @param {string[]|string} [names]
 * @returns {{dialect: string, enums: Object<string, object[]>}}
 */
function listEnumsCatalog(dialect, names) {
  const name = resolveBundledDialect(dialect);
  return catalogEnumsFromBundle(loadBundled(name), name, names);
}

module.exports = {
  DEFAULT_ENUM_NAMES,
  catalogEnumsFromBundle,
  listEnumsCatalog,
};
