'use strict';

const { isBlank } = require('../addressing/resolve');
const { isHiddenParam } = require('../metadata/commands-list');
const {
  buildCommandLong,
  buildCommandInt,
  CARRIER,
  commandByValue,
} = require('../command');
// Reused, not re-derived: the same operator-degrees→wire-radians and
// euler→quaternion Move already uses for SET_ATTITUDE_TARGET, so the gimbal
// attitude path and Move agree on the rotation convention (§ measurement).
const { degreesToRadians } = require('../move/frames');
const { quaternionFromEuler } = require('../move/attitude');

const MAV_CMD = {
  DO_SET_MODE: 176,
  DO_SET_RELAY: 181,
  DO_REPEAT_RELAY: 182,
  DO_SET_SERVO: 183,
  DO_REPEAT_SERVO: 184,
  DO_SET_CAM_TRIGG_DIST: 206,
  DO_MOUNT_CONFIGURE: 204,
  DO_MOUNT_CONTROL: 205,
  DO_GRIPPER: 211,
  DO_PARACHUTE: 208,
  DO_SET_ROI_LOCATION: 195,
  DO_SET_ROI_NONE: 197,
  IMAGE_START_CAPTURE: 2000,
  IMAGE_STOP_CAPTURE: 2001,
  DO_GIMBAL_MANAGER_PITCHYAW: 1000,
  VIDEO_START_CAPTURE: 2500,
  VIDEO_STOP_CAPTURE: 2501,
  SET_CAMERA_MODE: 530,
  SET_CAMERA_ZOOM: 531,
  SET_CAMERA_FOCUS: 532,
  DO_WINCH: 42600,
};

/**
 * One recipe per topic|verb|path — shared by the wire builder and editor tips
 * (DESIGN.md §6). Tip *text* is never stored here; only which command/message
 * slot each UI field occupies.
 *
 * Command `params` are 1-based MAV_CMD slots (array index 0 → param1). `null`
 * pads an unused slot. `field` is the editor input id stem (`modeValue`);
 * optional `valueKey` is the runtime `values` key when it differs (`mode`).
 * `pinned: true` marks a slot the recipe fills to make the verb work at all —
 * it takes its `default` and gets no control, so the key set here is exactly
 * the set of fields the dialog renders.
 *
 * @type {Object<string, object>}
 */
