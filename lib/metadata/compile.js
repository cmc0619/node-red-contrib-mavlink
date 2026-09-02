'use strict';

const { XMLParser, XMLValidator } = require('fast-xml-parser');

/**
 * The custom-dialect XML compiler (DESIGN.md §4). Pure and synchronous: it
 * takes a map of file name -> XML string and an entry file name, and returns a
 * {@link DialectBundle} (see `/tmp/briefs/bundle-shape.md`). It touches no
 * filesystem and resolves nothing against the bundled definitions — the user
 * supplies every file the include graph references (§4).
 *
 * Dialect XML is the authority, not arbitrary input, so its *content* is not
 * validated (§2). What is enforced is that the input is a coherent compile
 * unit: each string parses as XML with a `<mavlink>` root, every `<include>`
 * resolves, the include graph is acyclic, and no two files claim the same
 * message id for different messages. A same-named message redefined nearer the
 * entry is an override, recorded and resolved by include order — never a
 * failure (§4).
 */

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
  parseTagValue: false,
});

/**
 * The tag name of an order-preserved node (the single key that is not the
 * `:@` attribute bag).
 *
 * @param {object} node
 * @returns {string|undefined}
 */
function tagOf(node) {
  return Object.keys(node).find((k) => k !== ':@');
}

/**
 * The child-node array of an order-preserved node.
 *
 * @param {object} node
 * @returns {object[]}
 */
function childrenOf(node) {
  const tag = tagOf(node);
  return tag ? node[tag] : [];
}

/**
 * The attribute bag of an order-preserved node, `@_`-prefixed.
 *
 * @param {object} node
 * @returns {Object<string, string>}
 */
function attrsOf(node) {
  return node[':@'] || {};
}

/**
 * Concatenated text content of a node's direct `#text` children.
 *
 * @param {object} node
 * @returns {string}
 */
function textOf(node) {
  return childrenOf(node)
    .filter((c) => typeof c['#text'] === 'string')
    .map((c) => c['#text'])
    .join('')
    .trim();
}

/**
 * Parse a MAVLink integer literal (decimal, hex `0x…`, or `2**n`) exactly.
 * Values outside the safe-integer range are returned as a decimal string per
 * the bundle contract; smaller values as numbers.
 *
 * @param {string} raw
 * @returns {number|string}
 */
function parseIntLiteral(raw) {
  let big;
  if (/^[+-]?0x[0-9a-f]+$/i.test(raw)) {
    // BigInt rejects a leading '-' on hex (`-0x2`); strip the sign and negate.
    const negative = raw.startsWith('-');
    const hex = raw.replace(/^[+-]/, '');
    big = negative ? -BigInt(hex) : BigInt(hex);
  } else if (/^2\s*\*\*\s*\d+$/.test(raw)) {
    big = 2n ** BigInt(raw.replace(/^2\s*\*\*\s*/, ''));
  } else {
    big = BigInt(raw);
  }
  if (big <= BigInt(Number.MAX_SAFE_INTEGER) && big >= BigInt(Number.MIN_SAFE_INTEGER)) {
    return Number(big);
  }
  return big.toString();
}

/**
 * Optional numeric attribute as a number, or null when absent.
 *
 * @param {Object<string, string>} attrs
 * @param {string} key  `@_`-prefixed attribute name
 * @returns {number|null}
 */
function numAttr(attrs, key) {
  if (attrs[key] === undefined) {
    return null;
  }
  return Number(attrs[key]);
}

/**
 * Split a MAVLink field type into a scalar type and array length. `char[10]`
 * -> `{ type: 'char', arrayLength: 10 }`; `uint8_t_mavlink_version` normalizes
 * to `uint8_t`; a scalar carries `arrayLength: null`.
 *
 * @param {string} raw
 * @returns {{type: string, arrayLength: number|null}}
 */
function splitType(raw) {
  const match = raw.match(/^(.*?)\[(\d+)\]$/);
  let type = match ? match[1] : raw;
  const arrayLength = match ? Number(match[2]) : null;
  if (type === 'uint8_t_mavlink_version') {
    type = 'uint8_t';
  }
  return { type, arrayLength };
}

