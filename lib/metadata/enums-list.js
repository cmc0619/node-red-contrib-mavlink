'use strict';

/**
 * Editor-facing MAVLink enum catalog (DESIGN.md §6).
 *
 * Shared dropdown source for config/palette editors that need dialect enum
 * entries outside a message or command catalog. Every caller names the tables
 * it reads, and the answer carries exactly those.
 */

const { mapEnumEntries } = require('./commands-list');

/**
 * @param {object} bundle  {@link DialectBundle}
 * @param {string} dialectName
 * @param {string} names  comma-joined enum names, as the `?names=` query sends them
 * @returns {{dialect: string, enums: Object<string, object[]>}}
 */
function catalogEnumsFromBundle(bundle, dialectName, names) {
  const enums = {};

  for (const enumName of names.split(',')) {
    const table = bundle.enums[enumName];
    if (!table || !Array.isArray(table.entries)) continue;
    enums[enumName] = mapEnumEntries(table);
  }

  return { dialect: dialectName, enums };
}

module.exports = {
  catalogEnumsFromBundle,
};
