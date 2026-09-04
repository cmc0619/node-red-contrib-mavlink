'use strict';

/**
 * Flight-mode names ↔ custom-mode numbers (DESIGN.md §8, §9, §11).
 *
 * One namespace: the number side of every resolution here is the HEARTBEAT
 * `custom_mode` — the value the vehicle reports, the value `AVAILABLE_MODES`
 * (message 435 — in the bundled seed, absent from older common.xml revisions)
 * publishes, and (except for PX4's DO_SET_MODE split, below) the value
 * `MAV_CMD_DO_SET_MODE` param2 carries.
 *
 * Resolution ladder, same order both directions:
 *
 *   1. **Vehicle-published** — `AVAILABLE_MODES` entries cached on the peer
 *      component (`lib/connection/peer-table.js`). A vehicle stating its own
 *      mode table is a measurement, and measurement outranks source (§1): an
 *      entry held there wins over anything shipped. A standard mode arrives
 *      with a blank `mode_name` — its name is the dialect's
 *      `MAV_STANDARD_MODE` entry (measured 2026-08-18, PX4 1.18 SIH). The
 *      cache is incremental, so a name it does not hold still falls through.
 *   2. **Shipped hypothesis** — per firmware (§5 dispatch):
 *      ArduPilot reads the compiled dialect's per-family mode enum
 *      ({@link AP_MODE_ENUMS}); PX4 reads the baked {@link PX4_MODES} table.
 *      `custom` firmware ships no table — the Vehicle Profile documents it as
 *      "do not pretend to know the mode table" (DESIGN.md §11).
 *   3. **Unresolved** — name→number returns NaN, never undefined and never a
 *      guess: absent encodes as 0 (a real mode) at the wire, while NaN craters
 *      loudly at the wire choke naming the field (the `lib/command/carrier.js`
 *      intXY precedent). number→name returns undefined: outputs simply omit
 *      the name; the raw number is always present.
 *
 * Names are matched case-insensitively — vehicles publish mixed-case names
 * ("Position"), ArduPilot enums are SCREAMING — and answered in the spelling
 * the winning tier holds.
 */

/** MAV_CMD_DO_SET_MODE, whose param2 is the custom mode this module resolves. */
const DO_SET_MODE = 176;

/**
 * MAV_MODE_FLAG_CUSTOM_MODE_ENABLED — the base-mode bit (DO_SET_MODE param1)
 * without which the autopilot ignores the custom mode entirely.
 */
const MODE_FLAG_CUSTOM_MODE_ENABLED = 1;

/**
 * ArduPilot custom-mode enum per Vehicle Profile family — the runtime twin of
 * `CUSTOM_MODE_ENUMS` in `resources/mavlink-editor.js` (the two lists change
 * together). Boat is Rover firmware and reads ROVER_MODE. BLIMP_MODE is listed
 * although no dialect defines it yet: the day upstream lands the table, the
 * compiled bundle carries it and blimp starts resolving with no change here
 * (the `lib/metadata/commands-list.js` BLIMP_MODE synthesis is editor-catalog
 * only). `unknown` is absent because a wrong table is worse than no name.
 *
 * ArduPilot's `custom_mode` is the flat mode integer — identical in
 * HEARTBEAT, `AVAILABLE_MODES` and DO_SET_MODE param2 (measured 2026-08-18,
 * Copter-4.7.0 SITL). No packing anywhere on this side.
 *
 * @type {Object<string, string>}
 */
const AP_MODE_ENUMS = {
  copter: 'COPTER_MODE',
  plane: 'PLANE_MODE',
  rover: 'ROVER_MODE',
  boat: 'ROVER_MODE',
  sub: 'SUB_MODE',
  blimp: 'BLIMP_MODE',
  'antenna-tracker': 'TRACKER_MODE',
};

