'use strict';

const mappings = require('mavlink-mappings');
const { camelToScreaming, fullEntryName, accessorToLabel, isBitmaskEnum } = require('./naming');
const { parseModuleDts } = require('./dts');
const { paramEnumHint } = require('./hints');

/**
 * Load bundled MAVLink dialects from the `mavlink-mappings` registry into the
 * shared {@link DialectBundle} shape (DESIGN.md §4, §14).
 *
 * The package keeps each XML file's own messages/enums in a separate module, so
 * a dialect is assembled by merging its include chain in dependency order
 * (`minimal` -> `standard` -> `common` -> …). The compiled JS drops the
 * field->enum association and every description; both are recovered offline from
 * the package's shipped `.d.ts` declarations (see `./dts`). Command-param enum
 * links, which the `.d.ts` also drops, come from the small control-hint table
 * (`./hints`). No dialect XML is ever vendored or fetched for the bundled path.
 */

/**
 * Include chains per bundled dialect, dependency-first with the entry last.
 * Message ids and enum names are globally unique across MAVLink, so merge order
 * within a chain is not load-bearing; the chains mirror the XML `<include>`
 * graph so `files` reads as the real dependency order. Every dialect but the
 * self-contained ones layers on `common` -> `standard` -> `minimal`; `icarous`
 * and the rest that define their own base still resolve here because the chain
 * is explicit rather than assumed (§4: never assume a dialect includes common).
 *
 * @type {Object<string, string[]>}
 */
const DIALECT_CHAINS = {
  minimal: ['minimal'],
  standard: ['minimal', 'standard'],
  common: ['minimal', 'standard', 'common'],
  ardupilotmega: ['minimal', 'standard', 'common', 'ardupilotmega'],
  uavionix: ['minimal', 'standard', 'common', 'uavionix'],
  icarous: ['minimal', 'standard', 'common', 'icarous'],
  asluav: ['minimal', 'standard', 'common', 'asluav'],
  development: ['minimal', 'standard', 'common', 'development'],
  ualberta: ['minimal', 'standard', 'common', 'ualberta'],
  storm32: ['minimal', 'standard', 'common', 'storm32'],
};

/** @type {Map<string, import('./index').DialectBundle>} memoized per dialect */
const cache = new Map();

/**
 * The bundled dialect names this loader can serve.
 *
 * @returns {string[]}
 */
function knownDialects() {
  return Object.keys(DIALECT_CHAINS);
}

/**
 * True when a compiled `mavlink-mappings` export is an enum object (carries at
 * least one reverse numeric-keyed mapping).
 *
 * @param {*} value
 * @returns {boolean}
 */
function isEnumObject(value) {
  if (!value || typeof value !== 'object') {
    return false;
  }
  for (const key of Object.keys(value)) {
    if (/^\d+$/.test(key) && typeof value[key] === 'string') {
      return true;
    }
  }
  return false;
}

/**
 * Load a bundled dialect as a {@link DialectBundle}. Memoized — a bundle is
 * immutable once built and a profile loads its dialect on every deploy. An
 * unknown dialect fails loud, naming the available set; there is no silent
 * fallback to `common` (§4).
 *
 * @param {string} name  bundled dialect name (e.g. `ardupilotmega`)
 * @returns {import('./index').DialectBundle}
 */
function loadBundled(name) {
  if (cache.has(name)) {
    return cache.get(name);
  }
  const chain = DIALECT_CHAINS[name];
  if (!chain) {
    throw new Error(
      `Unknown bundled dialect '${name}'. Available: ${knownDialects().join(', ')}.`
    );
  }
  const modules = chain.map((moduleName) => {
    const mod = mappings[moduleName];
    if (!mod) {
      throw new Error(`Bundled dialect module '${moduleName}' is missing from mavlink-mappings.`);
    }
    return mod;
  });

  const docs = mergeChainDocs(chain);
  const enums = buildEnums(modules, docs);
  const { messages, messagesById } = buildMessages(modules, enums, docs);
  const commands = buildCommands(modules, enums, docs);

  const bundle = {
    dialect: name,
    version: null,
    files: chain.slice(),
    fetched: null,
    enums,
    messages,
    messagesById,
    commands,
    overrides: [],
  };
  cache.set(name, bundle);
  return bundle;
}

