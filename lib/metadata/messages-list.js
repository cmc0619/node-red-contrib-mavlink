'use strict';

/**
 * Editor-facing MAVLink message catalog (DESIGN.md §6).
 *
 * Build enumerates every message in the selected dialect as a dropdown and
 * reshapes the field form from the chosen message metadata. Enum-typed fields
 * carry their referenced enum table so the editor can render dropdowns rather
 * than raw integers.
 */

const { loadBundled } = require('./bundled');
const { resolveBundledDialect, enumOptionLabel } = require('./commands-list');

/**
 * @param {string} name
 * @param {number} id
 * @returns {string}
 */
function messageLabel(name, id) {
  return `${name} (${id})`;
}

/**
 * Build the Build-node message catalog from any DialectBundle (bundled or
 * custom).
 *
 * @param {object} bundle  {@link DialectBundle}
 * @param {string} [dialectName]
 * @returns {{dialect: string, messages: object[], enums: Object<string, object[]>}}
 */
function catalogMessagesFromBundle(bundle, dialectName) {
  const dialect = dialectName || (bundle && bundle.dialect) || 'unknown';
  const messages = [];
  const enumsUsed = new Set();

  for (const msg of Object.values((bundle && bundle.messages) || {})) {
    const id = Number(msg.id);
    if (!Number.isFinite(id)) continue;

    const fields = [];
    for (const f of msg.fields || []) {
      if (f.enum) enumsUsed.add(f.enum);
      fields.push({
        name: f.name,
        type: f.type,
        arrayLength: f.arrayLength == null ? null : f.arrayLength,
        extension: !!f.extension,
        enum: f.enum || null,
        display: f.display || null,
        units: f.units || null,
        minValue: f.minValue == null ? null : f.minValue,
        maxValue: f.maxValue == null ? null : f.maxValue,
        increment: f.increment == null ? null : f.increment,
        description: f.description || null,
        invalid: f.invalid == null ? null : f.invalid,
      });
    }

    messages.push({
      name: msg.name,
      id,
      label: messageLabel(msg.name, id),
      description: msg.description || null,
      fields,
    });
  }

  messages.sort((a, b) => a.id - b.id || a.name.localeCompare(b.name));

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

  return { dialect, messages, enums };
}

/**
 * Full message catalog for one bundled dialect.
 *
 * @param {string} dialect
 * @returns {{dialect: string, messages: object[], enums: Object<string, object[]>}}
 */
function listMessagesCatalog(dialect) {
  const name = resolveBundledDialect(dialect);
  return catalogMessagesFromBundle(loadBundled(name), name);
}

module.exports = {
  messageLabel,
  catalogMessagesFromBundle,
  listMessagesCatalog,
};