/**
 * @typedef {object} ParsedParam
 * @property {number} index
 * @property {string|undefined} label
 * @property {string} description
 * @property {string|undefined} units
 * @property {string|undefined} enum
 * @property {number|null} minValue
 * @property {number|null} maxValue
 * @property {number|null} increment
 * @property {boolean} reserved
 * @property {string|undefined} default
 */

/**
 * @typedef {object} ParsedEntry
 * @property {string} name
 * @property {number|string} value
 * @property {string|null} description
 * @property {boolean|null} hasLocation
 * @property {boolean|null} isDestination
 * @property {ParsedParam[]} params
 */

/**
 * @typedef {object} ParsedEnum
 * @property {string} name
 * @property {boolean} bitmask
 * @property {string|null} description
 * @property {ParsedEntry[]} entries
 */

/**
 * @typedef {object} ParsedField
 * @property {string} name
 * @property {string} type
 * @property {number|null} arrayLength
 * @property {boolean} extension
 * @property {string|undefined} enum
 * @property {string|undefined} display
 * @property {string|undefined} units
 * @property {string|undefined} invalid
 * @property {number|null} minValue
 * @property {number|null} maxValue
 * @property {number|null} increment
 * @property {string} description
 */

/**
 * @typedef {object} ParsedMessage
 * @property {number} id
 * @property {string} name
 * @property {string|null} description
 * @property {ParsedField[]} fields
 */

/**
 * @typedef {object} ParsedFile
 * @property {string[]} includes
 * @property {number|null} version
 * @property {ParsedEnum[]} enums
 * @property {ParsedMessage[]} messages
 */

/**
 * Parse one dialect XML file into its includes, version, enums, and messages.
 * A file that is not XML, or lacks a `<mavlink>` root, fails loud naming the
 * file — a compiler reporting it could not compile, not a content guard (§2).
 *
 * @param {string} fileName  for error messages
 * @param {string} xml  file contents
 * @returns {ParsedFile}
 */
function parseFile(fileName, xml) {
  const valid = XMLValidator.validate(xml);
  if (valid !== true) {
    const reason = valid.err.msg;
    throw new Error(`Dialect file '${fileName}' could not be parsed: ${reason}.`);
  }
  const root = parser.parse(xml).find((n) => tagOf(n) === 'mavlink');
  if (!root) {
    throw new Error(`Dialect file '${fileName}' has no <mavlink> root element.`);
  }

  const out = { includes: [], version: null, enums: [], messages: [] };
  for (const node of childrenOf(root)) {
    const tag = tagOf(node);
    switch (tag) {
      case 'include':
        out.includes.push(textOf(node));
        break;
      case 'version':
        out.version = Number(textOf(node));
        break;
      case 'enums': {
        for (const enumNode of childrenOf(node)) {
          if (tagOf(enumNode) === 'enum') {
            out.enums.push(parseEnum(enumNode));
          }
        }
        break;
      }
      case 'messages': {
        for (const msgNode of childrenOf(node)) {
          if (tagOf(msgNode) === 'message') {
            out.messages.push(parseMessage(msgNode));
          }
        }
        break;
      }
      default:
        break; // This space intentionally left blank (§5)
    }
  }
  return out;
}

/**
 * @param {object} enumNode
 * @returns {ParsedEnum}
 */
function parseEnum(enumNode) {
  const attrs = attrsOf(enumNode);
  const enumName = attrs['@_name'];
  const entries = [];
  let description = null;
  for (const child of childrenOf(enumNode)) {
    const tag = tagOf(child);
    switch (tag) {
      case 'description':
        description = textOf(child);
        break;
      case 'entry':
        entries.push(parseEntry(child));
        break;
      default:
        break; // This space intentionally left blank (§5)
    }
  }
  return {
    name: enumName,
    bitmask: attrs['@_bitmask'] === 'true',
    description,
    entries,
  };
}

/**
 * @param {object} entryNode
 * @returns {ParsedEntry}
 */
