'use strict';

/**
 * Command preset table (DESIGN.md §9 "Command presets").
 *
 * A preset is (command, pinnedParams, exposedParams, friendlyName) — not a
 * separate command. Arm and Disarm are one MAV_CMD with param 1 pinned to
 * opposite values. That is why the list is short and hand-curated yet remains
 * maintenance-free: a dialect update changes the fields, never the preset
 * definitions.
 *
 * pinnedParams maps param index (1–7) to the value that must be sent. The
 * editor hides pinned params; they are sent on the wire. Exposed params are
 * the rest and follow §6 rendering rules (enum= → dropdown, otherwise number
 * field with units / range / increment).
 *
 * requiresConfirmation: true → the Safety group — the editor must show an
 * explicit confirmation dialog before sending.
 *
 * noAutoRetry: true → idempotency is not guaranteed; the node must not
 * retry automatically (MISSION_START, PREFLIGHT_REBOOT_SHUTDOWN per §9).
 *
 * completionKey: identifies which peer-table condition marks completion for
 * the "Send & await completion" tier.  null means the tier is not offered.
 */

/** Completion condition identifiers matched by lib/command/completion.js. */
const COMPLETION = {
  ARM: 'arm',
  DISARM: 'disarm',
  TAKEOFF: 'takeoff',
  LAND: 'land',
  SET_MODE: 'set_mode',
};

/**
 * @typedef {object} Preset
 * @property {string}   id            - stable machine id (used in editor config)
 * @property {string}   group         - 'basic'|'autonomy'|'mission'|'system'|'safety'|'advanced'
 * @property {string}   name          - friendly display name for UI
 * @property {string}   command       - MAV_CMD name string, e.g. 'MAV_CMD_NAV_TAKEOFF'
 * @property {number}   commandId     - MAV_CMD numeric value
 * @property {Object<number,number|null>} pinnedParams - index → value (NaN allowed for "keep")
 * @property {number[]} exposedParams - param indices visible to the user (1-based)
 * @property {boolean}  requiresConfirmation
 * @property {boolean}  noAutoRetry
 * @property {string|null} completionKey
 */

