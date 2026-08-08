'use strict';

const { isBlank } = require('../addressing/resolve');
const { isHiddenParam } = require('../metadata/commands-list');
const {
  buildCommandLong,
  buildCommandInt,
  CARRIER,
  commandByValue,
} = require('../command');

const MAV_CMD = {
  DO_SET_MODE: 176,
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
  VIDEO_START_CAPTURE: 2500,
  VIDEO_STOP_CAPTURE: 2501,
  SET_CAMERA_MODE: 530,
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
      // firmwares read as ambiguous and silently drop (issue #87). A blank field
      // returns this default without hitting the finite-only valueOr guard.
      { field: 'pitch', wire: 'pitch', default: 0 },
      { field: 'yaw', wire: 'yaw', default: 0 },
      { field: 'pitchRate', wire: 'pitch_rate', default: NaN },
      { field: 'yawRate', wire: 'yaw_rate', default: NaN },
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
};

/**
 * @param {string} topic
 * @param {string} verb
 * @param {string} [path]
 * @returns {object|null}
 */
function recipeFor(topic, verb, path) {
  const pathKey = topic === 'gimbal' && verb === 'aim' ? path || 'legacy' : '';
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
  const topic = input.topic;
  const verb = input.verb;
  const target = input.target;
  const values = input.values || {};
  const recipe = recipeFor(topic, verb, input.path);
  if (!recipe) {
    const label = input.path
      ? `${topic}/${verb}/${input.path}`
      : `${topic}/${verb}`;
    throw new Error(`unknown payload verb ${JSON.stringify(label)}`);
  }
  return buildFromRecipe(recipe, target, values, input.carrier, input.frame);
}

/**
 * @param {object} recipe
 * @param {{sysid:number,compid:number}} target
 * @param {object} values
 * @param {'long'|'int'} [carrier]  required for command-backed recipes (§9)
 * @param {number} [frame]  MAV_FRAME for the INT carrier
 * @returns {{message: object, confirmation: 'command_ack'|'none'}}
 */
function buildFromRecipe(recipe, target, values, carrier, frame) {
  if (recipe.kind === 'message') {
    /** @type {Object<string, number>} */
    const fields = {
      target_system: target.sysid,
      target_component: target.compid,
    };
    for (const slot of recipe.fields || []) {
      fields[slot.wire] = slotValue(values, slot);
    }
    return {
      confirmation: 'none',
      message: { name: recipe.message, fields },
    };
  }
  // Carrier is a required operator choice for command-backed verbs (§9): no
  // default wire form. Message-kind recipes above never reach this check.
  if (carrier !== CARRIER.INT && carrier !== CARRIER.LONG) {
    throw new Error(
      `payload command verb requires carrier 'int' or 'long' (§9), got ${JSON.stringify(carrier)}`
    );
  }
  const params = (recipe.params || []).map((slot) => (
    slot ? slotValue(values, slot) : 0
  ));
  return commandBacked(target, recipe.command, params, carrier, frame);
}

/**
 * @param {object} values
 * @param {{field: string, valueKey?: string, default?: number, required?: boolean}} slot
 * @returns {number}
 */
function slotValue(values, slot) {
  const fallback = slot.default !== undefined ? slot.default : 0;
  const primary = slot.valueKey || slot.field;
  if (!isBlank(values[primary])) return valueOr(values[primary], fallback);
  if (slot.valueKey && !isBlank(values[slot.field])) {
    return valueOr(values[slot.field], fallback);
  }
  if (slot.required) {
    throw new Error(
      `mavlink-payload: ${slot.field} is required (blank coordinates must not become 0,0)`
    );
  }
  return fallback;
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
  return {
    label: row.label != null ? String(row.label).trim() : '',
    description: row.description != null ? String(row.description).trim() : '',
    units: row.units != null ? String(row.units).trim() : '',
    minValue: num(row.minValue),
    maxValue: num(row.maxValue),
    increment: num(row.increment),
    enum: row.enum != null ? String(row.enum).trim() : '',
    bitmask: !!row.bitmask || row.display === 'bitmask',
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
  });

  if (recipe.kind === 'command') {
    const cmd = commandByValue(bundle, recipe.command);
    (recipe.params || []).forEach((slot, i) => {
      if (!slot || slot.pinned) return;
      const param = cmd
        ? (cmd.params || []).find((p) => Number(p.index) === Number(i + 1))
        : null;
      out[slot.valueKey || slot.field] = withDefault(metaFromRow(param), slot);
    });
    return out;
  }

  const message = bundle.messages && bundle.messages[recipe.message];
  for (const slot of recipe.fields || []) {
    const f = message
      ? (message.fields || []).find((row) => row.name === slot.wire)
      : null;
    out[slot.valueKey || slot.field] = withDefault(
      metaFromRow(f, { allowHidden: true }),
      slot
    );
  }
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
 * @param {number[]} [params]
 * @param {'long'|'int'} carrier
 * @param {number} [frame]  MAV_FRAME for the INT carrier
 * @returns {{message: object, confirmation: 'command_ack'}}
 */
function commandBacked(target, command, params = [], carrier, frame) {
  const normalized = [0, 1, 2, 3, 4, 5, 6].map((i) => valueOr(params[i], 0));
  const message = carrier === CARRIER.INT
    ? buildCommandInt(command, target.sysid, target.compid, normalized, { frame })
    : buildCommandLong(command, target.sysid, target.compid, normalized, 0);
  return { confirmation: 'command_ack', message };
}

/**
 * @param {*} value
 * @param {number} fallback
 * @returns {number}
 */
function valueOr(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`expected a finite payload value, got ${JSON.stringify(value)}`);
  return n;
}

// A topic is a device bolted to the airframe, always. Gripper, winch and
// parachute are three separate MAV_TYPEs upstream (48 / 42 / 37) with no
// grouping between them, so they stand on their own rather than under an
// invented 'release' heading — which was wrong for a winch anyway, the one
// that spools line back in.
const PAYLOAD_TOPICS = ['camera', 'gimbal', 'servo', 'gripper', 'winch', 'parachute'];

const PAYLOAD_VERBS = {
  camera: [
    { value: 'photo', label: 'Photo' },
    { value: 'start-video', label: 'Start video' },
    { value: 'stop-video', label: 'Stop video' },
    { value: 'set-mode', label: 'Set mode' },
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
  // One command each, so one verb each. `operate` is upstream's own word:
  // DO_GRIPPER is "operate a gripper", DO_WINCH is "operate winch". What the
  // device actually does is the action enum, not the verb.
  gripper: [{ value: 'operate', label: 'Operate' }],
  winch: [{ value: 'operate', label: 'Operate' }],
  parachute: [{ value: 'operate', label: 'Operate' }],
};

/**
 * @param {string} topic
 * @returns {{value: string, label: string}[]}
 */
function verbsForTopic(topic) {
  return PAYLOAD_VERBS[topic] || [];
}

module.exports = {
  MAV_CMD,
  buildPayloadMessage,
  PAYLOAD_TOPICS,
  PAYLOAD_VERBS,
  PAYLOAD_RECIPES,
  verbsForTopic,
  recipeFor,
  descriptionForCommandParam,
  fieldMetaFromBundle,
  carrierMattersFor,
  fieldTipsFromBundle,
};
