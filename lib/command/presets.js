'use strict';

const { isBlank } = require('../addressing/resolve');

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
 * requiresConfirmation: true → the Safety group — the editor shows a warning
 * notice on the preset. It gates nothing: triggering the node is the decision
 * (§14.134).
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
 * @property {Object<number,number>} [blankParams] - index → value an *absent*
 *   exposed param encodes as, where the spec defines a no-change sentinel and
 *   a zero-fill is a live command (NaN "keep current", -1 "no change"). This
 *   is what the GCSs transmit for unspecified fields — the #98b land-yaw fix,
 *   generalized. Per-command intent, like requireLocation.
 * @property {boolean}  [requireAltitude] - with requireLocation, a blank
 *   param 7 also refuses: DO_REPOSITION has no documented blank-alt sentinel,
 *   and a zero-filled altitude is ground level or below it (§10, the Move F1
 *   rule on the command path).
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
    // param3 is custom *submode* — PX4 reads its AUTO sub-mode there
    // (DESIGN.md §14, lib/vehicle/modes.js setModeParams). The editor's
    // PRESET_PARAMS renders params 1–2 only; 3 is filled by the PX4 mode
    // dropdown and the payload `mode` name path, so it must ride.
    exposedParams: [1, 2, 3],       // Mode (base_mode), custom_mode, custom submode
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
    // Same hazard the land preset pinned away (#98b): the editor renders no
    // yaw field for takeoff, so a zero-filled blank commanded yaw-to-north
    // during every climb on stacks that read it. NaN = current heading mode.
    blankParams: { 4: NaN },
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
    // param 4 is Yaw Angle: NaN = keep the current heading mode. Pinned to NaN
    // rather than exposed-and-zero-filled, because a zero-filled blank commands
    // yaw-to-north on every landing — the editor never rendered a yaw field, so
    // there was no way to opt out (issue #98b).
    pinnedParams: { 4: NaN },
    exposedParams: [1, 5, 6, 7], // Abort alt, lat, lon, alt
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
    // param1 = 1 means "use current position" and the coords are ignored;
    // only a param1 of 0 actually reads lat/lon. Nothing in lib/** acts on
    // this any more — the editor's `params` validator is what reads it — but
    // it stays here as the single source the editor's copy is pinned against.
    requireLocation: { unless: { param: 1, equals: 1 } },
    completionKey: null,
  },

  // ── Autonomy ─────────────────────────────────────────────────────────────
  {
    id: 'reposition',
    group: 'autonomy',
    // Off the Command operator surface (§6 redesign, 2026-08-12): Move owns
    // the goto, and offering it twice is the duplication the redesign
    // removes. The row itself stays — it is the shared DO_REPOSITION
    // metadata (sentinels, exposed params) that mavlink-formation builds
    // from, and duplicating a §5 sentinel table into formation would drift.
    // Delete the flag (and the row) if formation ever carries its own.
    listed: false,
    name: 'Go To / Reposition',
    command: 'MAV_CMD_DO_REPOSITION',
    commandId: 192,
    pinnedParams: {},
    exposedParams: [1, 2, 3, 4, 5, 6, 7], // Speed, bitmask/flags, radius, yaw, lat, lon, alt
    // GCS parity: QGC/MAVSDK transmit the spec sentinels for unspecified
    // fields — speed < 0 is "vehicle default", yaw NaN is "current heading
    // mode". Zero-filled blanks commanded 0 m/s and yaw-to-north on every
    // goto (#98b class). Altitude has no documented blank sentinel, so a
    // blank alt refuses instead (requireAltitude).
    blankParams: { 1: -1, 4: NaN },
    requiresConfirmation: false,
    noAutoRetry: false,
    requireLocation: true,
    requireAltitude: true,
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
    // Spec: -1 = "no change" for both speed and throttle. A zero-filled blank
    // commanded zero speed / zero throttle — the opposite of leaving it alone.
    blankParams: { 2: -1, 3: -1 },
    requiresConfirmation: false,
    noAutoRetry: false,
    completionKey: null,
  },
  // Yaw and Rotate (CONDITION_YAW absolute/relative) were deleted from the
  // curated list (§6 redesign, 2026-08-12): Move owns motion intents, and the
  // ArduPilot-only turn lands there as a Move capability. CONDITION_YAW stays
  // reachable through the raw MAV_CMD path — the presets were curation, not
  // capability. (PX4 never implemented it: the immediate-command path falls
  // through to VEHICLE_CMD_RESULT_UNSUPPORTED, source-read 2026-08-12; PX4
  // heading control is the setpoint yaw field, which Move steer speaks.)
  {
    id: 'orbit',
    group: 'autonomy',
    name: 'Orbit',
    command: 'MAV_CMD_DO_ORBIT',
    commandId: 34,
    pinnedParams: {},
    exposedParams: [1, 2, 3, 5, 6, 7], // Radius, velocity, yaw behavior, lat, lon, alt
    // DO_ORBIT blesses NaN explicitly, and on the *centre* as well as the
    // altitude — the dialect's own words for param5/6: "INT32_MAX (or NaN if
    // sent in COMMAND_LONG): Use current vehicle position, or current center
    // if already orbiting." Velocity NaN is vehicle default; altitude NaN is
    // current altitude. Zero-filled blanks commanded zero tangential velocity
    // and an orbit centred on null island at ground level.
    //
    // This preset carried `requireLocation: true` until 2026-08-13, which
    // refused a blank centre — i.e. refused the spec's own "orbit where I am",
    // and refused `examples/10-sunday-stroll.json`, which passes NaN
    // explicitly. Orbit could not fly. A command with a documented blank
    // sentinel does not need a presence rule; it needs the sentinel, which is
    // what blankParams is for.
    //
    // The carrier split is ruled (§9): NaN has no int32 encoding, so an orbit
    // that means "here" must ride COMMAND_LONG. The editor refuses the INT
    // pairing at deploy (NAN_CENTRE_PRESETS in mavlink-command.html); on the
    // wire a NaN x/y craters at the serializer's own choke point.
    blankParams: { 2: NaN, 5: NaN, 6: NaN, 7: NaN },
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
    requiresConfirmation: true,     // Safety group — editor notice, not a gate
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
    // listed: false = library metadata, not operator surface (reposition:
    // Move owns the goto; formation builds from the row).
    if (p.listed === false) continue;
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
  // Blank sentinels first: where the spec defines a no-change value (NaN
  // "keep current", -1 "no change"), an absent param must encode it — a
  // zero-fill there is a live command, not an absence (#98b generalized;
  // GCS parity: QGC/MAVSDK transmit exactly these for unspecified fields).
  for (const [idxStr, val] of Object.entries(preset.blankParams || {})) {
    out[Number(idxStr) - 1] = val;
  }
  for (const [idxStr, val] of Object.entries(preset.pinnedParams)) {
    const i = Number(idxStr);
    out[i - 1] = val;
  }
  for (const idx of preset.exposedParams) {
    const val = userParams[idx];
    // isBlank, not just undefined: Fan-out hands action.params here raw, so a
    // blank string arriving on that path must not clobber a sentinel with ''.
    if (val !== undefined && !isBlank(val)) out[idx - 1] = val;
  }
  return out;
}

module.exports = {
  PRESETS,
  PRESET_BY_ID,
  COMPLETION,
  getPreset,
  presetGroups,
  buildParamArray,
};