/** @type {Preset[]} */
const PRESETS = [
  // ── Basic ────────────────────────────────────────────────────────────────
  {
    id: 'arm',
    group: 'basic',
    name: 'Arm',
    command: 'MAV_CMD_COMPONENT_ARM_DISARM',
    commandId: 400,
    pinnedParams: { 1: 1 },         // Arm = 1
    exposedParams: [2],             // Force (0 or 21196)
    requiresConfirmation: false,
    noAutoRetry: false,
    completionKey: COMPLETION.ARM,
  },
  {
    id: 'disarm',
    group: 'basic',
    name: 'Disarm',
    command: 'MAV_CMD_COMPONENT_ARM_DISARM',
    commandId: 400,
    pinnedParams: { 1: 0 },         // Arm = 0
    exposedParams: [2],             // Force
    requiresConfirmation: false,
    noAutoRetry: false,
    completionKey: COMPLETION.DISARM,
  },
  {
    id: 'set_mode',
    group: 'basic',
    name: 'Set Mode',
    command: 'MAV_CMD_DO_SET_MODE',
    commandId: 176,
    pinnedParams: {},
    exposedParams: [1, 2],          // Mode (base_mode), custom_mode
    requiresConfirmation: false,
    noAutoRetry: false,
    completionKey: COMPLETION.SET_MODE,
  },
  {
    id: 'takeoff',
    group: 'basic',
    name: 'Takeoff',
    command: 'MAV_CMD_NAV_TAKEOFF',
    commandId: 22,
    pinnedParams: {},
    exposedParams: [1, 4, 5, 6, 7], // Min pitch, empty, empty, yaw, lat (unused), lon (unused), altitude
    requiresConfirmation: false,
    noAutoRetry: false,
    completionKey: COMPLETION.TAKEOFF,
  },
  {
    id: 'land',
    group: 'basic',
    name: 'Land',
    command: 'MAV_CMD_NAV_LAND',
    commandId: 21,
    pinnedParams: {},
    exposedParams: [1, 4, 5, 6, 7], // Abort alt, land mode, lat, lon, alt
    requiresConfirmation: false,
    noAutoRetry: false,
    completionKey: COMPLETION.LAND,
  },
  {
    id: 'rtl',
    group: 'basic',
    name: 'Return to Launch',
    command: 'MAV_CMD_NAV_RETURN_TO_LAUNCH',
    commandId: 20,
    pinnedParams: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 },
    exposedParams: [],
    requiresConfirmation: false,
    noAutoRetry: false,
    completionKey: COMPLETION.LAND,
  },
  {
    id: 'set_home',
    group: 'basic',
    name: 'Set Home',
    command: 'MAV_CMD_DO_SET_HOME',
    commandId: 179,
    pinnedParams: {},
    exposedParams: [1, 5, 6, 7],    // Use current, lat, lon, alt
    requiresConfirmation: false,
    noAutoRetry: false,
    completionKey: null,
  },

  // ── Autonomy ─────────────────────────────────────────────────────────────
  {
    id: 'reposition',
    group: 'autonomy',
    name: 'Go To / Reposition',
    command: 'MAV_CMD_DO_REPOSITION',
    commandId: 192,
    pinnedParams: {},
    exposedParams: [1, 2, 3, 4, 5, 6, 7], // Speed, bitmask/flags, radius, yaw, lat, lon, alt
    requiresConfirmation: false,
    noAutoRetry: false,
    completionKey: null,
  },
  {
    id: 'change_speed',
    group: 'autonomy',
    name: 'Change Speed',
    command: 'MAV_CMD_DO_CHANGE_SPEED',
    commandId: 178,
    pinnedParams: {},
    exposedParams: [1, 2, 3],       // Speed type (enum), speed, throttle
    requiresConfirmation: false,
    noAutoRetry: false,
    completionKey: null,
  },
  {
    id: 'yaw',
    group: 'autonomy',
    name: 'Yaw',
    command: 'MAV_CMD_CONDITION_YAW',
    commandId: 115,
    pinnedParams: { 4: 0 },         // Relative = 0 (absolute)
    exposedParams: [1, 2, 3],       // Angle, angular speed, direction
    requiresConfirmation: false,
    noAutoRetry: false,
    completionKey: null,
  },
  {
    id: 'rotate',
    group: 'autonomy',
    name: 'Rotate',
    command: 'MAV_CMD_CONDITION_YAW',
    commandId: 115,
    pinnedParams: { 4: 1 },         // Relative = 1 (relative)
    exposedParams: [1, 2, 3],       // Angle, angular speed, direction
    requiresConfirmation: false,
    noAutoRetry: false,
    completionKey: null,
  },
  {
    id: 'orbit',
    group: 'autonomy',
    name: 'Orbit',
    command: 'MAV_CMD_DO_ORBIT',
    commandId: 34,
    pinnedParams: {},
    exposedParams: [1, 2, 3, 5, 6, 7], // Radius, velocity, yaw behavior, lat, lon, alt
    requiresConfirmation: false,
    noAutoRetry: false,
    completionKey: null,
  },

  // ── Mission ──────────────────────────────────────────────────────────────
  {
    id: 'mission_start',
    group: 'mission',
    name: 'Mission Start',
    command: 'MAV_CMD_MISSION_START',
    commandId: 300,
    pinnedParams: {},
    exposedParams: [1, 2],          // First item, last item
    requiresConfirmation: false,
    noAutoRetry: true,              // not idempotent — do not auto-retry
    completionKey: null,
  },
  {
    id: 'pause',
    group: 'mission',
    name: 'Pause',
    command: 'MAV_CMD_DO_PAUSE_CONTINUE',
    commandId: 193,
    pinnedParams: { 1: 0 },         // Continue = 0 (pause)
    exposedParams: [],
    requiresConfirmation: false,
    noAutoRetry: false,
    completionKey: null,
  },
  {
    id: 'resume',
    group: 'mission',
    name: 'Resume',
    command: 'MAV_CMD_DO_PAUSE_CONTINUE',
    commandId: 193,
    pinnedParams: { 1: 1 },         // Continue = 1 (resume)
    exposedParams: [],
    requiresConfirmation: false,
    noAutoRetry: false,
    completionKey: null,
  },

  // ── Telemetry / System ───────────────────────────────────────────────────
  {
    id: 'request_message',
    group: 'system',
    name: 'Request Message',
    command: 'MAV_CMD_REQUEST_MESSAGE',
    commandId: 512,
    pinnedParams: {},
    exposedParams: [1, 2],          // Message ID (dropdown), response target
    requiresConfirmation: false,
    noAutoRetry: false,
    completionKey: null,
  },
  {
    id: 'set_message_interval',
    group: 'system',
    name: 'Set Message Interval',
    command: 'MAV_CMD_SET_MESSAGE_INTERVAL',
    commandId: 511,
    pinnedParams: {},
    exposedParams: [1, 2, 3],       // Message ID (dropdown), interval, response target
    requiresConfirmation: false,
    noAutoRetry: false,
    completionKey: null,
  },
  {
    id: 'stop_message_interval',
    group: 'system',
    name: 'Stop Message Interval',
    command: 'MAV_CMD_SET_MESSAGE_INTERVAL',
    commandId: 511,
    pinnedParams: { 2: -1 },        // Interval = −1 (stop)
    exposedParams: [1],             // Message ID (dropdown)
    requiresConfirmation: false,
    noAutoRetry: false,
    completionKey: null,
  },
  {
    id: 'reboot_autopilot',
    group: 'system',
    name: 'Reboot Autopilot',
    command: 'MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN',
    commandId: 246,
    pinnedParams: {},
    exposedParams: [1, 2],          // Autopilot action, companion action
    requiresConfirmation: false,
    noAutoRetry: true,              // not idempotent — do not auto-retry
    completionKey: null,
  },

  // ── Safety ───────────────────────────────────────────────────────────────
  {
    id: 'flight_termination',
    group: 'safety',
    name: 'Flight Termination',
    command: 'MAV_CMD_DO_FLIGHTTERMINATION',
    commandId: 185,
    pinnedParams: {},
    exposedParams: [1],             // Terminate (0 = off, 1 = terminate)
    requiresConfirmation: true,     // Safety — explicit confirmation required
    noAutoRetry: false,
    completionKey: null,
  },
];