const PAYLOAD_RECIPES = {
  'camera|photo|': {
    kind: 'command',
    command: MAV_CMD.IMAGE_START_CAPTURE,
    params: [
      { field: 'cameraId', default: 0 },
      { field: 'interval', default: 0 },
      { field: 'count', default: 1 },
      { field: 'sequence', default: 0 },
    ],
  },
  'camera|stop-photo|': {
    kind: 'command',
    command: MAV_CMD.IMAGE_STOP_CAPTURE,
    // The verb exists because photo exposes `count` and an explicit 0 starts a
    // continuous capture the node could otherwise never stop (§9 payload
    // topics, #259). Camera id only: the dialect marks params 2-7 reserved.
    params: [{ field: 'cameraId', default: 0 }],
  },
  'camera|start-video|': {
    kind: 'command',
    command: MAV_CMD.VIDEO_START_CAPTURE,
    params: [
      { field: 'streamId', default: 0 },
      { field: 'statusFrequency', default: 0 },
    ],
  },
  'camera|stop-video|': {
    kind: 'command',
    command: MAV_CMD.VIDEO_STOP_CAPTURE,
    params: [{ field: 'streamId', default: 0 }],
  },
  'camera|set-mode|': {
    kind: 'command',
    command: MAV_CMD.SET_CAMERA_MODE,
    params: [
      { field: 'cameraId', default: 0 },
      { field: 'modeValue', valueKey: 'mode', default: 0 },
    ],
  },
  'camera|trigger-distance|': {
    kind: 'command',
    command: MAV_CMD.DO_SET_CAM_TRIGG_DIST,
    params: [
      { field: 'distance', default: 0 },
      { field: 'shutter', default: 0 },
      { field: 'trigger', default: 1 },
    ],
  },
  'camera|zoom|': {
    kind: 'command',
    command: MAV_CMD.SET_CAMERA_ZOOM,
    // Zoom type is a CAMERA_ZOOM_TYPE enum the dialect carries, so it renders
    // as a select; RANGE (2) is the friendly 0..100 level and the default the
    // dialog lands on. Zoom value is that level, or a step/rate under the other
    // types — a bare number, per param2 carrying no enum.
    params: [
      { field: 'zoomTypeValue', valueKey: 'zoomType', default: 2 },
      { field: 'zoomValue', valueKey: 'zoom', default: 0 },
      { field: 'cameraId', default: 0 },
    ],
  },
  'camera|focus|': {
    kind: 'command',
    command: MAV_CMD.SET_CAMERA_FOCUS,
    // Focus type is a SET_FOCUS_TYPE enum (STEP/CONTINUOUS/RANGE/METERS/AUTO…);
    // RANGE (2) is the 0..100 level, the same friendly default as zoom.
    params: [
      { field: 'focusTypeValue', valueKey: 'focusType', default: 2 },
      { field: 'focusValue', valueKey: 'focus', default: 0 },
      { field: 'cameraId', default: 0 },
    ],
  },
  'gimbal|aim|legacy': {
    kind: 'command',
    command: MAV_CMD.DO_MOUNT_CONTROL,
    params: [
      { field: 'pitch', default: 0 },
      { field: 'roll', default: 0 },
      { field: 'yaw', default: 0 },
      null,
      null,
      null,
      // Pinned, not offered: DO_MOUNT_CONTROL only obeys pitch/roll/yaw in
      // MAV_MOUNT_MODE_MAVLINK_TARGETING (2). Any other mode makes the aim a
      // no-op, so this is what the verb *is*, not a choice. Use the gimbal
      // set-mode verb to change mount mode.
      { field: 'modeValue', valueKey: 'mode', default: 2, pinned: true },
    ],
  },
  'gimbal|aim|manager': {
    kind: 'message',
    message: 'GIMBAL_MANAGER_SET_PITCHYAW',
    fields: [
      { field: 'flags', wire: 'flags', default: 0 },
      { field: 'gimbalDeviceId', wire: 'gimbal_device_id', default: 0 },
      // GIMBAL_MANAGER_SET_PITCHYAW selects angle vs rate control by NaN-ing the
      // unused pair (the dialect marks all four invalid=NaN). Rates default to
      // NaN so an angle aim does not also command a zero rate — which some
      // firmwares read as ambiguous and silently drop (issue #87).
      { field: 'pitch', wire: 'pitch', default: 0 },
      { field: 'yaw', wire: 'yaw', default: 0 },
      { field: 'pitchRate', wire: 'pitch_rate', default: NaN },
      { field: 'yawRate', wire: 'yaw_rate', default: NaN },
    ],
  },
  'gimbal|aim|manager-cmd': {
    kind: 'command',
    command: MAV_CMD.DO_GIMBAL_MANAGER_PITCHYAW,
    // COMMAND_INT's default is to scale param5/6 as coordinates; here param5
    // is the manager flags bitmask and param6 is reserved — raw numbers, the
    // same answer intCoordKinds derives from `hasLocation: false` for the
    // Command node.
    coordKinds: { 5: 'raw', 6: 'raw' },
    // Same inputs as the manager message recipe above, on purpose: the two
    // manager paths differ only in whether the aim acks (§9 payload topics,
    // #257 — the command form acks, the message form cannot). Rates default
    // to NaN for the same issue-#87 reason: an angle aim must not also
    // command a zero rate.
    params: [
      { field: 'pitch', default: 0 },
      { field: 'yaw', default: 0 },
      { field: 'pitchRate', default: NaN },
      { field: 'yawRate', default: NaN },
      { field: 'flags', default: 0 },
      null,
      { field: 'gimbalDeviceId', default: 0 },
    ],
  },
  'gimbal|aim|attitude': {
    kind: 'message',
    message: 'GIMBAL_MANAGER_SET_ATTITUDE',
    // The fourth aim path: full roll/pitch/yaw attitude, where the three
    // pitch/yaw paths carry pitch and yaw only. The wire field `q` is a
    // quaternion float[4]; operators think in degrees, so the dialog offers
    // roll/pitch/yaw and the recipe derives `q` from them (euler slot). The
    // angular_velocity_* triple defaults to NaN — the dialect's "ignore"
    // sentinel — so a static attitude is not read as "hold zero rate" (the same
    // issue-#87 reasoning the manager pitch/yaw paths follow for their rates).
    fields: [
      { field: 'flags', wire: 'flags', default: 0 },
      { field: 'gimbalDeviceId', wire: 'gimbal_device_id', default: 0 },
      {
        // The one non-scalar slot: `q` is derived from three friendly-degree
        // inputs by Move's shared quaternionFromEuler, not taken from one field.
        wire: 'q',
        euler: [
          { field: 'roll', label: 'Roll', units: 'deg', default: 0 },
          { field: 'pitch', label: 'Pitch', units: 'deg', default: 0 },
          { field: 'yaw', label: 'Yaw', units: 'deg', default: 0 },
        ],
      },
      { field: 'rollRate', wire: 'angular_velocity_x', default: NaN },
      { field: 'pitchRate', wire: 'angular_velocity_y', default: NaN },
      { field: 'yawRate', wire: 'angular_velocity_z', default: NaN },
    ],
  },
  'gimbal|set-mode|': {
    kind: 'command',
    command: MAV_CMD.DO_MOUNT_CONFIGURE,
    params: [
      { field: 'modeValue', valueKey: 'mode', default: 0 },
      { field: 'stabilizeRoll', default: 0 },
      { field: 'stabilizePitch', default: 0 },
      { field: 'stabilizeYaw', default: 0 },
    ],
  },
  'gimbal|roi-set|': {
    kind: 'command',
    command: MAV_CMD.DO_SET_ROI_LOCATION,
    params: [
      null,
      null,
      null,
      null,
      // No defaults: an ROI is the point being aimed at, and a blank field
      // silently becoming 0 aims the camera at the Gulf of Guinea rather than
      // failing (§9, §10 "blank coordinates must not become 0,0").
      { field: 'lat', required: true },
      { field: 'lon', required: true },
      { field: 'alt', required: true },
    ],
  },
  'gimbal|roi-clear|': {
    kind: 'command',
    command: MAV_CMD.DO_SET_ROI_NONE,
    params: [],
  },
  'servo|set|': {
    kind: 'command',
    command: MAV_CMD.DO_SET_SERVO,
    params: [
      { field: 'servo', default: 0 },
      { field: 'pwm', default: 0 },
    ],
  },
  'servo|repeat|': {
    kind: 'command',
    command: MAV_CMD.DO_REPEAT_SERVO,
    params: [
      { field: 'servo', default: 0 },
      { field: 'pwm', default: 0 },
      { field: 'count', default: 0 },
      { field: 'period', default: 0 },
    ],
  },
  'gripper|operate|': {
    kind: 'command',
    command: MAV_CMD.DO_GRIPPER,
    params: [
      { field: 'instance', default: 0 },
      { field: 'actionValue', valueKey: 'action', default: 0 },
    ],
  },
  'winch|operate|': {
    kind: 'command',
    command: MAV_CMD.DO_WINCH,
    params: [
      { field: 'instance', default: 0 },
      { field: 'actionValue', valueKey: 'action', default: 0 },
      { field: 'length', default: 0 },
      { field: 'rate', default: 0 },
    ],
  },
  'parachute|operate|': {
    kind: 'command',
    command: MAV_CMD.DO_PARACHUTE,
    params: [{ field: 'actionValue', valueKey: 'action', default: 0 }],
  },
  'relay|set|': {
    kind: 'command',
    command: MAV_CMD.DO_SET_RELAY,
    // Setting carries no enum in the dialect (it is a plain 0/1), so §6 renders
    // it as a number the same as any unannotated param — off (0) by default.
    params: [
      { field: 'instance', default: 0 },
      { field: 'setting', default: 0 },
    ],
  },
  'relay|repeat|': {
    kind: 'command',
    command: MAV_CMD.DO_REPEAT_RELAY,
    params: [
      { field: 'instance', default: 0 },
      { field: 'count', default: 1 },
      { field: 'period', default: 1 },
    ],
  },
};

