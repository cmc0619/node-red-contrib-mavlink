'use strict';

/**
 * MAVLink metadata pipeline (DESIGN.md §4, §12 step 1).
 *
 * One shape — the {@link DialectBundle} — feeds both editor and runtime, whether
 * a dialect comes from the shipped MAVLink XML seed
 * ({@link loadBundled}) or a user-supplied XML include chain
 * ({@link compileXml}). The bundle is plain,
 * JSON-serializable data with no classes or functions; the wire layer and the
 * editor catalogs consume it as a plain argument.
 */

/**
 * @typedef {object} DialectBundle
 * @property {string} dialect  entry dialect name, e.g. `ardupilotmega`
 * @property {string[]} files  include chain in dependency order, entry last
 * @property {Object<string, Enum>} enums  merged; keys are SCREAMING XML names
 * @property {Object<string, Message>} messages
 * @property {Object<string, Command>} commands  derived MAV_CMD view; {} if none
 */

/**
 * @typedef {object} Enum
 * @property {string} name  SCREAMING, e.g. `MAV_TYPE`
 * @property {boolean} bitmask
 * @property {string|null} description
 * @property {EnumEntry[]} entries
 * @property {Object<string, number|string>} byName  entry name -> value
 * @property {Object<string, string>} byValue  value -> entry name; the first
 *   declared name wins when two entries share a value
 */

/**
 * @typedef {object} EnumEntry
 * @property {string} name  full entry name, e.g. `MAV_TYPE_QUADROTOR`
 * @property {number|string} value  number; decimal string when > MAX_SAFE_INTEGER
 * @property {string|null} description
 */

/**
 * @typedef {object} Message
 * @property {number} id
 * @property {string} name  e.g. `HEARTBEAT`
 * @property {string|null} description
 * @property {Field[]} fields  declaration order; extensions after base
 */

/**
 * @typedef {object} Field
 * @property {string} name  XML / wire name (snake), e.g. `custom_mode`
 * @property {string} type  MAVLink scalar; `uint8_t_mavlink_version` normalizes
 *   to `uint8_t`; the `[n]` is carried by `arrayLength`, never the type
 * @property {number|null} arrayLength
 * @property {boolean} extension
 * @property {string|undefined} enum  SCREAMING enum name when enum-typed
 * @property {string|undefined} display  `bitmask` when the XML says so or the
 *   backing enum is one; else the XML attribute, absent when it has none
 * @property {string|undefined} units
 * @property {string|undefined} invalid  e.g. `NaN`, `0`, `UINT16_MAX`
 * @property {number|null} minValue
 * @property {number|null} maxValue
 * @property {number|null} increment
 * @property {string} description
 */

/**
 * @typedef {object} Command
 * @property {string} name  e.g. `MAV_CMD_NAV_TAKEOFF`
 * @property {number} value
 * @property {string|null} description
 * @property {boolean|null} hasLocation
 * @property {CommandParam[]} params
 */

/**
 * @typedef {object} CommandParam
 * @property {number} index  1..7
 * @property {string|undefined} label
 * @property {string} description
 * @property {string|undefined} units
 * @property {string|undefined} enum  from compiled XML (`<param enum=`>)
 * @property {number|null} minValue
 * @property {number|null} maxValue
 * @property {number|null} increment
 * @property {boolean} reserved
 * @property {string|undefined} default
 */

const {
  knownDialects,
  loadBundled,
  loadBundledSet,
  seedSources,
  seedEntryFor,
  PROFILE_ENTRY,
  profileEntry,
  setCompiledCacheDir,
  clearCompiledCache,
} = require('./bundled');
const { compileXml } = require('./compile');
const { XmlCatalog, dialectLibrary } = require('./xml-catalog');
const { listCommandsCatalog, catalogFromBundle } = require('./commands-list');
const { catalogMessagesFromBundle, listMessagesCatalog } = require('./messages-list');
const { catalogEnumsFromBundle, listEnumsCatalog } = require('./enums-list');

module.exports = {
  knownDialects,
  loadBundled,
  loadBundledSet,
  seedSources,
  seedEntryFor,
  PROFILE_ENTRY,
  profileEntry,
  setCompiledCacheDir,
  clearCompiledCache,
  compileXml,
  XmlCatalog,
  dialectLibrary,
  listCommandsCatalog,
  catalogFromBundle,
  catalogMessagesFromBundle,
  listMessagesCatalog,
  catalogEnumsFromBundle,
  listEnumsCatalog,
};