/** Fast lookup by preset id. */
const PRESET_BY_ID = new Map(PRESETS.map((p) => [p.id, p]));

/**
 * Find a preset by its stable id.
 *
 * @param {string} id
 * @returns {Preset|undefined}
 */
function getPreset(id) {
  return PRESET_BY_ID.get(id);
}

/**
 * All presets in a format suitable for editor dropdowns, grouped.
 *
 * @returns {Array<{group: string, presets: Array<{id: string, name: string, commandId: number}>}>}
 */
function presetGroups() {
  const order = ['basic', 'autonomy', 'mission', 'system', 'safety'];
  const byGroup = new Map(order.map((g) => [g, []]));
  for (const p of PRESETS) {
    if (byGroup.has(p.group)) byGroup.get(p.group).push({ id: p.id, name: p.name, commandId: p.commandId });
  }
  return order
    .filter((g) => byGroup.get(g).length > 0)
    .map((g) => ({ group: g, presets: byGroup.get(g) }));
}

/**
 * Build the param array (indices 1–7) for a preset, merging pinned defaults
 * with user-supplied values.
 *
 * Pinned params override any user value. Absent exposed params default to 0.
 * Returns a 7-element array [p1, p2, p3, p4, p5, p6, p7].
 *
 * @param {Preset} preset
 * @param {Object<number, number>} userParams  index → value for exposed params
 * @returns {number[]}
 */
function buildParamArray(preset, userParams) {
  const out = [0, 0, 0, 0, 0, 0, 0];
  for (const [idxStr, val] of Object.entries(preset.pinnedParams)) {
    const i = Number(idxStr);
    out[i - 1] = val;
  }
  for (const idx of preset.exposedParams) {
    const val = userParams[idx];
    if (val !== undefined) out[idx - 1] = val;
  }
  return out;
}

module.exports = { PRESETS, PRESET_BY_ID, COMPLETION, getPreset, presetGroups, buildParamArray };