/**
 * The gimbal-aim path (legacy/manager/manager-cmd/attitude) composes into the
 * recipe key. No `|| 'legacy'` default: a blank or unknown path misses, so recipeFor
 * returns null and buildPayloadMessage craters on the null recipe the same as
 * any other unmapped topic/verb — a blank path is not a routing choice we get
 * to pick.
 *
 * @param {string} topic
 * @param {string} verb
 * @param {string} [path]
 * @returns {object|null}
 */
function recipeFor(topic, verb, path) {
  const pathKey = topic === 'gimbal' && verb === 'aim' ? path : '';
  return PAYLOAD_RECIPES[`${topic}|${verb}|${pathKey}`] || null;
}

/**
 * Build one payload-control MAVLink message plus its confirmation mechanism.
 * Command-backed verbs confirm through COMMAND_ACK; gimbal-manager setpoint
 * messages have no acknowledgement and must not be presented as acked.
 *
 * @param {object} input
 * @returns {{message: object, confirmation: 'command_ack'|'none'}}
 */
function buildPayloadMessage(input) {
  // A topic/verb pair with no recipe selects no builder and craters here —
  // the editor's Topic and Verb selects are the vocabulary.
  return buildFromRecipe(
    recipeFor(input.topic, input.verb, input.path),
    input.target, input.values, input.carrier, input.frame
  );
}