function parseEntry(entryNode) {
  const attrs = attrsOf(entryNode);
  const params = [];
  let description = null;
  for (const child of childrenOf(entryNode)) {
    const tag = tagOf(child);
    switch (tag) {
      case 'description':
        description = textOf(child);
        break;
      case 'param':
        params.push(parseParam(child));
        break;
      default:
        break; // This space intentionally left blank (§5)
    }
  }
  params.sort((a, b) => a.index - b.index);
  return {
    name: attrs['@_name'],
    value: parseIntLiteral(attrs['@_value']),
    description,
    hasLocation: attrs['@_hasLocation'] === undefined ? null : attrs['@_hasLocation'] === 'true',
    isDestination:
      attrs['@_isDestination'] === undefined ? null : attrs['@_isDestination'] === 'true',
    params,
  };
}

/**
 * @param {object} paramNode
 * @returns {ParsedParam}
 */
function parseParam(paramNode) {
  const attrs = attrsOf(paramNode);
  return {
    index: Number(attrs['@_index']),
    label: attrs['@_label'],
    description: textOf(paramNode),
    units: attrs['@_units'],
    enum: attrs['@_enum'],
    minValue: numAttr(attrs, '@_minValue'),
    maxValue: numAttr(attrs, '@_maxValue'),
    increment: numAttr(attrs, '@_increment'),
    reserved: attrs['@_reserved'] === 'true',
    default: attrs['@_default'],
  };
}

/**
 * @param {object} msgNode
 * @returns {ParsedMessage}
 */
function parseMessage(msgNode) {
  const attrs = attrsOf(msgNode);
  const fields = [];
  let description = null;
  let extension = false;
  for (const child of childrenOf(msgNode)) {
    const tag = tagOf(child);
    switch (tag) {
      case 'description':
        description = textOf(child);
        break;
      case 'extensions':
        extension = true;
        break;
      case 'field':
        fields.push(parseField(child, extension));
        break;
      default:
        break; // This space intentionally left blank (§5)
    }
  }
  return {
    id: Number(attrs['@_id']),
    name: attrs['@_name'],
    description,
    fields,
  };
}

/**
 * @param {object} fieldNode
 * @param {boolean} extension  whether this field follows the <extensions/> marker
 * @returns {ParsedField}
 */
function parseField(fieldNode, extension) {
  const attrs = attrsOf(fieldNode);
  const { type, arrayLength } = splitType(attrs['@_type']);
  return {
    name: attrs['@_name'],
    type,
    arrayLength,
    extension,
    enum: attrs['@_enum'],
    display: attrs['@_display'],
    units: attrs['@_units'],
    invalid: attrs['@_invalid'],
    minValue: numAttr(attrs, '@_minValue'),
    maxValue: numAttr(attrs, '@_maxValue'),
    increment: numAttr(attrs, '@_increment'),
    description: textOf(fieldNode),
  };
}

/**
 * Resolve the include graph from the entry file in dependency order (each
 * file after all it includes, the entry last), detecting missing includes and
 * cycles. Diamonds are visited once and are not cycles.
 *
 * @param {Object<string, string>} files  file name -> XML string
 * @param {string} entry  entry file name
 * @param {Map<string, ParsedFile>} parsedByFile  fills in as files are parsed
 * @returns {string[]} file names, dependency-first, entry last
 */
function resolveIncludeOrder(files, entry, parsedByFile) {
  const order = [];
  const done = new Set();
  const stack = [];

  const visit = (fileName, referrer) => {
    if (!Object.prototype.hasOwnProperty.call(files, fileName)) {
      const from = referrer ? ` included by '${referrer}'` : '';
      throw new Error(`Dialect include '${fileName}'${from} was not provided.`);
    }
    if (stack.includes(fileName)) {
      const cycle = [...stack.slice(stack.indexOf(fileName)), fileName].join(' -> ');
      throw new Error(`Cyclic include detected: ${cycle}.`);
    }
    if (done.has(fileName)) {
      return;
    }
    if (!parsedByFile.has(fileName)) {
      parsedByFile.set(fileName, parseFile(fileName, files[fileName]));
    }
    stack.push(fileName);
    for (const inc of parsedByFile.get(fileName).includes) {
      visit(inc, fileName);
    }
    stack.pop();
    done.add(fileName);
    order.push(fileName);
  };

  visit(entry, null);
  return order;
}

