'use strict';

/**
 * Editor-facing MAVLink message catalog (DESIGN.md §6).
 *
 * Build enumerates every message in the selected dialect as a dropdown and
 * reshapes the field form from the chosen message metadata. Enum-typed fields
 * carry their referenced enum table so the editor can render dropdowns rather
 * than raw integers.
 */

const {
  commandLabel,
  mapEnumEntries,
} = require('./commands-list');

/**
 * Build the Build-node message catalog from any DialectBundle (bundled or
 * custom).
 *
 * @param {object} bundle  {@link DialectBundle}
 * @param {string} dialectName
 * @returns {{dialect: string, messages: object[], enums: Object<string, object[]>}}
 */
function catalogMessagesFromBundle(bundle, dialectName) {
  const messages = [];
  const enumsUsed = new Set();

  for (const msg of Object.values(bundle.messages)) {
    for (const f of msg.fields) {
      if (f.enum) enumsUsed.add(f.enum);
    }
    messages.push({
      name: msg.name,
      id: msg.id,
      label: commandLabel(msg.name, msg.id),
      description: msg.description,
      fields: msg.fields,
    });
  }

  messages.sort((a, b) => a.id - b.id || a.name.localeCompare(b.name));

  /** @type {Object<string, Array<{name:string,value:number|string,label:string,description:string|null}>>} */
  const enums = {};
  for (const enumName of enumsUsed) {
    enums[enumName] = mapEnumEntries(bundle.enums[enumName]);
  }

  return { dialect: dialectName, messages, enums };
}

module.exports = {
  catalogMessagesFromBundle,
};