/**
 * @param {object} recipe
 * @param {{sysid:number,compid:number}} target
 * @param {object} values
 * @param {string} [carrier]  CARRIER member; non-members crater in commandBacked (§5, §9)
 * @param {number} [frame]  MAV_FRAME for the INT carrier
 * @returns {{message: object, confirmation: 'command_ack'|'none'}|undefined}
 *   undefined for a kind no case answers to (§5) — the caller craters on the
 *   missing message
 */
function buildFromRecipe(recipe, target, values, carrier, frame) {
  switch (recipe.kind) {
    case 'message': {
      /** @type {Object<string, number>} */
      const fields = {
        target_system: target.sysid,
        target_component: target.compid,
      };
      for (const slot of recipe.fields) {
        fields[slot.wire] = slot.euler
          ? quaternionFromEuler(...slot.euler.map((s) => degreesToRadians(slotValue(values, s))))
          : slotValue(values, slot);
      }
      return {
        confirmation: 'none',
        message: { name: recipe.message, fields },
      };
    }
    case 'command': {
      const params = recipe.params.map((slot) => (
        slot ? slotValue(values, slot) : 0
      ));
      return commandBacked(target, recipe.command, params, carrier, frame, recipe.coordKinds);
    }
    default: break; // This space intentionally left blank (§5)
  }
  // An unmatched kind selects no builder; PAYLOAD_RECIPES is the vocabulary,
  // and the caller craters on the missing message.
  return undefined; // nothing matched: no behavior selected (§5)
}

/**
 * @param {object} values
 * @param {{field: string, valueKey?: string, default?: number, required?: boolean, pinned?: boolean}} slot
 *   `required` is metadata for the editor (fieldMetaFromBundle), not a runtime
 *   check. A blank operator/msg value passes through unset — incomplete info
 *   must not invent recipe defaults or 0 (§0). Pinned slots are recipe-owned
 *   constants. Unset integers fail at the wire poison-init choke.
 * @returns {number|undefined}
 */