/**
 * Compile a custom dialect from XML into a {@link DialectBundle}.
 *
 * @param {Object<string, string>} files  file name -> XML string; must include
 *   `entryFileName` and every file its include graph references
 * @param {string} entryFileName  the dialect file to compile
 * @returns {import('./index').DialectBundle}
 */
function compileXml(files, entryFileName) {
  const parsedByFile = new Map();
  const order = resolveIncludeOrder(files, entryFileName, parsedByFile);

  /** @type {Map<string, {name:string,bitmask:boolean,description:string|null,entries:Map<string,{value:number|string,description:string|null,hasLocation:boolean|null,isDestination:boolean|null,params:ParsedParam[],file:string}>}>} */
  const enums = new Map();
  /** @type {Map<string, ParsedMessage & {file:string}>} */
  const messages = new Map();
  /** @type {Map<number, string>} live msgid -> message name */
  const idToName = new Map();
  const overrides = [];

  for (const fileName of order) {
    const parsed = parsedByFile.get(fileName);
    mergeEnums(enums, parsed.enums, fileName, overrides);
    mergeMessages(messages, idToName, parsed.messages, fileName, overrides);
  }

  return assembleBundle({
    dialect: entryFileName.replace(/\.xml$/i, ''),
    version: parsedByFile.get(entryFileName).version,
    files: order,
    fetched: null,
    enums,
    messages,
    idToName,
    overrides,
  });
}

/**
 * Merge one file's enums into the running set. Enum-level bitmask never unsets;
 * a later non-null description replaces an earlier one. Entries are additive by
 * name; a same-name redefinition nearer the entry overrides (later wins) and is
 * recorded, while a same-name-same-value duplicate (a diamond include) is
 * absorbed silently.
 *
 * @param {Map} enums
 * @param {ParsedEnum[]} fileEnums
 * @param {string} fileName
 * @param {Array} overrides
 * @returns {void}
 */
function mergeEnums(enums, fileEnums, fileName, overrides) {
  for (const e of fileEnums) {
    let target = enums.get(e.name);
    if (!target) {
      target = { name: e.name, bitmask: false, description: null, entries: new Map() };
      enums.set(e.name, target);
    }
    if (e.bitmask) {
      target.bitmask = true;
    }
    if (e.description !== null) {
      target.description = e.description;
    }
    for (const entry of e.entries) {
      const existing = target.entries.get(entry.name);
      const record = {
        value: entry.value,
        description: entry.description,
        hasLocation: entry.hasLocation,
        isDestination: entry.isDestination,
        params: entry.params,
        file: fileName,
      };
      if (!existing) {
        target.entries.set(entry.name, record);
        continue;
      }
      if (String(existing.value) !== String(entry.value)) {
        overrides.push({ kind: 'enumEntry', name: entry.name, from: existing.file, by: fileName });
        target.entries.set(entry.name, record);
        continue;
      }
      // Same name, same value: a legitimate re-encounter (diamond include).
      // Prefer the newer non-null detail but do not record an override.
      if (entry.description !== null) {
        existing.description = entry.description;
      }
      if (entry.params.length) {
        existing.params = entry.params;
      }
      if (entry.hasLocation !== null) {
        existing.hasLocation = entry.hasLocation;
      }
      if (entry.isDestination !== null) {
        existing.isDestination = entry.isDestination;
      }
    }
  }
}

/**
 * Merge one file's messages into the running set. A same-name redefinition
 * nearer the entry is an override (recorded, resolved by include order) that
 * frees its previous id; a different message claiming an id already live is a
 * collision and fails loud.
 *
 * @param {Map} messages
 * @param {Map} idToName
 * @param {ParsedMessage[]} fileMessages
 * @param {string} fileName
 * @param {Array} overrides
 * @returns {void}
 */
