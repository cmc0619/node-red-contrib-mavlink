'use strict';

/**
 * Editor-facing MAV_CMD catalog (DESIGN.md §6, §9 Advanced).
 *
 * Advanced mode on the Command node enumerates every `MAV_CMD` in the loaded
 * dialect as a dropdown — never a free-form integer — and reshapes the form
 * to that command's named params under the §6 rendering rules (no raw
 * numbered param grid; `enum=` → dropdown; reserved / Empty hidden).
 */

const { loadBundled, knownDialects } = require('./bundled');

/**
 * Resolve a dialect name against the known bundled set. Unknown names are
 * refused rather than interpolated into a load path (§6 editor endpoints).
 *
 * @param {string} dialect
 * @returns {string}
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
 * @param {string} name
 * @param {number} value
 * @returns {string}
 */
function commandLabel(name, value) {
  const short = name.startsWith('MAV_CMD_') ? name.slice('MAV_CMD_'.length) : name;
  return `${short} (${value})`;
}

/**
 * §6 four-case rule — cases 1 and 2 hide the field.
 *
 * @param {{reserved?: boolean, description?: string|null}} param
 * @returns {boolean}
 */
function isHiddenParam(param) {
  if (param && param.reserved) return true;
  const d = param && param.description != null ? String(param.description).trim() : '';
  return d === 'Empty' || d === 'Empty.' || d === 'Reserved';
}

/**
 * @param {{name: string, value: number|string, description?: string|null}} entry
 * @returns {string}
 */
function enumOptionLabel(entry) {
  let text = entry.description && String(entry.description).trim()
    ? String(entry.description).trim()
    : entry.name;
  const cut = text.search(/[.\n]/);
  if (cut > 0 && cut < 60) text = text.slice(0, cut);
  if (text.length > 48) text = `${text.slice(0, 47)}\u2026`;
  return `${text} (${entry.value})`;
}

/**
 * Build the Advanced catalog from any DialectBundle (bundled or custom).
 *
 * @param {object} bundle  {@link DialectBundle}
 * @param {string} [dialectName]
 * @returns {{dialect: string, commands: object[], enums: Object<string, object[]>}}
 */
function catalogFromBundle(bundle, dialectName) {
  const dialect = dialectName || (bundle && bundle.dialect) || 'unknown';
  const commands = [];
  const enumsUsed = new Set();

  for (const cmd of Object.values((bundle && bundle.commands) || {})) {
    const value = Number(cmd.value);
    if (!Number.isFinite(value)) continue;

    const params = [];
    for (const p of cmd.params || []) {
      if (p.enum) enumsUsed.add(p.enum);
      params.push({
        index: p.index,
        label: p.label,
        description: p.description,
        units: p.units,
        enum: p.enum,
        minValue: p.minValue,
        maxValue: p.maxValue,
        increment: p.increment,
        reserved: !!p.reserved,
        hidden: isHiddenParam(p),
        default: p.default,
      });
    }

    commands.push({
      name: cmd.name,
      value,
      label: commandLabel(cmd.name, value),
      description: cmd.description || null,
      params,
    });
  }

  commands.sort((a, b) => a.value - b.value || a.name.localeCompare(b.name));

  /** @type {Object<string, Array<{name:string,value:number,label:string}>>} */
  const enums = {};
  for (const enumName of enumsUsed) {
    const table = bundle.enums[enumName];
    if (!table || !Array.isArray(table.entries)) continue;
    enums[enumName] = table.entries.map((entry) => ({
      name: entry.name,
      value: Number(entry.value),
      label: enumOptionLabel(entry),
    }));
  }

  return { dialect, commands, enums };
}

/**
 * Full Advanced-mode catalog for one bundled dialect.
 *
 * @param {string} dialect
 * @returns {{dialect: string, commands: object[], enums: Object<string, object[]>}}
 */
function listCommandsCatalog(dialect) {
  const name = resolveBundledDialect(dialect);
  return catalogFromBundle(loadBundled(name), name);
}

/**
 * @param {string} dialect
 * @returns {object[]}
 */
function listCommandsForDialect(dialect) {
  return listCommandsCatalog(dialect).commands;
}

module.exports = {
  resolveBundledDialect,
  commandLabel,
  enumOptionLabel,
  isHiddenParam,
  catalogFromBundle,
  listCommandsCatalog,
  listCommandsForDialect,
};