function slotValue(values, slot) {
  const primary = slot.valueKey || slot.field;
  if (!isBlank(values[primary])) return Number(values[primary]);
  if (slot.valueKey && !isBlank(values[slot.field])) {
    return Number(values[slot.field]);
  }
  if (slot.pinned) return Number(slot.default);
  // Dialect "unused" float sentinel (invalid=NaN) when the recipe names it —
  // not inventing a safe 0 for a blank coordinate.
  if (Object.prototype.hasOwnProperty.call(slot, 'default') && Number.isNaN(slot.default)) {
    return NaN;
  }
  return undefined;
}

/**
 * Normalize a dialect param/field row into an editor field descriptor.
 *
 * Everything the dialog needs to render one control: the label it is given,
 * the hover text, the unit hint, the numeric constraints, and the enum family
 * when the value is categorical (§6 — control type follows the metadata).
 *
 * `bitmask` says the enum is a set, not a choice — `GIMBAL_MANAGER_SET_PITCHYAW`
 * flags is the payload case. Command params carry `bitmask: true`, message
 * fields carry `display: 'bitmask'`; both mean the same thing here, and
 * without it a generated form would offer one flag where several are legal.
 *
 * @param {{label?: *, description?: *, units?: *, minValue?: *, maxValue?: *,
 *          increment?: *, enum?: *, bitmask?: *, display?: *}|null|undefined} row
 * @param {{allowHidden?: boolean}} [opts]
 * @returns {{label: string, description: string, units: string,
 *            minValue: ?number, maxValue: ?number, increment: ?number,
 *            enum: string, bitmask: boolean}}
 */
function metaFromRow(row, opts) {
  const empty = {
    label: '',
    description: '',
    units: '',
    minValue: null,
    maxValue: null,
    increment: null,
    enum: '',
    bitmask: false,
  };
  if (!row) return empty;
  if (!(opts && opts.allowHidden) && isHiddenParam(row)) return empty;
  const num = (value) => (!isBlank(value) && Number.isFinite(Number(value)) ? Number(value) : null);
  const enumName = row.enum != null ? String(row.enum).trim() : '';
  // Command param rows carry no `bitmask` key of their own — only the catalog
  // path (metadata/commands-list.js) derives one — so the acked gimbal-manager
  // `flags` rendered as a single choice where 28 (ROLL|PITCH|YAW_LOCK) is
  // legal, while the message-form twin rendered a multi-select for the same
  // GIMBAL_MANAGER_FLAGS field. Resolve it from the backing enum, the source
  // commands-list.js already uses, so both manager paths agree.
  const enumTable = enumName && opts && opts.enums ? opts.enums[enumName] : null;
  return {
    label: row.label != null ? String(row.label).trim() : '',
    description: row.description != null ? String(row.description).trim() : '',
    units: row.units != null ? String(row.units).trim() : '',
    minValue: num(row.minValue),
    maxValue: num(row.maxValue),
    increment: num(row.increment),
    enum: enumName,
    bitmask: !!row.bitmask || row.display === 'bitmask' || !!(enumTable && enumTable.bitmask),
  };
}

/**
 * Dialect meta for one MAV_CMD param index (description + units).
 *
 * @param {object} bundle
 * @param {number} commandId
 * @param {number} paramIndex  1–7
 * @returns {{description: string, units: string}}
 */
function metaForCommandParam(bundle, commandId, paramIndex) {
  const cmd = commandByValue(bundle, commandId);
  if (!cmd) return { description: '', units: '' };
  const param = (cmd.params || []).find((p) => Number(p.index) === Number(paramIndex));
  return metaFromRow(param);
}

/**
 * @param {object} bundle
 * @param {number} commandId
 * @param {number} paramIndex
 * @returns {string}
 */
function descriptionForCommandParam(bundle, commandId, paramIndex) {
  return metaForCommandParam(bundle, commandId, paramIndex).description;
}

/**
 * Join {@link PAYLOAD_RECIPES} to a dialect bundle for editor tips and inline
 * units (DESIGN.md §6 — description → title, units → inline hint).
 *
 * @param {object} bundle  DialectBundle
 * @param {string} topic
 * @param {string} verb
 * @param {string} [path]
 * @returns {Object<string, {description: string, units: string}>}
 */