function mergeMessages(messages, idToName, fileMessages, fileName, overrides) {
  for (const msg of fileMessages) {
    const existing = messages.get(msg.name);
    if (existing) {
      overrides.push({ kind: 'message', name: msg.name, from: existing.file, by: fileName });
      if (idToName.get(existing.id) === msg.name) {
        idToName.delete(existing.id);
      }
    }
    const holder = idToName.get(msg.id);
    if (holder !== undefined && holder !== msg.name) {
      throw new Error(
        `Message id ${msg.id} is claimed by both '${holder}' and '${msg.name}' ` +
          `(in '${fileName}') — a msgid collision between different messages.`
      );
    }
    messages.set(msg.name, { ...msg, file: fileName});
    idToName.set(msg.id, msg.name);
  }
}

/**
 * Turn the merged intermediate maps into the final immutable bundle shape.
 *
 * @param {object} merged
 * @returns {import('./index').DialectBundle}
 */
function assembleBundle(merged) {
  const enums = {};
  for (const e of merged.enums.values()) {
    const entries = [...e.entries.entries()].map(([name, rec]) => ({
      name,
      value: rec.value,
      description: rec.description,
    }));
    // Both lookup directions, compiled once here so no consumer walks
    // `entries` to translate. XML lets two names share a value (deprecated
    // aliases); the first declared name is the one `byValue` shows.
    const byName = {};
    const byValue = {};
    for (const entry of entries) {
      byName[entry.name] = entry.value;
      if (!(entry.value in byValue)) byValue[entry.value] = entry.name;
    }
    enums[e.name] = { name: e.name, bitmask: e.bitmask, description: e.description, entries, byName, byValue };
  }

  const messages = {};
  const messagesById = {};
  for (const [id, name] of merged.idToName.entries()) {
    messagesById[String(id)] = name;
  }
  for (const msg of merged.messages.values()) {
    // Skip a message whose id was freed by an override but never re-added under
    // this name — only live names remain reachable through messagesById.
    messages[msg.name] = {
      id: msg.id,
      name: msg.name,
      description: msg.description,
      fields: msg.fields.map((f) => shapeField(f, enums)),
    };
  }

  const commands = buildCommands(merged.enums);

  return {
    dialect: merged.dialect,
    version: merged.version,
    files: merged.files,
    fetched: merged.fetched,
    enums,
    messages,
    messagesById,
    commands,
    overrides: merged.overrides,
  };
}

/**
 * Shape a parsed field into the bundle Field, deriving `display: 'bitmask'`
 * when the XML did not mark it but the backing enum is a bitmask.
 *
 * @param {ParsedField} f
 * @param {Object<string, object>} enums  assembled enums for bitmask lookup
 * @returns {object}
 */
function shapeField(f, enums) {
  let display = f.display;
  if (!display && f.enum && enums[f.enum].bitmask) {
    display = 'bitmask';
  }
  return {
    name: f.name,
    type: f.type,
    arrayLength: f.arrayLength,
    extension: f.extension,
    enum: f.enum,
    display,
    units: f.units,
    invalid: f.invalid,
    minValue: f.minValue,
    maxValue: f.maxValue,
    increment: f.increment,
    description: f.description,
  };
}

/**
 * Derive the MAV_CMD command view from the merged enums. Empty when the dialect
 * defines no MAV_CMD enum.
 *
 * @param {Map} mergedEnums  intermediate enum map (carries params per entry)
 * @returns {Object<string, object>}
 */
function buildCommands(mergedEnums) {
  const mavCmd = mergedEnums.get('MAV_CMD');
  if (!mavCmd) {
    return {};
  }
  const commands = {};
  for (const [name, rec] of mavCmd.entries.entries()) {
    commands[name] = {
      name,
      value: Number(rec.value),
      description: rec.description,
      hasLocation: rec.hasLocation,
      isDestination: rec.isDestination,
      params: rec.params.map((p) => ({
        index: p.index,
        label: p.label,
        description: p.description,
        units: p.units,
        enum: p.enum,
        minValue: p.minValue,
        maxValue: p.maxValue,
        increment: p.increment,
        reserved: p.reserved,
        default: p.default,
      })),
    };
  }
  return commands;
}

module.exports = { compileXml, parseFile };