/**
 * Merge the parsed `.d.ts` tables across a dialect's include chain. Enum member
 * docs merge per enum (an enum such as `MavCmd` is re-declared by each module
 * that extends it); classes and commands take the last module's declaration on
 * a name collision, matching include order.
 *
 * @param {string[]} chain  module names in include order
 * @returns {{classes: object, enums: object, commands: object}}
 */
function mergeChainDocs(chain) {
  const classes = {};
  const commands = {};
  const enums = {};
  for (const moduleName of chain) {
    const parsed = parseModuleDts(moduleName);
    Object.assign(classes, parsed.classes);
    Object.assign(commands, parsed.commands);
    for (const [enumName, doc] of Object.entries(parsed.enums)) {
      const target = enums[enumName] || (enums[enumName] = { description: null, members: {} });
      if (doc.description) {
        target.description = doc.description;
      }
      for (const [member, text] of Object.entries(doc.members)) {
        if (!(member in target.members) || (text && !target.members[member])) {
          target.members[member] = text;
        }
      }
    }
  }
  return { classes, enums, commands };
}

/**
 * Assemble the merged enum table. An enum split across modules (base members in
 * `common`, more in `ardupilotmega`) is merged first-value-wins. Keys are the
 * SCREAMING XML names; entry names are the full form (`MAV_TYPE_QUADROTOR`).
 *
 * @param {object[]} modules  registry modules in include order
 * @param {object} docs  merged `.d.ts` tables
 * @returns {Object<string, object>} SCREAMING name -> Enum
 */
function buildEnums(modules, docs) {
  /** @type {Map<string, {classNames:Set<string>, members:Map<string, {value:number|string, description:string|null}>}>} */
  const byScreaming = new Map();

  for (const mod of modules) {
    for (const [exportName, value] of Object.entries(mod)) {
      if (!isEnumObject(value)) {
        continue;
      }
      const screaming = camelToScreaming(exportName);
      let target = byScreaming.get(screaming);
      if (!target) {
        target = { classNames: new Set(), members: new Map() };
        byScreaming.set(screaming, target);
      }
      target.classNames.add(exportName);
      const memberDocs = (docs.enums[exportName] && docs.enums[exportName].members) || {};
      for (const [key, num] of Object.entries(value)) {
        if (/^\d+$/.test(key) || typeof num !== 'number') {
          continue;
        }
        if (target.members.has(key)) {
          continue;
        }
        target.members.set(key, { value: num, description: memberDocs[key] || null });
      }
    }
  }

  const enums = {};
  for (const [screaming, target] of byScreaming.entries()) {
    const entries = [...target.members.entries()]
      .map(([key, m]) => ({ name: fullEntryName(screaming, key), value: m.value, description: m.description }))
      .sort((a, b) => Number(a.value) - Number(b.value));
    let description = null;
    for (const className of target.classNames) {
      if (docs.enums[className] && docs.enums[className].description) {
        description = docs.enums[className].description;
      }
    }
    enums[screaming] = {
      name: screaming,
      bitmask: isBitmaskEnum(entries.map((e) => e.value), screaming),
      description,
      entries,
    };
  }
  return enums;
}

/**
 * Normalize a registry `MavLinkPacketField` type to the bundle scalar type.
 *
 * @param {string} type  e.g. `uint8_t`, `char[]`, `uint8_t_mavlink_version`
 * @returns {string}
 */
function normalizeType(type) {
  const base = String(type).replace(/\[\]$/, '');
  return base === 'uint8_t_mavlink_version' ? 'uint8_t' : base;
}

/**
 * Assemble the message table and the id->name index from the registry, filling
 * each field's backing enum and descriptions from the merged `.d.ts` tables.
 *
 * @param {object[]} modules
 * @param {Object<string, object>} enums  assembled enums (for bitmask display)
 * @param {object} docs
 * @returns {{messages: object, messagesById: object}}
 */