/** The dialect enum that names standard modes (`AVAILABLE_MODES.standard_mode`). */
const STANDARD_MODE_ENUM = 'MAV_STANDARD_MODE';
const STANDARD_MODE_PREFIX = 'MAV_STANDARD_MODE_';

/*
 * PX4 packs `custom_mode` as a union (px4_custom_mode.h layout, confirmed on
 * the wire 2026-08-18: Position = 0x00030000, Hold = 0x03040000):
 *
 *     bytes 0–1  reserved
 *     byte  2    main_mode   (bits 16–23)
 *     byte  3    sub_mode    (bits 24–31)
 *
 * so packed = main_mode × 2^16 + sub_mode × 2^24. Arithmetic, not bitwise, on
 * purpose: a NaN from the unresolved tail must ride through the pack/unpack
 * as NaN (bitwise operators would launder it to 0 — MANUAL's neighborhood).
 */

/** Scale of `main_mode` (byte 2) inside the packed uint32. */
const PX4_MAIN_SCALE = 65536;
/** Scale of `sub_mode` (byte 3) inside the packed uint32. */
const PX4_SUB_SCALE = 16777216;

/**
 * @param {number} main  main_mode value
 * @param {number} sub   sub_mode value (0 for main-only modes)
 * @returns {number} the packed HEARTBEAT `custom_mode`
 */
function px4CustomMode(main, sub) {
  return main * PX4_MAIN_SCALE + sub * PX4_SUB_SCALE;
}

/**
 * @param {number} customMode  packed uint32
 * @returns {number} `main_mode` (byte 2); NaN rides through
 */
function px4MainMode(customMode) {
  return Math.floor(customMode / PX4_MAIN_SCALE) % 256;
}

/**
 * @param {number} customMode  packed uint32
 * @returns {number} `sub_mode` (byte 3); NaN rides through
 */
function px4SubMode(customMode) {
  return Math.floor(customMode / PX4_SUB_SCALE) % 256;
}

/**
 * The PX4 flight-mode table: (name, main_mode, sub_mode).
 *
 * A deliberate, audited baked protocol copy — the same exception class as the
 * editor's `MAGIC_BOOLEAN_PARAMS` (DESIGN.md §14 on baked copies): PX4 modes
 * live in PX4 source, not in any dialect, so there is nothing to compile them
 * from. **Measured 2026-08-18 against PX4 1.18 SIH** — every row is that
 * vehicle's own `AVAILABLE_MODES` word decoded, and the live vehicle's
 * `AVAILABLE_MODES` wins where they disagree (ladder tier 1). Do not "fix"
 * this table from the historical `px4_custom_mode.h` AUTO sub-mode enum: 1.18
 * renumbered it on the wire (measured: Land = sub 2 where the header says
 * TAKEOFF, Mission = sub 6 where the header says LAND). Names are the
 * vehicle's spellings — the published `mode_name`, or the `MAV_STANDARD_MODE`
 * entry for the standard-mode rows, which arrive with a blank name.
 *
 * Sub-modes 0x0B–0x12 under AUTO were published as "(Mode not available)"
 * (properties bit 2) on the same capture and are omitted rather than named.
 *
 * `resources/mavlink-editor.js` `PX4_MODES` mirrors this row-for-row (browser
 * HTML cannot require() this module); the pair is pinned by drift test.
 *
 * @type {Array<{name: string, main: number, sub: number}>}
 */