function fieldMetaFromBundle(bundle, topic, verb, path) {
  const recipe = recipeFor(topic, verb, path);
  /** @type {Object<string, object>} */
  const out = {};
  if (!recipe || !bundle) return out;

  // An entry per slot, even when the dialect has nothing to say about it: the
  // key set *is* the field list the dialog renders, so dropping the quiet ones
  // would silently hide a control. The editor keys rows by `valueKey` where a
  // slot has one (`modeValue` → `mode`), matching `#row-payload-<key>`.
  // The recipe's default, not the XML's: the recipe is what the builder
  // actually falls back to, so it is what the dialog must show. Non-finite
  // defaults (the gimbal manager's NaN rates, meaning "axis not rate
  // controlled") carry as null so the field renders blank rather than "NaN".
  const withDefault = (meta, slot) => Object.assign(meta, {
    default: Number.isFinite(slot.default) ? slot.default : null,
    // Carried for the dialog: a slot the wire has no sentinel for must red
    // when it is blank, and the editor is where that lives (§0).
    required: Boolean(slot.required),
  });

  switch (recipe.kind) {
    case 'command': {
      const cmd = commandByValue(bundle, recipe.command);
      recipe.params.forEach((slot, i) => {
        if (!slot || slot.pinned) return;
        const param = cmd
          ? (cmd.params || []).find((p) => Number(p.index) === Number(i + 1))
          : null;
        out[slot.valueKey || slot.field] = withDefault(
          metaFromRow(param, { enums: bundle.enums }),
          slot
        );
      });
      break;
    }
    case 'message': {
      const message = bundle.messages && bundle.messages[recipe.message];
      for (const slot of recipe.fields) {
        // A euler slot has no single wire row to read a label from — its inputs
        // are synthetic (roll/pitch/yaw degrees feeding one quaternion), so the
        // recipe carries their labels/units and the dialog renders one control
        // per input.
        if (slot.euler) {
          for (const input of slot.euler) {
            out[input.field] = withDefault(
              Object.assign(metaFromRow(null), {
                label: input.label || '',
                units: input.units || '',
              }),
              input
            );
          }
          continue;
        }
        const f = message
          ? (message.fields || []).find((row) => row.name === slot.wire)
          : null;
        out[slot.valueKey || slot.field] = withDefault(
          metaFromRow(f, { allowHidden: true }),
          slot
        );
      }
      break;
    }
    default: break; // This space intentionally left blank (§5)
  }
  // An unmatched kind derives no fields — the same empty answer as the soft
  // no-recipe path above (§5).
  return out;
}

/**
 * Whether the carrier choice is observable for a payload verb.
 *
 * COMMAND_INT and COMMAND_LONG carry params 1–4 identically; they differ only
 * in param5/6/7, which COMMAND_INT scales into x/y/z. So the carrier is a real
 * choice only for a command the dialect marks as carrying a location — of the
 * payload recipes that is `gimbal|roi-set` alone. Everywhere else the operator
 * would be picking between two identical messages (§6: do not ask what the
 * answer cannot depend on).
 *
 * @param {object} bundle  DialectBundle
 * @param {string} topic
 * @param {string} verb
 * @param {string} [path]
 * @returns {boolean}
 */
function carrierMattersFor(bundle, topic, verb, path) {
  const recipe = recipeFor(topic, verb, path);
  if (!recipe || recipe.kind !== 'command' || !bundle) return false;
  const cmd = commandByValue(bundle, recipe.command);
  return !!(cmd && cmd.hasLocation);
}

/**
 * Description-only view of {@link fieldMetaFromBundle} (tip titles).
 *
 * @param {object} bundle
 * @param {string} topic
 * @param {string} verb
 * @param {string} [path]
 * @returns {Object<string, string>}
 */
function fieldTipsFromBundle(bundle, topic, verb, path) {
  /** @type {Object<string, string>} */
  const tips = {};
  const meta = fieldMetaFromBundle(bundle, topic, verb, path);
  for (const [field, entry] of Object.entries(meta)) {
    if (entry.description) tips[field] = entry.description;
  }
  return tips;
}

