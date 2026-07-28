'use strict';

/**
 * MAVLink metadata pipeline (DESIGN.md §4, §12 step 1).
 *
 * One shape — the {@link DialectBundle} — feeds both editor and runtime, whether
 * a dialect comes from the shipped MAVLink XML seed
 * ({@link loadBundled}), a user-supplied XML include chain ({@link compileXml}),
 * or a pinned remote download ({@link fetchDialect}). The bundle is plain,
 * JSON-serializable data with no classes or functions; the field codec (§5)
 * consumes it as a plain argument and imports nothing here.
 *
 * The contract below reproduces `/tmp/briefs/bundle-shape.md`. `lib/codec` may
 * rely only on `Enum.bitmask`, `Enum.entries[].name`, `Enum.entries[].value`,
 * and every property of {@link Field}; everything else is metadata-side and may
 * grow.
 */

/**
 * @typedef {object} DialectBundle
 * @property {string} dialect  entry dialect name, e.g. `ardupilotmega`
 * @property {number|null} version  `<version>` when compiling XML; null for
 *   registry loads
 * @property {string[]} files  include chain in dependency order, entry last
 *   (module names for registry loads; file names for XML)
 * @property {{repo: string, commit: string, fetchedAt: string}|null} fetched
 *   remote-fetch provenance; null for registry / local compile
 * @property {Object<string, Enum>} enums  merged; keys are SCREAMING XML names
 * @property {Object<string, Message>} messages
 * @property {Object<string, string>} messagesById  msgid string -> message name
 * @property {Object<string, Command>} commands  derived MAV_CMD view; {} if none
 * @property {Override[]} overrides  XML same-name overrides; [] for registry loads
 */

/**
 * @typedef {object} Enum
 * @property {string} name  SCREAMING, e.g. `MAV_TYPE`
 * @property {boolean} bitmask
 * @property {string|null} description
 * @property {EnumEntry[]} entries
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
 * @property {string|null} enum  SCREAMING enum name when enum-typed
 * @property {string|null} display  e.g. `bitmask` when known; else null
 * @property {string|null} units
 * @property {string|null} invalid  e.g. `NaN`, `0`, `UINT16_MAX`; null when unknown
 * @property {number|null} minValue
 * @property {number|null} maxValue
 * @property {number|null} increment
 * @property {string|null} description
 */

/**
 * @typedef {object} Command
 * @property {string} name  e.g. `MAV_CMD_NAV_TAKEOFF`
 * @property {number} value
 * @property {string|null} description
 * @property {boolean|null} hasLocation
 * @property {boolean|null} isDestination
 * @property {CommandParam[]} params
 */

/**
 * @typedef {object} CommandParam
 * @property {number} index  1..7
 * @property {string|null} label
 * @property {string|null} description
 * @property {string|null} units
 * @property {string|null} enum  from XML or the control-hint table for bundled
 * @property {number|null} minValue
 * @property {number|null} maxValue
 * @property {number|null} increment
 * @property {boolean} reserved
 * @property {string|null} default
 */

/**
 * @typedef {object} Override
 * @property {'message'|'enumEntry'} kind
 * @property {string} name
 * @property {string} from  file the earlier definition came from
 * @property {string} by  file whose definition won
 */

const { knownDialects, loadBundled, seedRoot, readManifest } = require('./bundled');
const { compileXml } = require('./compile');
const { fetchDialect, REMOTE_SOURCES } = require('./fetch');
const {
  XmlCatalog,
  compileXmlFromFile,
  dialectLibrary,
  entryFileForDialect,
} = require('./xml-catalog');
const {
  listCommandsForDialect,
  listCommandsCatalog,
  catalogFromBundle,
  resolveBundledDialect,
  commandLabel,
  enumOptionLabel,
  isHiddenParam,
} = require('./commands-list');
const {
  messageLabel,
  catalogMessagesFromBundle,
  listMessagesCatalog,
} = require('./messages-list');
const {
  DEFAULT_ENUM_NAMES,
  enumNames,
  catalogEnumsFromBundle,
  listEnumsCatalog,
} = require('./enums-list');

module.exports = {
  knownDialects,
  loadBundled,
  seedRoot,
  readManifest,
  compileXml,
  fetchDialect,
  REMOTE_SOURCES,
  XmlCatalog,
  compileXmlFromFile,
  dialectLibrary,
  entryFileForDialect,
  listCommandsForDialect,
  listCommandsCatalog,
  catalogFromBundle,
  resolveBundledDialect,
  commandLabel,
  enumOptionLabel,
  isHiddenParam,
  messageLabel,
  catalogMessagesFromBundle,
  listMessagesCatalog,
  DEFAULT_ENUM_NAMES,
  enumNames,
  catalogEnumsFromBundle,
  listEnumsCatalog,
};
