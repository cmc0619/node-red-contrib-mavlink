'use strict';

/**
 * Name conversions shared by the metadata pipeline.
 *
 * The `mavlink-mappings` registry names everything in TypeScript CamelCase
 * (`MavType`, `DoChangeSpeedCommand`, `speedType`), while MAVLink XML — and the
 * `DialectBundle` shape (`/tmp/briefs/bundle-shape.md`) — uses SCREAMING_SNAKE
 * for enum names and full entry names (`MAV_TYPE`, `MAV_TYPE_QUADROTOR`). These
 * helpers move between the two conventions and derive the bitmask flag the
 * generated modules drop.
 */

/**
 * Convert a compiled enum class name to its SCREAMING_SNAKE prefix:
 * `MavCmd` -> `MAV_CMD`, `GpsFixType` -> `GPS_FIX_TYPE`. Inserts an underscore
 * before an uppercase letter that follows a lower-case letter or digit, and
 * before the last uppercase of an acronym run that starts a new word.
 *
 * @param {string} name  CamelCase enum/class name
 * @returns {string} SCREAMING_SNAKE name
 */
function camelToScreaming(name) {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toUpperCase();
}

/**
 * Convert a SCREAMING_SNAKE enum name to the generator's CamelCase class name:
 * `MAV_TYPE` -> `MavType`. Inverse of {@link camelToScreaming} for the regular
 * cases the generator produces.
 *
 * @param {string} name  SCREAMING_SNAKE enum name
 * @returns {string} CamelCase class name
 */
function screamingToCamel(name) {
  return String(name)
    .toLowerCase()
    .split('_')
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join('');
}

/**
 * XML entry-name prefix for an enum table. Usually identical to the enum name.
 * `MAV_COMPONENT` is the historical exception: the table is `MAV_COMPONENT` but
 * entries are `MAV_COMP_ID_*` in common/minimal.xml (and DESIGN.md §6).
 *
 * @type {Object<string, string>}
 */
const ENTRY_NAME_PREFIX = {
  MAV_COMPONENT: 'MAV_COMP_ID',
};

/**
 * @param {string} enumName  SCREAMING_SNAKE enum table name
 * @returns {string} prefix used for full entry names
 */
function entryNamePrefix(enumName) {
  return ENTRY_NAME_PREFIX[enumName] || enumName;
}

/**
 * The full MAVLink entry name for an unprefixed enum member. The generated
 * enums store members unprefixed (`QUADROTOR`), but keep the full source name
 * when stripping the prefix would leave a leading digit (`GPS_FIX_TYPE_2D_FIX`
 * stays whole because `2D_FIX` is not a valid identifier), so re-prefixing must
 * not double it.
 *
 * @param {string} prefix  SCREAMING_SNAKE enum name, e.g. `MAV_TYPE`
 * @param {string} member  stored member key, e.g. `QUADROTOR`
 * @returns {string} full entry name, e.g. `MAV_TYPE_QUADROTOR`
 */
function fullEntryName(prefix, member) {
  const entryPrefix = entryNamePrefix(prefix);
  return member.startsWith(`${entryPrefix}_`) ? member : `${entryPrefix}_${member}`;
}

/**
 * Turn a generated command accessor name into a human label:
 * `speedType` -> `Speed Type`, `useCurrent` -> `Use Current`. This recovers the
 * XML `<param label>` the accessor was generated from.
 *
 * @param {string} accessor  camelCase accessor name
 * @returns {string} title-cased label
 */
function accessorToLabel(accessor) {
  return String(accessor)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .split(' ')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ')
    .trim();
}

/**
 * True when a value is a uint32 with exactly one bit set. Computed by division
 * rather than bit tests so it never trips the codec's `no-bitwise` rule if the
 * helper is ever shared (§5 forbids bitwise there; this module is exempt but
 * stays arithmetic for one implementation of the idea).
 *
 * @param {*} v
 * @returns {boolean}
 */
function isSingleBit(v) {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isInteger(n) || n <= 0 || n > 0xffffffff) {
    return false;
  }
  let x = n;
  while (x % 2 === 0) {
    x /= 2;
  }
  return x === 1;
}

/**
 * Whether an enum's member values form an additive bitmask. MAVLink marks these
 * with `display="bitmask"` in XML, but the generated modules drop it, so for
 * registry loads it is re-derived from value shape: every non-zero member is a
 * single bit, and either there are at least three such flags or the enum name
 * declares the intent (`*_FLAG`/`*_FLAGS`/`*_MASK`/`*_TYPEMASK`). Below three
 * flags the shape alone is ambiguous (a tiny exclusive enum like `{0,1,2}`
 * matches by accident), so the name disambiguates.
 *
 * @param {Array<number|string>} values  enum member numeric values
 * @param {string} [name]  SCREAMING_SNAKE enum name
 * @returns {boolean}
 */
function isBitmaskEnum(values, name) {
  if (!Array.isArray(values)) {
    return false;
  }
  let flags = 0;
  for (const value of values) {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) {
      return false;
    }
    if (n === 0) {
      continue;
    }
    if (!isSingleBit(n)) {
      return false;
    }
    flags += 1;
  }
  if (flags >= 3) {
    return true;
  }
  return flags >= 1 && typeof name === 'string' && /_(FLAGS?|MASK|TYPEMASK)$/.test(name);
}

/**
 * Whether enum entries form a MAVLink false/true pair: some name equals `FALSE`
 * or ends with `_FALSE`, and some equals `TRUE` or ends with `_TRUE`.
 *
 * @param {Array<{name: string, value: number|string}|string>|null|undefined} entries
 * @returns {boolean}
 */
function isFalseTrueEnum(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return false;
  let hasFalse = false;
  let hasTrue = false;
  for (const entry of entries) {
    const name = typeof entry === 'string' ? entry : entry && entry.name;
    if (typeof name !== 'string') continue;
    if (name === 'FALSE' || name.endsWith('_FALSE')) hasFalse = true;
    if (name === 'TRUE' || name.endsWith('_TRUE')) hasTrue = true;
    if (hasFalse && hasTrue) return true;
  }
  return false;
}

module.exports = {
  camelToScreaming,
  screamingToCamel,
  entryNamePrefix,
  fullEntryName,
  accessorToLabel,
  isSingleBit,
  isBitmaskEnum,
  isFalseTrueEnum,
};
