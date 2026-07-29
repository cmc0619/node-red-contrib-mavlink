'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Recover, from the `mavlink-mappings` shipped `.d.ts` declarations, the editor
 * metadata the compiled JS registry drops (DESIGN.md §4, §14):
 *
 * - message classes: the field -> backing-enum association (`type: MavType;`
 *   names an enum class, `customMode: uint32_t;` names a wire alias) plus the
 *   class- and field-level JSDoc descriptions;
 * - enums: per-member JSDoc descriptions and the enum-level description;
 * - generated command classes (`DoChangeSpeedCommand extends CommandLong`): the
 *   command description, its `has location` / `is destination` markers, and the
 *   ordered named param accessors with their descriptions, units, and ranges.
 *
 * This is a text parse of a generator-produced, regular format. A missing or
 * unreadable declaration file degrades to an empty table — enum dropdowns and
 * help are a fidelity upgrade, never a reason a dialect fails to load (§4).
 */

/**
 * Wire-type aliases and non-enum declaration types. Any other class-property
 * type in a message class declaration names that field's backing enum class.
 *
 * @type {RegExp}
 */
const NON_ENUM_TYPE =
  /^(u?int\d+_t|float|double|char|string|number|bigint|boolean|uint8_t_mavlink_version)(\[\])?$/;

/**
 * Extract the human-readable text from a JSDoc block: strip ` * ` prefixes,
 * stop at the first `@tag`, and re-flow the generator's hard wrapping into
 * paragraphs.
 *
 * @param {string} doc  raw JSDoc body (between the delimiters)
 * @returns {string|null} description text, or null when empty
 */
function docText(doc) {
  const lines = [];
  for (const raw of String(doc).split('\n')) {
    const line = raw.replace(/^\s*\*?\s?/, '').trimEnd();
    if (line.trim().startsWith('@')) {
      break;
    }
    lines.push(line);
  }
  const text = lines
    .join('\n')
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, ' ').trim())
    .filter((p) => p)
    .join('\n');
  return text || null;
}

/**
 * Parse a numeric JSDoc constraint tag (`@min: -2`, `@max: 180`,
 * `@increment: 1`). The value may be negative or fractional.
 *
 * @param {string} doc  JSDoc block text
 * @param {string} tag  `min` | `max` | `increment`
 * @returns {number|null}
 */
function numericTag(doc, tag) {
  const m = String(doc).match(new RegExp(`@${tag}:?\\s*(-?\\d+(?:\\.\\d+)?)`));
  if (!m) {
    return null;
  }
  const value = Number(m[1]);
  return Number.isFinite(value) ? value : null;
}

/**
 * @typedef {object} DtsField
 * @property {string} type  declared type name (enum class or wire alias)
 * @property {string|null} enumClass  the enum class name when enum-backed
 * @property {string|null} description
 */

/**
 * @typedef {object} DtsClass
 * @property {string|null} description
 * @property {Object<string, DtsField>} fields  keyed by camelCase field name
 */

/**
 * @typedef {object} DtsCommandAccessor
 * @property {string|null} description
 * @property {string|null} units
 * @property {number|null} min
 * @property {number|null} max
 * @property {number|null} increment
 */

/**
 * @typedef {object} DtsCommand
 * @property {string|null} description
 * @property {boolean} hasLocation
 * @property {boolean} isDestination
 * @property {Object<string, DtsCommandAccessor>} accessors  by accessor name
 */

/**
 * @typedef {object} DtsEnum
 * @property {string|null} description
 * @property {Object<string, string|null>} members  member key -> description
 */

/**
 * @typedef {object} ParsedDts
 * @property {Object<string, DtsClass>} classes
 * @property {Object<string, DtsEnum>} enums
 * @property {Object<string, DtsCommand>} commands
 */

/**
 * Parse one `.d.ts` file's text into message-class, enum, and command tables.
 *
 * @param {string} text  declaration file contents
 * @returns {ParsedDts}
 */