const PX4_MODES = [
  { name: 'Manual', main: 1, sub: 0 },          // 0x00010000
  { name: 'Altitude', main: 2, sub: 0 },        // 0x00020000 (std ALTITUDE_HOLD)
  { name: 'Position', main: 3, sub: 0 },        // 0x00030000 (std POSITION_HOLD)
  { name: 'Orbit', main: 3, sub: 1 },           // 0x01030000 (std ORBIT)
  { name: 'Position Slow', main: 3, sub: 2 },   // 0x02030000
  { name: 'Acro', main: 5, sub: 0 },            // 0x00050000
  { name: 'Offboard', main: 6, sub: 0 },        // 0x00060000
  { name: 'Stabilized', main: 7, sub: 0 },      // 0x00070000
  { name: 'Termination', main: 10, sub: 0 },    // 0x000A0000
  { name: 'Altitude Cruise', main: 11, sub: 0 }, // 0x000B0000
  { name: 'Land', main: 4, sub: 2 },            // 0x02040000 (std LAND)
  { name: 'Hold', main: 4, sub: 3 },            // 0x03040000
  { name: 'Safe Recovery', main: 4, sub: 4 },   // 0x04040000 (std SAFE_RECOVERY)
  { name: 'Return Home', main: 4, sub: 5 },     // 0x05040000 (std RETURN_HOME)
  { name: 'Mission', main: 4, sub: 6 },         // 0x06040000 (std MISSION)
  { name: 'Follow Target', main: 4, sub: 8 },   // 0x08040000
  { name: 'Precision Landing', main: 4, sub: 9 }, // 0x09040000
  { name: 'VTOL Takeoff', main: 4, sub: 10 },   // 0x0A040000
  { name: 'Guided Course', main: 4, sub: 19 },  // 0x13040000
];

/**
 * @typedef {object} ModeContext
 * @property {object} [component]  live peer-table component (wire tiers) —
 *   carries the vehicle-published `modes` cache; absent on Build
 * @property {string} [firmware]  effective firmware ('ardupilot' | 'px4' | …)
 * @property {string} [vehicleFamily]  Vehicle Profile family (ArduPilot enums)
 * @property {object|null} [bundle]  compiled dialect bundle (ArduPilot mode
 *   enums, MAV_STANDARD_MODE names)
 */

/** @param {string} name @returns {string} the case-folded match key */
function nameKey(name) {
  return name.toUpperCase();
}

/**
 * The short name of a prefixed dialect enum entry:
 * `COPTER_MODE_GUIDED` → `GUIDED`, `MAV_STANDARD_MODE_LAND` → `LAND`.
 *
 * @param {{name: string}} entry
 * @param {string} prefix
 * @returns {string}
 */
function shortName(name, prefix) {
  return name.slice(prefix.length);
}

/**
 * The name a cached `AVAILABLE_MODES` entry answers to: its published
 * `mode_name`, or — a standard mode arrives with a blank name (measured
 * 2026-08-18) — the dialect's `MAV_STANDARD_MODE` entry for its
 * `standard_mode`. Undefined when neither names it; the ladder falls through.
 *
 * @param {{name: string, standardMode: number}} entry
 * @param {ModeContext} ctx
 * @returns {string|undefined}
 */
function publishedName(entry, ctx) {
  if (entry.name) return entry.name;
  if (entry.standardMode) {
    const table = ctx.bundle.enums[STANDARD_MODE_ENUM];
    const std = table ? table.byValue[entry.standardMode] : undefined;
    if (std) return shortName(std, STANDARD_MODE_PREFIX);
  }
  return undefined;
}

/**
 * The dialect's mode enum for an ArduPilot family, or null when the family
 * has no table or the bundle does not carry it.
 *
 * @param {ModeContext} ctx
 * @returns {{entries: Array<{name: string, value: number|string}>, prefix: string}|null}
 */
function apModeTable(ctx) {
  const enumName = AP_MODE_ENUMS[ctx.vehicleFamily];
  const table = enumName ? ctx.bundle.enums[enumName] : null;
  if (!table) return null;
  return { entries: table.entries, byValue: table.byValue, prefix: `${enumName}_` };
}

/**
 * Resolve a flight-mode name to its custom-mode number through the ladder.
 *
 * @param {*} name
 * @param {ModeContext} ctx
 * @returns {number} the custom-mode number, or NaN when nothing resolves
 */