function buildMessages(modules, enums, docs) {
  const messages = {};
  const messagesById = {};
  for (const mod of modules) {
    if (!mod.REGISTRY) {
      continue;
    }
    for (const clazz of Object.values(mod.REGISTRY)) {
      const classDoc = docs.classes[clazz.name] || { description: null, fields: {} };
      const fields = clazz.FIELDS.map((field) => {
        const fieldDoc = classDoc.fields[field.name] || {};
        const enumName = fieldDoc.enumClass ? camelToScreaming(fieldDoc.enumClass) : null;
        const isBitmask = enumName !== null && enums[enumName] && enums[enumName].bitmask;
        return {
          name: field.source,
          type: normalizeType(field.type),
          arrayLength: field.length > 0 ? field.length : null,
          extension: Boolean(field.extension),
          enum: enumName,
          display: isBitmask ? 'bitmask' : null,
          units: field.units || null,
          invalid: null,
          minValue: null,
          maxValue: null,
          increment: null,
          description: fieldDoc.description || null,
        };
      });
      messages[clazz.MSG_NAME] = {
        id: clazz.MSG_ID,
        name: clazz.MSG_NAME,
        description: classDoc.description,
        fields,
      };
      messagesById[String(clazz.MSG_ID)] = clazz.MSG_NAME;
    }
  }
  return { messages, messagesById };
}

/**
 * Resolve which `param1..param7` slot a generated command accessor writes, by
 * setting it on a fresh instance and observing which private slot changed.
 * Returns null when the accessor is not param-backed.
 *
 * @param {Function} CmdClass  generated command class
 * @param {string} accessor  accessor name (e.g. `speedType`)
 * @returns {number|null} 1..7 or null
 */
function resolveParamIndex(CmdClass, accessor) {
  const inst = new CmdClass();
  const marker = -987654321;
  inst[accessor] = marker;
  for (let i = 1; i <= 7; i += 1) {
    if (inst[`_param${i}`] === marker) {
      return i;
    }
  }
  return null;
}

/**
 * Assemble the MAV_CMD command view. Command labels/units/ranges/descriptions
 * come from the generated command classes' `.d.ts`; param->enum links come from
 * the control-hint table (§4). Empty when the dialect has no MAV_CMD enum.
 *
 * @param {object[]} modules
 * @param {Object<string, object>} enums
 * @param {object} docs
 * @returns {Object<string, object>}
 */
function buildCommands(modules, enums, docs) {
  const mavCmd = enums.MAV_CMD;
  if (!mavCmd) {
    return {};
  }
  const cmdClassByValue = {};
  for (const mod of modules) {
    if (!mod.COMMANDS) {
      continue;
    }
    for (const [value, cmdClass] of Object.entries(mod.COMMANDS)) {
      cmdClassByValue[Number(value)] = cmdClass;
    }
  }

  const commands = {};
  for (const entry of mavCmd.entries) {
    const value = Number(entry.value);
    const cmdClass = cmdClassByValue[value];
    const cmdDoc = cmdClass ? docs.commands[cmdClass.name] : null;
    const params = [];
    if (cmdClass && cmdDoc) {
      for (const [accessor, doc] of Object.entries(cmdDoc.accessors)) {
        const index = resolveParamIndex(cmdClass, accessor);
        if (!index) {
          continue;
        }
        params.push({
          index,
          label: accessorToLabel(accessor),
          description: doc.description,
          units: doc.units,
          enum: paramEnumHint(entry.name, index),
          minValue: doc.min,
          maxValue: doc.max,
          increment: doc.increment,
          reserved: false,
          default: null,
        });
      }
      params.sort((a, b) => a.index - b.index);
    }
    commands[entry.name] = {
      name: entry.name,
      value,
      description: (cmdDoc && cmdDoc.description) || entry.description,
      hasLocation: cmdDoc ? cmdDoc.hasLocation : null,
      isDestination: cmdDoc ? cmdDoc.isDestination : null,
      params,
    };
  }
  return commands;
}

module.exports = { DIALECT_CHAINS, knownDialects, loadBundled };