function parseDtsText(text) {
  const result = { classes: {}, enums: {}, commands: {} };

  const classRe = /(?:\/\*\*([\s\S]*?)\*\/\s*)?export declare class (\w+) extends (\w+) \{([\s\S]*?)\n\}/g;
  let m;
  while ((m = classRe.exec(text)) !== null) {
    const doc = m[1] || '';
    const className = m[2];
    const base = m[3];
    const body = m[4];

    if (base === 'MavLinkData') {
      const fieldRe = /(?:\/\*\*([\s\S]*?)\*\/\s*)?(\w+):\s*([\w[\]]+);/g;
      const fields = {};
      let f;
      while ((f = fieldRe.exec(body)) !== null) {
        const declared = f[3].replace(/\[\]$/, '');
        fields[f[2]] = {
          type: declared,
          enumClass: NON_ENUM_TYPE.test(f[3]) ? null : declared,
          description: docText(f[1] || ''),
        };
      }
      result.classes[className] = { description: docText(doc), fields };
      continue;
    }

    // Generated command convenience class (e.g. DoChangeSpeedCommand): its
    // named param accessors carry the label/description/units/range the raw
    // `param1..7` floats cannot.
    const getterRe = /(?:\/\*\*([\s\S]*?)\*\/\s*)?get (\w+)\(\)\s*:\s*number;/g;
    const accessors = {};
    let g;
    while ((g = getterRe.exec(body)) !== null) {
      const gdoc = g[1] || '';
      accessors[g[2]] = {
        description: docText(gdoc),
        units: (gdoc.match(/@units\s+(\S+)/) || [])[1] || null,
        min: numericTag(gdoc, 'min'),
        max: numericTag(gdoc, 'max'),
        increment: numericTag(gdoc, 'increment'),
      };
    }
    if (Object.keys(accessors).length) {
      result.commands[className] = {
        description: docText(doc),
        hasLocation: /This command has location\./.test(doc),
        isDestination: /This command is destination\./.test(doc),
        accessors,
      };
    }
  }

  const enumRe = /(?:\/\*\*([\s\S]*?)\*\/\s*)?export declare enum (\w+) \{([\s\S]*?)\n\}/g;
  while ((m = enumRe.exec(text)) !== null) {
    const enumDoc = m[1] || '';
    const enumName = m[2];
    const body = m[3];
    const memberRe = /(?:\/\*\*([\s\S]*?)\*\/\s*)?'?([A-Za-z0-9_]+)'? = -?\d+,?/g;
    const members = {};
    let e;
    while ((e = memberRe.exec(body)) !== null) {
      members[e[2]] = docText(e[1] || '');
    }
    result.enums[enumName] = { description: docText(enumDoc), members };
  }

  return result;
}

/** @type {Map<string, ParsedDts>} per-module-file cache */
const fileCache = new Map();

const EMPTY = Object.freeze({ classes: {}, enums: {}, commands: {} });

/**
 * The directory of `mavlink-mappings`' compiled `lib` where the per-dialect
 * `.d.ts` files live.
 *
 * @returns {string}
 */
function mappingsLibDir() {
  return path.join(path.dirname(require.resolve('mavlink-mappings')), 'lib');
}

/**
 * Parse a bundled dialect module's `.d.ts`, cached per module name. A missing
 * or unreadable file yields the empty table so enum recovery degrades rather
 * than failing the load.
 *
 * @param {string} moduleName  bundled module name (e.g. `common`)
 * @returns {ParsedDts}
 */
function parseModuleDts(moduleName) {
  if (fileCache.has(moduleName)) {
    return fileCache.get(moduleName);
  }
  let parsed;
  try {
    const text = fs.readFileSync(path.join(mappingsLibDir(), `${moduleName}.d.ts`), 'utf8');
    parsed = parseDtsText(text);
  } catch {
    parsed = EMPTY;
  }
  fileCache.set(moduleName, parsed);
  return parsed;
}

module.exports = { parseDtsText, parseModuleDts, docText, numericTag };