function modeNumberFor(name, ctx) {
  const key = nameKey(name);
  const held = ctx.component && ctx.component.modes;
  if (held) {
    for (const entry of held.values()) {
      const published = publishedName(entry, ctx);
      if (published !== undefined && nameKey(published) === key) {
        return entry.customMode;
      }
    }
  }

  switch (ctx.firmware) {
    case 'ardupilot': {
      const table = apModeTable(ctx);
      const entry = table
        ? table.entries.find((e) => nameKey(shortName(e.name, table.prefix)) === key)
        : null;
      if (entry) return Number(entry.value);
      break;
    }
    case 'px4': {
      const row = PX4_MODES.find((r) => nameKey(r.name) === key);
      if (row) return px4CustomMode(row.main, row.sub);
      break;
    }
    default: break; // This space intentionally left blank (§5)
  }
  return NaN; // nothing matched: no behavior selected (§5) — loud at the wire
}

/**
 * Resolve a custom-mode number to a flight-mode name through the ladder.
 * The comparison is on the whole `custom_mode` word — for PX4 the packed
 * bitfield compares directly against the HEARTBEAT value, no decomposition.
 *
 * @param {*} number
 * @param {ModeContext} ctx
 * @returns {string|undefined} the name, or undefined when nothing resolves
 */
function modeNameFor(number, ctx) {
  // Absence is not mode 0. Number(null) is 0, and 0 is STABILIZE on
  // ArduPilot copter — a resolved name for a mode that was never observed.
  if (number === null || number === undefined) return undefined;
  const held = ctx.component && ctx.component.modes;
  if (held) {
    for (const entry of held.values()) {
      if (entry.customMode !== Number(number)) continue;
      const published = publishedName(entry, ctx);
      if (published !== undefined) return published;
    }
  }

  switch (ctx.firmware) {
    case 'ardupilot': {
      const table = apModeTable(ctx);
      const name = table ? table.byValue[number] : undefined;
      if (name) return shortName(name, table.prefix);
      break;
    }
    case 'px4': {
      const main = px4MainMode(number);
      const sub = px4SubMode(number);
      const row = PX4_MODES.find((r) => r.main === main && r.sub === sub);
      if (row) return row.name;
      break;
    }
    default: break; // This space intentionally left blank (§5)
  }
  return undefined; // nothing matched: no behavior selected (§5) — omit the name
}

/**
 * DO_SET_MODE custom-mode params for a named mode.
 *
 * PX4 does not read the packed bitfield back: measured on the lab SIH
 * (DESIGN.md §14, "PX4 DO_SET_MODE on this SIH wants main_mode in param2"),
 * param2 carries the decomposed `main_mode` and param3 the `sub_mode` — the
 * same split QGC and pymavlink transmit, and what PX4's Commander uint8-casts
 * each param to. Every other stack reads param2 as the dialect defines it —
 * "Custom mode - this is system specific" — so the resolved number (or its
 * NaN tail) rides whole. param1's custom-mode-enabled bit is the caller's to
 * merge: it combines with whatever base-mode flags the flow already supplied.
 *
 * @param {*} name
 * @param {ModeContext} ctx
 * @returns {Object<number, number>} param index → value
 */
function setModeParams(name, ctx) {
  const number = modeNumberFor(name, ctx);
  switch (ctx.firmware) {
    case 'px4':
      return { 2: px4MainMode(number), 3: px4SubMode(number) };
    case 'ardupilot':
      // Non-PX4 stacks that publish a vehicleFamily read param2 as the
      // dialect's custom-mode word. custom has no packing of its own — an
      // unmatched firmware selects no params (§5).
      return { 2: number };
    default: break; // This space intentionally left blank (§5)
  }
  return {};
}

module.exports = {
  DO_SET_MODE,
  MODE_FLAG_CUSTOM_MODE_ENABLED,
  PX4_MODES,
  px4CustomMode,
  px4MainMode,
  px4SubMode,
    modeNameFor,
  setModeParams,
};