/**
 * Wire envelope via the shared carrier builders (§9): positional params are
 * canonical degrees, scaled to degE7 by the INT carrier.
 *
 * @param {object} target
 * @param {number} command
 * @param {number[]} params
 * @param {string} carrier  CARRIER member; a non-member (blank included)
 *   selects no builder, so `message` ships undefined and craters at the tier
 *   that touches it — never a silent LONG (§5 affirmative dispatch)
 * @param {number} [frame]  MAV_FRAME for the INT carrier
 * @param {{5: string, 6: string}} [coordKinds]  recipe override for the INT
 *   carrier's param5/6 handling — see the manager-cmd recipe
 * @returns {{message: object, confirmation: 'command_ack'}}
 */
function commandBacked(target, command, params, carrier, frame, coordKinds) {
  // Slots beyond the recipe length pad to 0 (unused MAV_CMD params). A blank
  // slotValue stays unset and must not be re-invented as 0 here.
  const normalized = [0, 1, 2, 3, 4, 5, 6].map((i) => (
    i < params.length ? params[i] : 0
  ));
  let message;
  switch (carrier) {
    case CARRIER.INT:
      message = buildCommandInt(command, target.sysid, target.compid, normalized, { frame, coordKinds });
      break;
    case CARRIER.LONG:
      message = buildCommandLong(command, target.sysid, target.compid, normalized, 0);
      break;
    default: break; // This space intentionally left blank (§5)
  }
  return { confirmation: 'command_ack', message };
}

// A topic is a device bolted to the airframe, always. Gripper, winch and
// parachute are three separate MAV_TYPEs upstream (48 / 42 / 37) with no
// grouping between them, so they stand on their own rather than under an
// invented 'release' heading — which was wrong for a winch anyway, the one
// that spools line back in.
const PAYLOAD_TOPICS = ['camera', 'gimbal', 'servo', 'relay', 'gripper', 'winch', 'parachute'];

const PAYLOAD_VERBS = {
  camera: [
    { value: 'photo', label: 'Photo' },
    { value: 'stop-photo', label: 'Stop photo' },
    { value: 'start-video', label: 'Start video' },
    { value: 'stop-video', label: 'Stop video' },
    { value: 'set-mode', label: 'Set mode' },
    { value: 'zoom', label: 'Zoom' },
    { value: 'focus', label: 'Focus' },
    { value: 'trigger-distance', label: 'Trigger by distance' },
  ],
  gimbal: [
    { value: 'aim', label: 'Aim' },
    { value: 'set-mode', label: 'Set mode' },
    { value: 'roi-set', label: 'ROI set' },
    { value: 'roi-clear', label: 'ROI clear' },
  ],
  servo: [
    { value: 'set', label: 'Set' },
    { value: 'repeat', label: 'Repeat' },
  ],
  // Servo drives an angle, relay switches a circuit — separate MAV_CMDs and
  // separate devices, so relay is its own topic rather than a servo verb. Set
  // and repeat mirror servo's two verbs (DO_SET_RELAY / DO_REPEAT_RELAY).
  relay: [
    { value: 'set', label: 'Set' },
    { value: 'repeat', label: 'Repeat' },
  ],
  // One command each, so one verb each. `operate` is upstream's own word:
  // DO_GRIPPER is "operate a gripper", DO_WINCH is "operate winch". What the
  // device actually does is the action enum, not the verb.
  gripper: [{ value: 'operate', label: 'Operate' }],
  winch: [{ value: 'operate', label: 'Operate' }],
  parachute: [{ value: 'operate', label: 'Operate' }],
};

module.exports = {
  MAV_CMD,
  buildPayloadMessage,
  PAYLOAD_TOPICS,
  PAYLOAD_VERBS,
  PAYLOAD_RECIPES,
  recipeFor,
  descriptionForCommandParam,
  fieldMetaFromBundle,
  carrierMattersFor,
  fieldTipsFromBundle,
};
