'use strict';

/**
 * Editor-facing MAV_CMD catalog (DESIGN.md §6, §9 Advanced).
 *
 * Advanced mode on the Command node enumerates every `MAV_CMD` in the loaded
 * dialect as a dropdown — never a free-form integer — and reshapes the form
 * to that command's named params under the §6 rendering rules (no raw
 * numbered param grid; `enum=` → dropdown; reserved / Empty hidden).
 */

const { loadBundled } = require('./bundled');

/**
 * @param {string} name
 * @param {number|string} value
 * @returns {string}
 */
function commandLabel(name, value) {
  return `${name} (${value})`;
}

/**
 * §6 four-case rule — cases 1 and 2 hide the field.
 *
 * @param {{reserved?: boolean, description?: string|null}} param
 * @returns {boolean}
 */
function isHiddenParam(param) {
  if (param.reserved) return true;
  const d = param.description != null ? String(param.description).trim() : '';
  return d === 'Empty' || d === 'Empty.' || d === 'Reserved';
}

/**
 * @param {{name: string, value: number|string, description?: string|null}} entry
 * @returns {string}
 */
function enumOptionLabel(entry) {
  return commandLabel(entry.name, entry.value);
}

/**
 * @param {{entries: object[]}} table
 * @returns {Array<{name:string,value:number|string,label:string,description:string|null}>}
 */
function mapEnumEntries(table) {
  return table.entries.map((entry) => ({
    name: entry.name,
    value: entry.value,
    label: enumOptionLabel(entry),
    description: entry.description,
  }));
}

/**
 * Per-airframe custom-mode tables, carried by every catalog on top of the
 * enums the params reference. DO_SET_MODE param2 is `custom_mode`: no `enum=`
 * names its table because the right one depends on the airframe, so the editor
 * picks by Vehicle Profile family and needs them all on hand. A dialect that
 * defines none of them — common, the PX4 stack — simply contributes none.
 *
 * These are the values of `CUSTOM_MODE_ENUMS` in `resources/mavlink-editor.js`,
 * which is where the family that selects one lives. The editor cannot require
 * a Node module, so the names are spelled twice; the two lists change together.
 *
 * @type {string[]}
 */
const CUSTOM_MODE_ENUMS = [
  'COPTER_MODE', 'PLANE_MODE', 'ROVER_MODE', 'SUB_MODE', 'TRACKER_MODE',
  // Not in any dialect today — listed so that the day one defines it, the real
  // table is carried here and the synthesis below stands down on its own.
  'BLIMP_MODE',
];

/**
 * The table upstream never wrote. ArduPilot ships Blimp with flight modes and
 * a parameter document, but no `BLIMP_MODE` enum exists in any dialect — a
 * measured absence, not a stale bundle (DESIGN.md §14). Without this, the one
 * ArduPilot airframe we already treat as a first-class family
 * (`lib/vehicle/index.js`) is the only one whose operator has to type a bare
 * number into Set Mode.
 *
 * Values are `Mode::Number` from ArduPilot's `Blimp/mode.h`, which
 * `GCS_Blimp::custom_mode()` returns verbatim as the HEARTBEAT `custom_mode` —
 * so they are exactly what DO_SET_MODE param2 must carry. Mode 30 is reserved
 * upstream for external/Lua control and has no name to offer, so it is absent
 * rather than invented.
 *
 * A fallback, not an override: the dialect always wins. `BLIMP_MODE` is listed
 * in {@link CUSTOM_MODE_ENUMS} above, so a bundle that defines it populates
 * `enums.BLIMP_MODE` from the XML and the injection below sees it already
 * there. Upstream landing the table is the day this stops being used — no
 * release of ours required, and nothing here to remember to delete beyond the
 * constant itself.
 *
 * Shaped like a parsed dialect enum so {@link mapEnumEntries} labels it the
 * same way it labels the five real ones.
 *
 * @type {{entries: Array<{name: string, value: number, description: string}>}}
 */
const BLIMP_MODE = {
  entries: [
    { name: 'BLIMP_MODE_LAND', value: 0, description: 'Land' },
    { name: 'BLIMP_MODE_MANUAL', value: 1, description: 'Manual control' },
    { name: 'BLIMP_MODE_VELOCITY', value: 2, description: 'Velocity control' },
    { name: 'BLIMP_MODE_LOITER', value: 3, description: 'Loiter (position hold)' },
    { name: 'BLIMP_MODE_RTL', value: 4, description: 'Return to launch' },
    { name: 'BLIMP_MODE_AUTO', value: 5, description: 'Auto' },
    { name: 'BLIMP_MODE_HOLD', value: 6, description: 'Hold (stop moving)' },
  ],
};

/**
 * Build the Advanced catalog from any DialectBundle (bundled or custom).
 *
 * @param {object} bundle  {@link DialectBundle}
 * @param {string} dialectName
 * @returns {{dialect: string, commands: object[], enums: Object<string, object[]>}}
 */
function catalogFromBundle(bundle, dialectName) {
  const commands = [];
  const enumsUsed = new Set(CUSTOM_MODE_ENUMS);

  for (const cmd of Object.values(bundle.commands)) {
    const params = [];
    for (const p of cmd.params) {
      if (p.enum) enumsUsed.add(p.enum);
      params.push({
        index: p.index,
        label: p.label,
        description: p.description,
        units: p.units,
        enum: p.enum,
        bitmask: p.enum ? Boolean(bundle.enums[p.enum].bitmask) : false,
        minValue: p.minValue,
        maxValue: p.maxValue,
        increment: p.increment,
        reserved: p.reserved,
        hidden: isHiddenParam(p),
        default: p.default,
      });
    }

    commands.push({
      name: cmd.name,
      value: cmd.value,
      label: commandLabel(cmd.name, cmd.value),
      description: cmd.description,
      params,
    });
  }

  commands.sort((a, b) => a.value - b.value || a.name.localeCompare(b.name));

  /** @type {Object<string, Array<{name:string,value:number|string,label:string,description:string|null}>>} */
  const enums = {};
  for (const enumName of enumsUsed) {
    const table = bundle.enums[enumName];
    if (!table || !Array.isArray(table.entries)) continue;
    enums[enumName] = mapEnumEntries(table);
  }
  // Blimp rides in only where its siblings already do: a dialect carrying
  // COPTER_MODE is an ArduPilot dialect, so the missing table belongs with the
  // ones upstream did write. Common and the PX4 stack stay untouched.
  if (enums.COPTER_MODE && !enums.BLIMP_MODE) {
    enums.BLIMP_MODE = mapEnumEntries(BLIMP_MODE);
  }

  return { dialect: dialectName, commands, enums };
}

/**
 * Full Advanced-mode catalog for one bundled dialect.
 *
 * @param {string} dialect
 * @returns {{dialect: string, commands: object[], enums: Object<string, object[]>}}
 */
function listCommandsCatalog(dialect) {
  return catalogFromBundle(loadBundled(dialect), dialect);
}

module.exports = {
  commandLabel,
  enumOptionLabel,
  mapEnumEntries,
  isHiddenParam,
  catalogFromBundle,
  listCommandsCatalog,
};
