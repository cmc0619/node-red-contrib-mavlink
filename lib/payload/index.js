'use strict';

const { isHiddenParam } = require('../metadata/commands-list');
const { buildCommandLong, buildCommandInt, CARRIER } = require('../command');

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
      { field: 'modeValue', valueKey: 'mode', default: 2 },
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
      // No default: blank lat/lon/alt must not become 0,0 (issue #88 / §9).
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
  'release|gripper|': {
    kind: 'command',
    command: MAV_CMD.DO_GRIPPER,
    params: [
      { field: 'instance', default: 0 },
      { field: 'actionValue', valueKey: 'action', default: 0 },
    ],
  },
  'release|winch|': {
    kind: 'command',
    command: MAV_CMD.DO_WINCH,
    params: [
      { field: 'instance', default: 0 },
      { field: 'actionValue', valueKey: 'action', default: 0 },
      { field: 'length', default: 0 },
      { field: 'rate', default: 0 },
    ],
  },
  'release|parachute|': {
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
 * Whether a payload verb rides a MAV_CMD and therefore needs the operator's
 * carrier choice (§9). Message-kind recipes (gimbal manager aiming) never
 * consult the carrier. An unknown verb returns false so the build path can
 * throw its own, more specific "unknown payload verb" error instead of a
 * misleading carrier refusal.
 *
 * @param {string} topic
 * @param {string} verb
 * @param {string} [path]
 * @returns {boolean}
 */
function payloadVerbNeedsCarrier(topic, verb, path) {
  const recipe = recipeFor(topic, verb, path);
  return !!recipe && recipe.kind === 'command';
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
  const primary = slot.valueKey || slot.field;
  if (hasValue(values[primary])) {
    return coerceSlotNumber(values[primary], slot);
  }
  if (slot.valueKey && hasValue(values[slot.field])) {
    return coerceSlotNumber(values[slot.field], slot);
  }
  if (slot.required) {
    throw new Error(
      `${slot.field} requires a value (blank coordinates must not become 0,0)`
    );
  }
  return slot.default !== undefined ? slot.default : 0;
}

/**
 * Preserve an explicit NaN (leave-unchanged on some MAV_CMD slots / §14 #88);
 * otherwise use the finite-only valueOr path.
 *
 * @param {*} value
 * @param {{default?: number}} slot
 * @returns {number}
 */
function coerceSlotNumber(value, slot) {
  if (typeof value === 'number' && Number.isNaN(value)) return NaN;
  if (value === 'NaN') return NaN;
  const fallback = slot.default !== undefined ? slot.default : 0;
  return valueOr(value, fallback);
}

/**
 * @param {*} value
 * @returns {boolean}
 */
function hasValue(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string' && value.trim() === '') return false;
  return true;
}

/**
 * Normalize a dialect param/field row into editor tip meta.
 *
 * @param {{description?: *, units?: *}|null|undefined} row
 * @param {{allowHidden?: boolean}} [opts]
 * @returns {{description: string, units: string}}
 */
function metaFromRow(row, opts) {
  const empty = { description: '', units: '' };
  if (!row) return empty;
  if (!(opts && opts.allowHidden) && isHiddenParam(row)) return empty;
  return {
    description: row.description != null ? String(row.description).trim() : '',
    units: row.units != null ? String(row.units).trim() : '',
  };
}

/**
 * @param {object} bundle
 * @param {number} commandId
 * @returns {object|null}
 */
function commandByValue(bundle, commandId) {
  if (!bundle) return null;
  return Object.values(bundle.commands || {}).find(
    (c) => Number(c.value) === Number(commandId)
  ) || null;
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
 * Dialect meta for one message field (description + units).
 *
 * @param {object} bundle
 * @param {string} messageName
 * @param {string} wireName
 * @returns {{description: string, units: string}}
 */
function metaForMessageField(bundle, messageName, wireName) {
  if (!bundle || !messageName) return { description: '', units: '' };
  const message = bundle.messages && bundle.messages[messageName];
  if (!message) return { description: '', units: '' };
  const f = (message.fields || []).find((row) => row.name === wireName);
  return metaFromRow(f, { allowHidden: true });
}

/**
 * @param {object} bundle
 * @param {string} messageName
 * @param {string} wireName
 * @returns {string}
 */
function descriptionForMessageField(bundle, messageName, wireName) {
  return metaForMessageField(bundle, messageName, wireName).description;
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
  /** @type {Object<string, {description: string, units: string}>} */
  const out = {};
  if (!recipe || !bundle) return out;

  if (recipe.kind === 'command') {
    const cmd = commandByValue(bundle, recipe.command);
    (recipe.params || []).forEach((slot, i) => {
      if (!slot) return;
      const param = cmd
        ? (cmd.params || []).find((p) => Number(p.index) === Number(i + 1))
        : null;
      const meta = metaFromRow(param);
      if (meta.description || meta.units) out[slot.field] = meta;
    });
    return out;
  }

  const message = bundle.messages && bundle.messages[recipe.message];
  for (const slot of recipe.fields || []) {
    const f = message
      ? (message.fields || []).find((row) => row.name === slot.wire)
      : null;
    const meta = metaFromRow(f, { allowHidden: true });
    if (meta.description || meta.units) out[slot.field] = meta;
  }
  return out;
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
 * Structural view of recipes for tests / callers that want field→param maps.
 * Prefer {@link recipeFor} / {@link fieldTipsFromBundle} for new code.
 *
 * @returns {Object<string, {
 *   kind: 'command'|'message',
 *   command?: number,
 *   message?: string,
 *   fields: Object<string, number|string>
 * }>}
 */
function editorFieldBindings() {
  /** @type {Object<string, object>} */
  const out = {};
  for (const [key, recipe] of Object.entries(PAYLOAD_RECIPES)) {
    if (recipe.kind === 'command') {
      /** @type {Object<string, number>} */
      const fields = {};
      (recipe.params || []).forEach((slot, i) => {
        if (slot) fields[slot.field] = i + 1;
      });
      out[key] = { kind: 'command', command: recipe.command, fields };
    } else {
      /** @type {Object<string, string>} */
      const fields = {};
      for (const slot of recipe.fields || []) {
        fields[slot.field] = slot.wire;
      }
      out[key] = { kind: 'message', message: recipe.message, fields };
    }
  }
  return out;
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
  // Explicit NaN is a COMMAND_LONG leave-unchanged token (§14 #88) — preserve it.
  if (typeof value === 'number' && Number.isNaN(value)) return NaN;
  if (value === 'NaN') return NaN;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`expected a finite payload value, got ${JSON.stringify(value)}`);
  return n;
}

const PAYLOAD_TOPICS = ['camera', 'gimbal', 'servo', 'release'];

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
  release: [
    { value: 'gripper', label: 'Gripper' },
    { value: 'winch', label: 'Winch' },
    { value: 'parachute', label: 'Parachute' },
  ],
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
  payloadVerbNeedsCarrier,
  PAYLOAD_TOPICS,
  PAYLOAD_VERBS,
  PAYLOAD_RECIPES,
  verbsForTopic,
  recipeFor,
  metaFromRow,
  commandByValue,
  metaForCommandParam,
  metaForMessageField,
  descriptionForCommandParam,
  descriptionForMessageField,
  editorFieldBindings,
  fieldMetaFromBundle,
  fieldTipsFromBundle,
};
