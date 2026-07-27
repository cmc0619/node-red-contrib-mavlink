'use strict';

/**
 * Editor-facing MAV_CMD listings (DESIGN.md §6, §9 Advanced).
 *
 * Advanced mode on the Command node enumerates every `MAV_CMD` in the loaded
 * dialect as a dropdown — never a free-form integer. The list is plain data
 * derived from {@link loadBundled} / a Vehicle Profile's bundle.
 */

const { loadBundled, knownDialects } = require('./bundled');

/**
 * @typedef {object} CommandListEntry
 * @property {string} name   full enum name, e.g. `MAV_CMD_NAV_TAKEOFF`
 * @property {number} value  numeric MAV_CMD id
 * @property {string} label  `NAV_TAKEOFF (22)` — short name + value in parentheses (§6)
 */

/**
 * Resolve a dialect name against the known bundled set. Unknown names are
 * refused rather than interpolated into a load path (§6 editor endpoints).
 *
 * @param {string} dialect
 * @returns {string} a known dialect name
 * @throws {Error} when the name is not in {@link knownDialects}
 */
function resolveBundledDialect(dialect) {
  const name = typeof dialect === 'string' ? dialect.trim() : '';
  const known = knownDialects();
  if (!name || !known.includes(name)) {
    throw new Error(
      `unknown dialect ${JSON.stringify(dialect)}; expected one of: ${known.join(', ')}`
    );
  }
  return name;
}

/**
 * Short label for a MAV_CMD entry: strip the `MAV_CMD_` prefix when present and
 * append the numeric value in parentheses (§6 "Every enumerated entry shows
 * its numeric value in parentheses").
 *
 * @param {string} name
 * @param {number} value
 * @returns {string}
 */
function commandLabel(name, value) {
  const short = name.startsWith('MAV_CMD_') ? name.slice('MAV_CMD_'.length) : name;
  return `${short} (${value})`;
}

/**
 * List every MAV_CMD in a bundled dialect, sorted by numeric value then name.
 *
 * @param {string} dialect  bundled dialect name (allow-listed)
 * @returns {CommandListEntry[]}
 */
function listCommandsForDialect(dialect) {
  const name = resolveBundledDialect(dialect);
  const bundle = loadBundled(name);
  const entries = [];
  for (const cmd of Object.values(bundle.commands || {})) {
    const value = Number(cmd.value);
    if (!Number.isFinite(value)) continue;
    entries.push({
      name: cmd.name,
      value,
      label: commandLabel(cmd.name, value),
    });
  }
  entries.sort((a, b) => a.value - b.value || a.name.localeCompare(b.name));
  return entries;
}

module.exports = {
  resolveBundledDialect,
  commandLabel,
  listCommandsForDialect,
};
