/**
 * Shared MAVLink editor helpers, loaded once for every node dialog.
 *
 * Node-RED serves this file at
 * `resources/@cmc0619/node-red-contrib-mavlink/mavlink-editor.js` (DESIGN.md §6,
 * https://nodered.org/docs/creating-nodes/resources). Each node HTML loads it
 * with a relative `<script src>`; Node-RED's `appendConfig` defers every inline
 * node script until this external script's `onload` fires, so `RED.mavlink.*`
 * is defined before any `registerType` runs.
 *
 * This is the browser (editor) half of the toolkit. It owns the config-node
 * picker, the enum/dialect catalog helpers, the role × tier matrix source
 * (`resolveCatalogTarget`), the shared catalog fetch (`loadCatalog`), Target
 * CompID reload (`reloadTargetCompId`), the payload verb catalog
 * (`PAYLOAD_VERBS` / `refreshVerbOptions`), bitmask select helpers, and the
 * Build-tier dialect/vehicle/firmware default descriptors + validators
 * (`buildTierDialectDefaults`). Local-Identity keeps only its role presets and
 * identity-specific validators.
 */
(function () {
  RED.mavlink = RED.mavlink || {};

  /**
   * Ensure a config-node property uses Node-RED's standard <select> plus
   * edit (pencil) and add (+) buttons (DESIGN.md §6).
   *
   * Node-RED builds this before oneditprepare when defaults[prop].type names
   * a registered config type. Call from oneditprepare as a safety net when
   * the field is still free-form or a buttonless <select>.
   *
   * @param {object} node
   * @param {string} property
   * @param {string} type
   * @param {string} [prefix]
   */
  RED.mavlink.ensureConfigNodePicker = function (node, property, type, prefix) {
    prefix = prefix || 'node-input';
    if ($('#' + prefix + '-btn-' + property + '-add').length) {
      return;
    }

    var typeDef = RED.nodes.getType(type);
    var $el = $('#' + prefix + '-' + property);
    if (!$el.length) return;

    if (!typeDef || typeDef.category !== 'config') {
      if ($el.is('input[type="text"]') || ($el.is('input') && !$el.attr('type'))) {
        $el.prop('readonly', true)
          .attr(
            'placeholder',
            type + ' not loaded — check Node-RED log / dependencies'
          );
      }
      return;
    }

    if ($el.is('select')) {
      var val = $el.val();
      var style = $el.attr('style') || 'width:70%';
      var $input = $('<input type="text">')
        .attr('id', prefix + '-' + property)
        .attr('style', style);
      if (val) node[property] = val;
      $el.replaceWith($input);
    } else if ($el.attr('type') === 'hidden') {
      return;
    }

    if (typeof RED.editor.prepareConfigNodeSelect === 'function') {
      RED.editor.prepareConfigNodeSelect(node, property, type, prefix);
    }
  };

  /**
   * Shared enum option label. Server catalogs should already include labels,
   * but local/generated entries use the same §6 NAME (value) format
   * (Node twin: `lib/metadata/commands-list.js` `enumOptionLabel`).
   *
   * @param {{name: string, value: number|string}} entry
   * @returns {string}
   */
  RED.mavlink.enumOptionLabel = function (entry) {
    return entry.name + ' (' + entry.value + ')';
  };

  /**
   * Param value types the codec can encode, for the Param editor's Type field.
   * Editor-side copy of `lib/codec/param-union.js` `PARAM_TYPES` — browser HTML
   * cannot require() the Node module. Pinned against that table by test.
   *
   * A deliberate subset of `MAV_PARAM_TYPE`: the enum also has REAL64, INT64
   * and UINT64, which the codec does not encode, so offering them would offer a
   * choice that fails at send. REAL32 leads because it is the field's default.
   */
  RED.mavlink.PARAM_TYPE_OPTIONS = [
    { name: 'MAV_PARAM_TYPE_REAL32', value: 9, label: 'REAL32 (9)' },
    { name: 'MAV_PARAM_TYPE_UINT8', value: 1, label: 'UINT8 (1)' },
    { name: 'MAV_PARAM_TYPE_INT8', value: 2, label: 'INT8 (2)' },
    { name: 'MAV_PARAM_TYPE_UINT16', value: 3, label: 'UINT16 (3)' },
    { name: 'MAV_PARAM_TYPE_INT16', value: 4, label: 'INT16 (4)' },
    { name: 'MAV_PARAM_TYPE_UINT32', value: 5, label: 'UINT32 (5)' },
    { name: 'MAV_PARAM_TYPE_INT32', value: 6, label: 'INT32 (6)' },
  ];

  /**
   * Outbound queue band picker options (DESIGN.md §7). Editor-side copy of
   * `lib/connection/bands` names — browser HTML cannot require() the module.
   * Labels are Title Case (`Emergency (0)`), not screaming-snake enum names.
   */
  RED.mavlink.BAND_OPTIONS = [
    { value: '0', label: 'Emergency (0)' },
    { value: '1', label: 'Liveness (1)' },
    { value: '2', label: 'Control (2)' },
    { value: '3', label: 'Streaming (3)' },
    { value: '4', label: 'Bulk (4)' },
  ];

  /**
   * Fill `#node-input-band` from {@link RED.mavlink.BAND_OPTIONS}.
   *
   * @param {object} $select  jQuery select
   * @param {string|number|undefined|null} saved
   */
  RED.mavlink.fillBandSelect = function ($select, saved) {
    $select.empty();
    RED.mavlink.BAND_OPTIONS.forEach(function (opt) {
      $('<option></option>').val(opt.value).text(opt.label).appendTo($select);
    });
    $select.val(saved !== undefined && saved !== null ? String(saved) : '2');
  };

  /**
   * Editor-side copy of lib/payload `PAYLOAD_VERBS`. Client HTML cannot
   * require() the Node module, so the topic→verb catalog lives once here —
   * Payload and Fan-out both read it. Pinned against the lib table by test.
   */
  RED.mavlink.PAYLOAD_VERBS = {
    camera: [
      { value: 'photo', label: 'Photo' },
      { value: 'start-video', label: 'Start video' },
      { value: 'stop-video', label: 'Stop video' },
      { value: 'set-mode', label: 'Set mode' },
      { value: 'trigger-distance', label: 'Trigger by distance' }
    ],
    gimbal: [
      { value: 'aim', label: 'Aim' },
      { value: 'set-mode', label: 'Set mode' },
      { value: 'roi-set', label: 'ROI set' },
      { value: 'roi-clear', label: 'ROI clear' }
    ],
    servo: [
      { value: 'set', label: 'Set' },
      { value: 'repeat', label: 'Repeat' }
    ],
    gripper: [{ value: 'operate', label: 'Operate' }],
    winch: [{ value: 'operate', label: 'Operate' }],
    parachute: [{ value: 'operate', label: 'Operate' }]
  };

  /**
   * Rebuild `#node-input-verb` options for the selected topic from
   * `PAYLOAD_VERBS`. When `opts.saved` is provided (dialog open), prefer it
   * over the live select value; otherwise keep the current selection if still
   * valid for the new topic.
   *
   * @param {{saved?: string, topicSelector?: string, verbSelector?: string}} [opts]
   */
  RED.mavlink.refreshVerbOptions = function (opts) {
    opts = opts || {};
    var topicSelector = opts.topicSelector || '#node-input-topic';
    var verbSelector = opts.verbSelector || '#node-input-verb';
    var topic = $(topicSelector).val() || 'camera';
    var $verb = $(verbSelector);
    var verbs = RED.mavlink.PAYLOAD_VERBS[topic] || [];
    var saved = Object.prototype.hasOwnProperty.call(opts, 'saved')
      ? (opts.saved || $verb.val())
      : $verb.val();
    $verb.empty();
    for (var i = 0; i < verbs.length; i++) {
      var entry = verbs[i];
      $verb.append($('<option></option>').val(entry.value).text(entry.label));
    }
    var valid = verbs.some(function (v) { return v.value === saved; });
    $verb.val(valid ? saved : (verbs[0] ? verbs[0].value : ''));
  };

  RED.mavlink.payloadVerbIgnoresCarrier = function (topic, verb, path) {
    return topic === 'gimbal' && verb === 'aim' && (path || 'legacy') === 'manager';
  };

  /**
   * Title text for a multi-select bitmask control (Ctrl/Cmd-click hint).
   * @param {string} [description]
   * @returns {string}
   */
  RED.mavlink.bitmaskTitle = function (description) {
    var base = description || 'Bitmask flags';
    return base + ' (Ctrl/Cmd-click to select multiple flags.)';
  };

  /**
   * Display label for a FALSE/TRUE enum entry (`false` / `true`); otherwise
   * the entry's catalog label or name.
   * @param {{name?: string, label?: string}} entry
   * @returns {string}
   */
  RED.mavlink.booleanEntryLabel = function (entry) {
    var name = entry && entry.name ? entry.name : '';
    if (name === 'FALSE' || name.slice(-6) === '_FALSE') return 'false';
    if (name === 'TRUE' || name.slice(-5) === '_TRUE') return 'true';
    return (entry && entry.label) || name;
  };

  /**
   * Checkbox for a FALSE/TRUE enum param (§6: everything enumerable is a
   * control that matches its shape — a two-state enum is a checkbox, not a
   * two-option pulldown the operator has to read before ticking).
   *
   * The true value comes from the dialect entry, never a baked `1`. The box
   * always writes a value: ticked sends the true value, unticked sends 0. A
   * checkbox has two states, so it produces two wire values — never a third
   * "absent" one that means something different again.
   *
   * @param {Array<{name: string, value: string|number, description?: string}>} entries
   * @param {object} [opts]
   * @param {string|number|null} [opts.saved]  saved wire value
   * @param {string} [opts.title]  hover text (the XML description)
   * @param {string} [opts.className]  class the collector scrapes
   * @returns {jQuery} an `<input type="checkbox">` carrying data-kind="boolean"
   */
  RED.mavlink.booleanEnumInput = function (entries, opts) {
    opts = opts || {};
    var trueValue = opts.trueValue !== undefined ? String(opts.trueValue) : null;
    if (trueValue === null) {
      var trueEntry = null;
      for (var i = 0; i < entries.length; i++) {
        var name = entries[i] && entries[i].name ? entries[i].name : '';
        if (name === 'TRUE' || name.slice(-5) === '_TRUE') trueEntry = entries[i];
      }
      trueValue = trueEntry ? String(trueEntry.value) : '1';
    }
    var saved = opts.saved;
    var checked = saved !== undefined && saved !== null && saved !== ''
      && String(saved) === trueValue;
    return $('<input type="checkbox">')
      .addClass(opts.className || '')
      .attr('data-kind', 'boolean')
      .attr('data-true', trueValue)
      .attr('title', opts.title || '')
      .css({ display: 'inline-block', width: 'auto' })
      .prop('checked', checked);
  };

  /**
   * Command params that are booleans in everything but their XML: no `enum=`,
   * just a magic number the description explains in prose. Keyed
   * `<commandId>:<paramIndex>`.
   *
   * This is a deliberate, audited exception to §6's "no baked protocol copy in
   * editor HTML" — see DESIGN.md §14. Only the *value* lives here; the label
   * and hover text still come from the dialect. A survey of all 1110 no-enum
   * command params found exactly one boolean of this shape (the other 17
   * magic-value params are `Target Camera ID`, where 255 means "all cameras" —
   * a sentinel on a numeric id, not an on/off). Adding a second entry here
   * means re-checking that the param really is two-state.
   *
   * @type {Object<string, number>}
   */
  RED.mavlink.MAGIC_BOOLEAN_PARAMS = {
    // MAV_CMD_COMPONENT_ARM_DISARM param2: 0 = respect pre-arm checks,
    // 21196 = force. Upstream never gave it an enum.
    '400:2': 21196,
  };

  /**
   * The magic true value for a no-enum boolean param, or null when the param
   * is an ordinary number.
   *
   * @param {string|number} commandId
   * @param {string|number} paramIndex
   * @returns {?number}
   */
  RED.mavlink.magicBooleanValue = function (commandId, paramIndex) {
    var key = String(commandId) + ':' + String(paramIndex);
    var value = RED.mavlink.MAGIC_BOOLEAN_PARAMS[key];
    return value === undefined ? null : value;
  };

  /**
   * Wire value for a checkbox built by {@link RED.mavlink.booleanEnumInput}.
   *
   * Unchecked is 0, not "omit": `isFalseTrueEnum` only accepts FALSE=0/TRUE=1,
   * and the one magic boolean is 0/21196, so 0 *is* false on both paths. A
   * command param resolves absent to 0 anyway, but a generic message field
   * does not — `lib/codec/message.js` skips names the values object lacks, so
   * omitting would drop the field off the wire entirely.
   *
   * @param {jQuery} $input
   * @returns {number}
   */
  RED.mavlink.booleanEnumValue = function ($input) {
    return $input.is(':checked') ? Number($input.attr('data-true')) : 0;
  };

  /**
   * Which bitmask option values are set in `saved` (numeric mask).
   * @param {string|number|null|undefined} saved
   * @param {Array<{value: string|number}>} entries
   * @returns {string[]}
   */
  RED.mavlink.selectedBitmaskValues = function (saved, entries) {
    if (saved === undefined || saved === null || saved === '') return [];
    var mask;
    try {
      mask = BigInt(String(saved));
    } catch (_e) {
      return [];
    }
    var selected = [];
    var list = entries || [];
    for (var i = 0; i < list.length; i++) {
      var entry = list[i];
      var value;
      try {
        value = BigInt(String(entry.value));
      } catch (_e2) {
        continue;
      }
      if ((value === 0n && mask === 0n) || (value !== 0n && (mask & value) === value)) {
        selected.push(String(entry.value));
      }
    }
    return selected;
  };

  /**
   * Editor-side copy of lib/metadata/naming.js isFalseTrueEnum. Client HTML
   * cannot require() the Node module, so keep this rule mirrored here.
   * Exactly two entries: *_FALSE=0 and *_TRUE=1 (not mixed tables).
   *
   * @param {Array<{name: string, value: number|string}>|null|undefined} entries
   * @returns {boolean}
   */
  RED.mavlink.isFalseTrueEnum = function (entries) {
    if (!Array.isArray(entries) || entries.length !== 2) return false;
    var falseOk = false;
    var trueOk = false;
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      // Require valued objects — never synthesize 0/1 for bare name strings.
      if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string') return false;
      var name = entry.name;
      var isFalse = name === 'FALSE' || name.slice(-6) === '_FALSE';
      var isTrue = name === 'TRUE' || name.slice(-5) === '_TRUE';
      if (!isFalse && !isTrue) return false;
      // Reject null/false/'' — Number(null)===0 would falsely match FALSE=0.
      var rawValue = entry.value;
      if (typeof rawValue !== 'number' && typeof rawValue !== 'string') return false;
      if (typeof rawValue === 'string' && rawValue.trim() === '') return false;
      var value = Number(rawValue);
      if (!Number.isInteger(value)) return false;
      if (isFalse) {
        if (value !== 0 || falseOk) return false;
        falseOk = true;
      } else {
        if (value !== 1 || trueOk) return false;
        trueOk = true;
      }
    }
    return falseOk && trueOk;
  };

  /**
   * Normalize an extra-identity id list: drop blanks, duplicates, and the
   * primary identity — the runtime always binds the primary first, so
   * repeating it would register the same identity twice (issue #94). Pure so
   * the Connection dialog's oneditsave stays glue and this rule is
   * unit-testable without the editableList widget.
   *
   * @param {Array<string|null|undefined>} ids  raw row values, dialog order
   * @param {string} primaryId  the Connection's primary Local Identity id
   * @returns {string[]}
   */
  RED.mavlink.normalizeIdentityIds = function (ids, primaryId) {
    var out = [];
    (ids || []).forEach(function (id) {
      if (!id || id === primaryId || out.indexOf(id) !== -1) return;
      out.push(id);
    });
    return out;
  };

  function valueFromSelector(selector) {
    var $el = $(selector);
    return $el && $el.length ? String($el.val() || '').trim() : '';
  }

  /**
   * Config-node id from an editor property or a deployed Connection's frozen
   * `vehicle` snapshot (`{ id, targetSystem, … }`).
   *
   * @param {string|{id?: string}|null|undefined} ref
   * @returns {string}
   */
  RED.mavlink.vehicleIdFrom = function (ref) {
    if (!ref) return '';
    if (typeof ref === 'string') return ref;
    if (typeof ref === 'object' && typeof ref.id === 'string') return ref.id;
    return '';
  };

  /**
   * Vehicle / dialect query for admin catalog routes (enums, field-tips, …).
   * Catalog source follows the role × tier matrix (DESIGN.md §6): on Build
   * tier the node's own Vehicle Profile / dialect fields govern; on wire tiers
   * the connection's bound profile governs, because that dialect is what the
   * wire will encode. Dialogs without a delivery field keep the
   * connection-derived behaviour.
   *
   * @param {string[]|string} [names]  optional enum table filter for /mavlink/enums
   * @returns {Object<string, string>}
   */
  function currentEnumQuery(names) {
    var query = {};
    // Build-tier detection must match resolveCatalogTarget: most action nodes
    // use `#node-input-delivery`, but mavlink-build uses `#node-input-tier`.
    // Prefer delivery when that control exists; otherwise read tier (Codex #118).
    var mode = (typeof $ !== 'undefined' && $('#node-input-delivery').length)
      ? valueFromSelector('#node-input-delivery')
      : valueFromSelector('#node-input-tier');
    var buildTier = mode === 'build';
    if (buildTier) {
      var buildDialect = valueFromSelector('#node-input-dialect');
      if (buildDialect && buildDialect !== '__vehicle') {
        query.dialect = buildDialect;
      } else if (buildDialect === '__vehicle') {
        var buildVehicle = valueFromSelector('#node-input-vehicle');
        if (buildVehicle) {
          query.vehicle = buildVehicle;
          if (RED.nodes && typeof RED.nodes.node === 'function') {
            var buildProfile = RED.nodes.node(buildVehicle);
            if (buildProfile && buildProfile.dialect) query.dialect = buildProfile.dialect;
          }
        }
      }
      if (!query.dialect && !query.vehicle) return query;
      addEnumNames(query, names);
      return query;
    }

    // Config-node dialogs (Vehicle Profile): dialect lives on the config form,
    // not on a Connection. Must run before the wire-tier connection branch so
    // /mavlink/enums is not called with {} (400 after empty-query rejection).
    var configDialect = valueFromSelector('#node-config-input-dialect');
    if (configDialect && configDialect !== '__vehicle') {
      query.dialect = configDialect;
      addEnumNames(query, names);
      return query;
    }

    var vehicle = '';
    var dialect = '';
    var connection = valueFromSelector('#node-input-connection');
    if (connection && RED.nodes && typeof RED.nodes.node === 'function') {
      var conn = RED.nodes.node(connection);
      vehicle = RED.mavlink.vehicleIdFrom(conn && conn.vehicle);
      var connProfile = vehicle ? RED.nodes.node(vehicle) : null;
      if (connProfile && connProfile.dialect) dialect = connProfile.dialect;
    }
    if (!vehicle) return query;

    if (vehicle) query.vehicle = vehicle;
    if (dialect) query.dialect = dialect;
    addEnumNames(query, names);
    return query;
  }

  function addEnumNames(query, names) {
    if (Array.isArray(names) && names.length) {
      query.names = names.join(',');
    } else if (typeof names === 'string' && names.trim()) {
      query.names = names.trim();
    }
  }
  RED.mavlink.currentCatalogQuery = currentEnumQuery;

  /**
   * Resolve which Vehicle / dialect the editor catalogs (messages, commands,
   * enums, parameter definitions) should load, following the role × tier
   * matrix (DESIGN.md §6):
   *
   *   - Build tier: the Dialect picker governs. A concrete dialect queries by
   *     name; the `from Vehicle Profile…` escape (`__vehicle`) queries by the
   *     selected profile id + its dialect. An empty dialect resolves to no
   *     catalog target — never an invented `ardupilotmega`.
   *   - Wire tiers: the bound Connection's Vehicle Profile governs. No
   *     connection or no bound profile resolves to no catalog target.
   *
   * Profile metadata travels with the profile id, read from the *editor-side*
   * node: a profile created — or edited — and not yet deployed answers for
   * what is on screen, not for what the runtime last saw.
   *
   * The key is the identity of the query, so every field that changes the
   * answer changes the key. Two readers share one shape: a dialog resolves
   * from live fields, while `validate` runs against a saved config with no DOM
   * behind it. Pass `opts.source` for the latter, and the key a load writes is
   * the key a validation reads.
   *
   * @param {object} [opts]
   * @param {object} [opts.source]  saved config read instead of the DOM
   * @param {boolean} [opts.isBuild]  explicit Build-tier override; when omitted
   *   the delivery/tier selector value === 'build' decides.
   * @param {string} [opts.deliverySelector='#node-input-delivery']
   * @param {string} [opts.tierSelector='#node-input-tier']  Build node uses tier
   * @param {string} [opts.dialectSelector='#node-input-dialect']
   * @param {string} [opts.vehicleSelector='#node-input-vehicle']
   * @param {string} [opts.connectionSelector='#node-input-connection']
   * @param {string} [opts.firmwareSelector='#node-input-firmware']
   * @returns {{key: string, query: object|null, dialect: string, vehicleId: string,
   *   firmware: string, vehicleFamily: string}}
   */
  RED.mavlink.resolveCatalogTarget = function (opts) {
    opts = opts || {};
    var dialectSelector = opts.dialectSelector || '#node-input-dialect';
    var vehicleSelector = opts.vehicleSelector || '#node-input-vehicle';
    var connectionSelector = opts.connectionSelector || '#node-input-connection';
    var firmwareSelector = opts.firmwareSelector || '#node-input-firmware';
    var source = opts.source;

    function read(field, selector) {
      if (!source) return valueFromSelector(selector);
      var v = source[field];
      return v === undefined || v === null ? '' : String(v).trim();
    }

    var isBuild;
    if (typeof opts.isBuild === 'boolean') {
      isBuild = opts.isBuild;
    } else {
      var deliverySelector = opts.deliverySelector || '#node-input-delivery';
      var tierSelector = opts.tierSelector || '#node-input-tier';
      var hasDelivery = source
        ? source.delivery !== undefined
        : !!$(deliverySelector).length;
      var mode = hasDelivery
        ? read('delivery', deliverySelector)
        : read('tier', tierSelector);
      isBuild = mode === 'build';
    }

    function empty() {
      return {
        key: 'empty',
        query: null,
        dialect: '',
        vehicleId: '',
        firmware: '',
        vehicleFamily: '',
      };
    }

    // Everything a profile contributes to the answer — dialect, firmware,
    // vehicle family — joins its key, so editing any of them on an undeployed
    // profile misses the cache instead of being served the previous catalog.
    function forProfile(vehicleId) {
      var profile = (vehicleId && RED.nodes && typeof RED.nodes.node === 'function')
        ? RED.nodes.node(vehicleId)
        : null;
      var dialect = (profile && profile.dialect) || '';
      var firmware = (profile && profile.firmware) || '';
      var family = (profile && profile.vehicleFamily) || '';
      var query = { vehicle: vehicleId, dialect: dialect };
      if (firmware) query.firmware = firmware;
      if (family) query.vehicleFamily = family;
      return {
        key: ['vehicle:' + vehicleId, dialect, firmware, family].join('|'),
        query: query,
        dialect: dialect,
        vehicleId: vehicleId,
        firmware: firmware,
        vehicleFamily: family,
      };
    }

    if (isBuild) {
      var dialectVal = read('dialect', dialectSelector);
      if (!dialectVal) return empty();
      if (dialectVal !== '__vehicle') {
        // Firmware is a definition axis, not a dialect one: PX4 and ArduPilot
        // document the same id with different bounds and units. Dialogs
        // without the field read '' and keep their original key.
        var firmwareVal = read('firmware', firmwareSelector);
        var query = { dialect: dialectVal };
        if (firmwareVal) query.firmware = firmwareVal;
        return {
          key: 'dialect:' + dialectVal + (firmwareVal ? '|' + firmwareVal : ''),
          query: query,
          dialect: dialectVal,
          vehicleId: '',
          firmware: firmwareVal,
          vehicleFamily: '',
        };
      }
      var vehicleId = read('vehicle', vehicleSelector);
      if (!vehicleId) return empty();
      return forProfile(vehicleId);
    }

    // Wire tier: the connection's bound Vehicle Profile is the catalog source.
    var connectionId = read('connection', connectionSelector);
    if (connectionId && RED.nodes && typeof RED.nodes.node === 'function') {
      var conn = RED.nodes.node(connectionId);
      var vehicleRef = RED.mavlink.vehicleIdFrom(conn && conn.vehicle);
      if (vehicleRef) return forProfile(vehicleRef);
    }
    return empty();
  };

  /**
   * Build an admin API URL under Node-RED's configured httpAdminRoot.
   * Absolute `/mavlink/...` paths 404 when the editor is mounted at e.g. `/red`.
   *
   * @param {string} path  absolute-looking path, e.g. `/mavlink/enums`
   * @returns {string}
   */
  RED.mavlink.adminApiUrl = function (path) {
    var root = (RED.settings && RED.settings.httpAdminRoot) || '/';
    if (root.slice(-1) !== '/') root += '/';
    return root + String(path || '').replace(/^\//, '');
  };

  /**
   * Populate a Build-tier dialect select without inventing a default dialect.
   * Empty remains selected until the editor's required validator accepts a
   * concrete dialect or the Vehicle Profile escape (§6).
   *
   * @param {object} $select  jQuery select
   * @param {{saved?: string, includeVehicleEscape?: boolean, onReady?: function}} [opts]
   */
  RED.mavlink.populateDialectSelect = function ($select, opts) {
    opts = opts || {};
    var saved = opts.saved !== undefined && opts.saved !== null
      ? String(opts.saved)
      : String($select.val() || '');
    var includeVehicleEscape = opts.includeVehicleEscape !== false;

    function appendOption(value, label) {
      $select.append($('<option></option>').val(value).text(label));
    }

    function hasOption(value) {
      return $select.find('option[value="' + value + '"]').length > 0;
    }

    function finish(dialects) {
      $select.empty();
      appendOption('', '\u2014');
      (dialects || []).forEach(function (dialect) {
        appendOption(String(dialect), String(dialect));
      });
      if (includeVehicleEscape) {
        appendOption('__vehicle', 'from Vehicle Profile\u2026');
      }
      if (saved && !hasOption(saved)) {
        appendOption(saved, saved);
      }
      $select.val(saved || '');
      if (typeof $select.trigger === 'function') {
        $select.trigger('change');
      }
      if (typeof opts.onReady === 'function') {
        opts.onReady();
      }
    }

    // Pin the saved dialect synchronously before the /mavlink/dialects round-trip.
    // Build-tier catalog queries (currentCatalogQuery / loadEnumsCatalog) read
    // #node-input-dialect; if they run while this select is still empty they
    // see no dialect and return an empty enum catalog ("#190 (not in dialect)").
    if (saved) {
      $select.empty();
      appendOption(saved, saved);
      $select.val(saved);
    }

    $.getJSON(RED.mavlink.adminApiUrl('/mavlink/dialects'), function (data) {
      finish((data && data.dialects) || []);
    }).fail(function () {
      finish([]);
    });
  };

  /**
   * Load a shared dialect enum catalog from the admin endpoint.
   * Callers that open dialogs should pass a `{ cancelled: boolean }` token and
   * set `cancelled` from oneditcancel so a late response cannot fill another dialog.
   *
   * @param {string[]|string} names  extra enum table names to include
   * @param {function(object):void} cb
   * @param {{cancelled?: boolean}} [token]
   * @param {{dialect?: string}} [opts]  explicit dialect when the dialog has no
   *   Connection / Vehicle / Dialect row (Local Identity — uses `common` for
   *   MAV_TYPE / MAV_COMPONENT / MAV_AUTOPILOT)
   */
  RED.mavlink.loadEnumsCatalog = function (names, cb, token, opts) {
    opts = opts || {};
    var query = currentEnumQuery(names);
    if (!query.dialect && !query.vehicle && opts.dialect) {
      query.dialect = opts.dialect;
      addEnumNames(query, names);
    }
    // Empty query → 400 on /mavlink/enums; return a local empty catalog instead.
    if (!query.dialect && !query.vehicle) {
      if (!token || !token.cancelled) {
        cb({ dialect: '', enums: {} });
      }
      return;
    }
    $.getJSON(RED.mavlink.adminApiUrl('/mavlink/enums'), query, function (data) {
      if (token && token.cancelled) return;
      cb({
        dialect: data.dialect,
        enums: data.enums || {}
      });
    }).fail(function () {
      if (token && token.cancelled) return;
      cb({ dialect: '', enums: {} });
    });
  };

  /**
   * Label for a saved select value that is not in the current dialect catalog.
   * One wording — `#N (not in dialect)` — for numeric ids and message names.
   *
   * @param {string|number} saved
   * @returns {string}
   */
  RED.mavlink.missingEnumOptionLabel = function (saved) {
    return '#' + String(saved) + ' (not in dialect)';
  };

  /**
   * Append a sentinel option when `saved` is non-empty and absent from `$select`.
   *
   * @param {object} $select  jQuery select
   * @param {string|number|null|undefined} saved
   * @returns {boolean} true when a sentinel was appended
   */
  RED.mavlink.ensureSavedEnumOption = function ($select, saved) {
    if (saved === undefined || saved === null || saved === '') return false;
    var value = String(saved);
    if ($select.find('option[value="' + value + '"]').length) return false;
    $select.append(
      $('<option></option>').val(value).text(RED.mavlink.missingEnumOptionLabel(value))
    );
    return true;
  };

  /**
   * Keep a select's `title` in sync with the selected option's dialect
   * description (§6). Canonical home for the tip-sync idiom used by
   * `fillEnumSelect` and every catalog-backed dropdown.
   *
   * @param {object} $select  jQuery select
   * @param {{namespace?: string}} [opts]  change-event namespace (default mavEnumTip)
   * @returns {function(): void} sync function (for manual re-sync)
   */
  RED.mavlink.bindSelectTitleSync = function ($select, opts) {
    opts = opts || {};
    var ns = opts.namespace || 'mavEnumTip';
    function sync() {
      var tip = $select.find('option:selected').attr('title') || '';
      if (tip) $select.attr('title', tip);
      else $select.removeAttr('title');
    }
    $select.off('change.' + ns).on('change.' + ns, sync);
    sync();
    return sync;
  };

  /**
   * Fill a select from enum entries. Option values are numeric strings so
   * node configs save MAVLink enum ids, not localized labels.
   *
   * `preferLive` inverts which value wins when both a saved one and an
   * in-progress selection exist. The default — saved first — is right for a
   * one-time fill in `oneditprepare`. An *async* refill (a catalog arriving
   * after a Connection change) needs the opposite, or the fill snaps the
   * select back to the pre-edit value the operator has already moved off.
   * Three dialogs open-coded that inversion into a `prefer` local before
   * calling this; the choice belongs to the one function that acts on it.
   *
   * @param {object} $select  jQuery select
   * @param {Array<{name:string,value:number|string,label?:string}>} entries
   * @param {object} opts
   * @param {boolean} [opts.preferLive]  in-progress selection outranks `saved`
   */
  RED.mavlink.fillEnumSelect = function ($select, entries, opts) {
    opts = opts || {};
    var valueKey = opts.valueKey || 'value';
    var live = $select.val();
    // An explicit `saved: ''` means "select nothing"; it is not the same as
    // omitting it, so the default branch keeps testing for undefined/null and
    // not for blankness.
    var savedGiven = opts.saved !== undefined && opts.saved !== null;
    var saved = opts.preferLive && !RED.mavlink.isBlank(live)
      ? String(live)
      : (savedGiven ? String(opts.saved) : String(live || ''));
    $select.empty();
    if (opts.allowEmpty) {
      $select.append($('<option></option>').val('').text(opts.emptyLabel || '\u2014'));
    }
    // `groupOf` puts an entry under an <optgroup>; entries it returns nothing
    // for stay top level. Used to float the components a payload topic
    // plausibly means above the rest of MAV_COMPONENT.
    var groups = {};
    (entries || []).forEach(function (entry) {
      var value = String(entry[valueKey]);
      var label = entry.label || RED.mavlink.enumOptionLabel(entry);
      var $opt = $('<option></option>').val(value).text(label);
      if (entry.description) $opt.attr('title', entry.description);
      var group = typeof opts.groupOf === 'function' ? opts.groupOf(entry) : '';
      if (!group) {
        $select.append($opt);
        return;
      }
      if (!groups[group]) {
        groups[group] = $('<optgroup></optgroup>').attr('label', group);
        $select.append(groups[group]);
      }
      groups[group].append($opt);
    });
    RED.mavlink.ensureSavedEnumOption($select, saved);
    if (saved || opts.allowEmpty) {
      $select.val(saved);
    } else if (entries && entries.length) {
      $select.val(String(entries[0][valueKey]));
    }
    RED.mavlink.bindSelectTitleSync($select, { namespace: opts.titleNamespace || 'mavEnumTip' });
    // Node-RED attaches change→validateNodeEditor before oneditprepare; async
    // fills must re-fire change or a pre-fill `input-error` sticks (§6).
    if (opts.triggerChange !== false && typeof $select.trigger === 'function') {
      $select.trigger('change');
    }
  };

  /**
   * Apply a dialect-sourced description as `title` on an input and its label.
   * Empty/missing text clears any previous tip (no baked fallback).
   *
   * @param {string} inputId  e.g. `node-input-sequence`
   * @param {string} [text]
   */
  RED.mavlink.applyFieldTitle = function (inputId, text) {
    var $input = $('#' + inputId);
    if (!$input.length) return;
    var tip = text != null ? String(text).trim() : '';
    if (tip) $input.attr('title', tip);
    else $input.removeAttr('title');
    var $label = $input.closest('.form-row').find('label').first();
    if ($label.length) {
      if (tip) $label.attr('title', tip);
      else $label.removeAttr('title');
    }
  };

  /**
   * Apply dialect `units` as an inline hint after the input (§6 — units are
   * not tooltip text). Missing units clear the hint (no baked fallback).
   *
   * @param {string} inputId
   * @param {string} [units]
   */
  RED.mavlink.applyFieldUnits = function (inputId, units) {
    var $input = $('#' + inputId);
    if (!$input.length) return;
    var $row = $input.closest('.form-row');
    var $u = $row.children('.mav-field-units');
    if (!$u.length) {
      $u = $('<span class="mav-field-units"></span>');
      $input.after($u);
    }
    var text = units != null ? String(units).trim() : '';
    $u.text(text ? (' ' + text) : '');
  };

  /**
   * Apply dialect tip meta in one call — description → title, units → inline
   * hint. Accepts a string (description only) or `{ description, units }`.
   *
   * @param {string} inputId
   * @param {string|{description?: string, units?: string}|null|undefined} meta
   */
  RED.mavlink.applyFieldMeta = function (inputId, meta) {
    var tip = '';
    var units = '';
    if (typeof meta === 'string') {
      tip = meta;
    } else if (meta && typeof meta === 'object') {
      tip = meta.description || '';
      units = meta.units || '';
    }
    RED.mavlink.applyFieldTitle(inputId, tip);
    RED.mavlink.applyFieldUnits(inputId, units);
  };

  /**
   * Fill a MAV_COMPONENT select; filters can opt into an empty "any component"
   * choice through the same options object.
   */
  RED.mavlink.fillCompIdSelect = function ($select, entries, opts) {
    opts = opts || {};
    if (!opts.suggest) {
      RED.mavlink.fillEnumSelect($select, entries, opts);
      return;
    }
    var split = RED.mavlink.splitCompIdsByTopic(entries, opts.suggest);
    if (!split.suggested.length) {
      RED.mavlink.fillEnumSelect($select, entries, opts);
      return;
    }
    var suggested = split.suggested;
    RED.mavlink.fillEnumSelect($select, suggested.concat(split.others), Object.assign({}, opts, {
      groupOf: function (entry) {
        return suggested.indexOf(entry) !== -1 ? 'Suggested' : 'Other components';
      },
    }));
  };

  /**
   * Reload a Target-compid select from /mavlink/enums (MAV_COMPONENT).
   *
   * Call after `populateDialectSelect` has pinned any saved Build dialect so
   * `currentCatalogQuery` sees it. On later dialect / delivery / connection /
   * Build-vehicle changes, call again — overlapping responses are ignored via
   * a per-select sequence.
   *
   * Once the select has been filled, an explicit empty selection ("profile
   * default") is preserved; `initialSaved` is used only on the first fill.
   *
   * @param {object} $select  jQuery select
   * @param {{initialSaved?: string|number, emptyLabel?: string}} [opts]
   */
  RED.mavlink.reloadCompIdSelect = function ($select, opts) {
    opts = opts || {};
    if (!(RED.mavlink && typeof RED.mavlink.loadEnumsCatalog === 'function')) return;
    if (!$select || !$select.length) return;

    var seqKey = 'mavCompIdSeq';
    var seq = (Number($select.data(seqKey)) || 0) + 1;
    $select.data(seqKey, seq);

    // After the first fill, honour the live value including '' (profile default).
    // Truthiness fallbacks would resurrect a previously saved nonzero compid.
    var initialized = $select.find('option').length > 0;
    var saved = initialized
      ? $select.val()
      : (opts.initialSaved !== undefined && opts.initialSaved !== null
        ? opts.initialSaved
        : $select.val());

    RED.mavlink.loadEnumsCatalog(['MAV_COMPONENT'], function (catalog) {
      if (Number($select.data(seqKey)) !== seq) return;
      RED.mavlink.fillCompIdSelect(
        $select,
        ((catalog || {}).enums || {}).MAV_COMPONENT || [],
        {
          allowEmpty: true,
          emptyLabel: opts.emptyLabel || '(profile default)',
          saved: saved,
          suggest: opts.suggest,
        }
      );
    });
  };

  /**
   * Split MAV_COMPONENT entries into the ones a device topic plausibly means
   * and the rest. Payload topics are device names, so the dialect's own naming
   * does the work: `camera` finds MAV_COMP_ID_CAMERA..CAMERA6, `gimbal` finds
   * seven gimbals, `winch` and `parachute` one each. No table.
   *
   * A suggestion, never a filter — `gripper` matches nothing upstream (its
   * command is autopilot-executed), and a smart servo is not the same thing as
   * the autopilot that drives servo outputs. Everything stays reachable.
   *
   * @param {Array} entries  MAV_COMPONENT catalog entries
   * @param {string} topic   payload topic, e.g. 'gimbal'
   * @returns {{suggested: Array, others: Array}}
   */
  RED.mavlink.splitCompIdsByTopic = function (entries, topic) {
    var all = entries || [];
    var name = String(topic || '').toUpperCase();
    if (!name) return { suggested: [], others: all };
    var suggested = all.filter(function (entry) {
      return String(entry.name || '').toUpperCase().indexOf(name) !== -1;
    });
    if (!suggested.length) return { suggested: [], others: all };
    return {
      suggested: suggested,
      others: all.filter(function (entry) { return suggested.indexOf(entry) === -1; }),
    };
  };

  /**
   * Reload the Target CompID select for a palette node. Thin defaulting wrapper
   * over `reloadCompIdSelect`. Defaults to `targetComponent` (all palette nodes
   * including Command).
   *
   * @param {object} node
   * @param {{field?: string, selector?: string, emptyLabel?: string,
   *   suggest?: string}} [opts]  `suggest` floats the components a payload
   *   topic plausibly means to the top of the list.
   */
  RED.mavlink.reloadTargetCompId = function (node, opts) {
    opts = opts || {};
    var field = opts.field || 'targetComponent';
    var selector = opts.selector || ('#node-input-' + field);
    RED.mavlink.reloadCompIdSelect($(selector), {
      initialSaved: node[field],
      emptyLabel: opts.emptyLabel,
      suggest: opts.suggest,
    });
  };

  /**
   * Shared dialect catalog fetch: resolve target → getJSON → race guard.
   *
   * Caller owns only its request sequence: `{ seq: 0 }`. The catalog travels
   * through the callback.
   *
   * @param {string} endpoint  admin path (`/mavlink/build/messages` or
   *   `/mavlink/command/commands`)
   * @param {{value: object|null, seq: number}} state
   * @param {function(object):void} cb
   * @param {object} [opts]
   * @param {boolean} [opts.isBuild]  resolveCatalogTarget override
   * @param {object} [opts.resolve]   full resolveCatalogTarget opts (wins over isBuild)
   * @param {'messages'|'commands'} [opts.listKey]  empty/success list property
   */
  RED.mavlink.loadCatalog = function (endpoint, state, cb, opts) {
    opts = opts || {};
    cb = typeof cb === 'function' ? cb : function () {};
    state = state || {};
    if (typeof state.seq !== 'number') state.seq = 0;

    var listKey = opts.listKey
      || (String(endpoint).indexOf('/messages') !== -1 ? 'messages' : 'commands');
    var resolveOpts = opts.resolve
      || (typeof opts.isBuild === 'boolean' ? { isBuild: opts.isBuild } : {});
    var target = RED.mavlink.resolveCatalogTarget(resolveOpts);
    state.seq += 1;
    var seq = state.seq;

    function emptyShape(dialect, error) {
      var catalog = { enums: {}, dialect: dialect || '' };
      catalog[listKey] = [];
      if (error !== undefined) catalog.error = error;
      return catalog;
    }

    function fromData(data) {
      var catalog = emptyShape(data.dialect || target.dialect);
      catalog[listKey] = data[listKey] || [];
      catalog.enums = data.enums || {};
      return catalog;
    }

    function render(catalog) {
      cb(catalog);
    }

    if (!target.query) {
      render(emptyShape(''));
      return;
    }

    $.getJSON(RED.mavlink.adminApiUrl(endpoint), target.query, function (data) {
      if (seq !== state.seq) return;
      var catalog = fromData(data || {});
      render(catalog);
    }).fail(function (_xhr, _status, err) {
      if (seq !== state.seq) return;
      render(emptyShape(target.dialect, String(err || 'load failed')));
    });
  };

  /**
   * Normalized role of a Local Identity config node, editor-side.
   * Unknown / unset resolves to 'gcs' (show-everything shape).
   *
   * @param {string} identityId
   * @returns {'gcs'|'companion'|'custom'}
   */
  RED.mavlink.identityRole = function (identityId) {
    var idNode = identityId && RED.nodes && typeof RED.nodes.node === 'function'
      ? RED.nodes.node(identityId)
      : null;
    var role = idNode && idNode.role;
    return role === 'companion' || role === 'custom' ? role : 'gcs';
  };

  /**
   * Identities bound to a Connection (default first, then additionals),
   * optionally filtered by role (§6 matrix: fanout passes ['gcs','custom']).
   *
   * @param {string} connectionId
   * @param {string[]} [rolesAllowed]
   * @returns {Array<{id: string, role: string, label: string}>}
   */
  RED.mavlink.identityOptionsFor = function (connectionId, rolesAllowed) {
    var out = [];
    if (!connectionId || !RED.nodes || typeof RED.nodes.node !== 'function') return out;
    var conn = RED.nodes.node(connectionId);
    if (!conn) return out;
    var ids = [conn.localIdentity].concat(conn.additionalIdentities || []);
    var seen = {};
    ids.forEach(function (id) {
      if (!id || seen[id]) return;
      seen[id] = true;
      var idNode = RED.nodes.node(id);
      if (!idNode) return;
      var role = RED.mavlink.identityRole(id);
      if (rolesAllowed && rolesAllowed.indexOf(role) === -1) return;
      out.push({ id: id, role: role, label: (idNode.name || 'identity') + ' (' + role + ')' });
    });
    return out;
  };

  /**
   * Fill a send-as identity select with the identities bound to the selected
   * connection. When the saved id is not eligible (or empty), the first
   * eligible identity is preselected — and thereby written into config on
   * Done (§6 matrix: prefill is explicit, runtime never infers).
   *
   * @param {object} $select  jQuery select
   * @param {string} connectionId
   * @param {{rolesAllowed?: string[], saved?: string}} [opts]
   * @returns {string} the selected identity id ('' when none eligible)
   */
  RED.mavlink.fillIdentitySelect = function ($select, connectionId, opts) {
    opts = opts || {};
    var options = RED.mavlink.identityOptionsFor(connectionId, opts.rolesAllowed);
    $select.empty();
    options.forEach(function (o) {
      $select.append($('<option></option>').val(o.id).text(o.label));
    });
    var eligible = options.some(function (o) { return o.id === opts.saved; });
    var selected = eligible ? opts.saved : (options.length ? options[0].id : '');
    $select.val(selected);
    return selected;
  };

  /**
   * Reload the send-as identity select from the live Connection picker.
   * Thin defaulting wrapper over `fillIdentitySelect` — Fan-out passes
   * `rolesAllowed: ['gcs','custom']`; everyone else keeps the full set.
   *
   * @param {object} node
   * @param {{rolesAllowed?: string[], connectionSelector?: string, identitySelector?: string}} [opts]
   * @returns {string} selected identity id
   */
  RED.mavlink.refreshIdentitySelect = function (node, opts) {
    opts = opts || {};
    var connectionId = $(opts.connectionSelector || '#node-input-connection').val() || '';
    return RED.mavlink.fillIdentitySelect(
      $(opts.identitySelector || '#node-input-identity'),
      connectionId,
      { saved: node.identity, rolesAllowed: opts.rolesAllowed }
    );
  };

  /**
   * "Nothing was entered" — absent, null, or whitespace.
   *
   * Every optional editor field asks this before deciding a value is worth
   * checking, and it was open-coded identically at seven sites across the
   * palette. One spelling, so "blank" cannot come to mean subtly different
   * things in two dialogs.
   *
   * @param {*} v
   * @returns {boolean}
   */
  RED.mavlink.isBlank = function (v) {
    return v === undefined || v === null || String(v).trim() === '';
  };

  /**
   * The in-progress value of a field, falling back to what was saved.
   *
   * Editor code reads cross-field state in two situations and needs opposite
   * sources for them: while the dialog is open the live input is the truth
   * (the operator may have just changed it), and while it is closed — Node-RED
   * runs `validate` on import and on deploy — jQuery matches nothing and the
   * saved config is all there is. Four call sites had grown their own version
   * of this, differing only in which was checked first.
   *
   * @param {string} selector  jQuery selector for the live field
   * @param {*} saved          the node's saved value
   * @param {*} [fallback='']  when neither answers
   * @returns {string}
   */
  RED.mavlink.liveOr = function (selector, saved, fallback) {
    var $el = $(selector);
    var live = $el && $el.length ? $el.val() : undefined;
    if (!RED.mavlink.isBlank(live)) return String(live);
    if (!RED.mavlink.isBlank(saved)) return String(saved);
    return fallback === undefined ? '' : String(fallback);
  };

  /**
   * Editor-side integer range check for a wire field. Blank is allowed
   * (inherit / optional). Two-argument form so Node-RED treats a returned
   * string as the invalid reason (one-arg validators treat any string as
   * truthy/valid).
   *
   * The bounds are the field's own, taken from the dialect XML — a `uint8_t`
   * is 0–255, an `int16_t` is −32768–32767. A value outside them cannot be
   * encoded, so refusing it in the editor is the difference between a red
   * triangle and a runtime pack error on deploy.
   *
   * @param {number} min
   * @param {number} max
   * @returns {function(*, object=): true|string}
   */
  RED.mavlink.validateIntRange = function (min, max) {
    return function (v, _opt) {
      if (RED.mavlink.isBlank(v)) return true;
      var n = Number(v);
      if (!Number.isInteger(n) || n < min || n > max) {
        return 'must be an integer between ' + min + ' and ' + max;
      }
      return true;
    };
  };

  /**
   * uint8 range check — the common case, kept by name because every target /
   * source id field reads better for it.
   *
   * @param {number} min  0 for target ids (broadcast), 1 for source ids
   * @returns {function(*, object=): true|string}
   */
  RED.mavlink.validateUint8 = function (min) {
    return RED.mavlink.validateIntRange(min, 255);
  };

  /**
   * Shared Build-tier dialect / vehicle / firmware default descriptors and
   * validators for `registerType({ defaults })`. Every Build-tier builder
   * gets the same rule: dialect required on Build; the Vehicle Profile is
   * required only when the dialect is the `__vehicle` escape; and — for
   * Param / Mission — Firmware is required when a concrete non-empty dialect
   * is chosen (the Firmware XOR against the Vehicle Profile escape, §6).
   *
   * Merge the result into the node's `defaults` object (Object.assign).
   *
   * @param {object} [opts]
   * @param {'delivery'|'tier'} [opts.modeField='delivery']  Build node uses tier
   * @param {string} [opts.modeSelector]  DOM selector override
   * @param {string} [opts.dialectSelector='#node-input-dialect']
   * @param {boolean} [opts.withFirmware]  add the Param/Mission Firmware field
   * @returns {object} default descriptors to merge into registerType defaults
   */
  /**
   * The `connection` default descriptor: required on the wire tiers,
   * meaningless on Build. Shared by the tier senders (via
   * buildTierDialectDefaults) and Fan-out, which has no dialect field.
   *
   * Two arguments is load-bearing: Node-RED honours a returned reason
   * string only when the validator's arity is 2, and coerces it with
   * `!!` otherwise (§14 "One-arg editor validators treat an error string
   * as valid"). No `required` key — an explicit `required: false` beside
   * `validate` short-circuits an empty value to valid before the
   * validator runs.
   *
   * @param {object} [opts]
   * @param {'delivery'|'tier'} [opts.modeField='delivery']
   * @param {string} [opts.modeSelector]  DOM selector override
   * @returns {object} descriptor for defaults.connection
   */
  RED.mavlink.connectionDefault = function (opts) {
    opts = opts || {};
    var modeField = opts.modeField || 'delivery';
    var modeSelector = opts.modeSelector || ('#node-input-' + modeField);
    return {
      value: '',
      type: 'mavlink-connection',
      validate: function (v, _opt) {
        if (RED.mavlink.liveOr(modeSelector, this && this[modeField]) === 'build') return true;
        // '_ADD_' is what the platform's "none" option carries until save
        // rewrites it to ''; treat it as blank too, so the field reds while
        // the dialog is still open rather than only after Done.
        if (RED.mavlink.isBlank(v) || v === '_ADD_') return 'is required on this tier';
        // Declaring validate at all suppresses Node-RED's own config-node
        // reference check, so restate it here — without this, a deleted or
        // broken Connection stops being reported.
        var cfg = RED.nodes.node(v);
        if (!cfg) return 'no longer exists — reselect a Connection';
        if (cfg.valid === false) return 'is not properly configured';
        return true;
      },
    };
  };

  RED.mavlink.buildTierDialectDefaults = function (opts) {
    opts = opts || {};
    var modeField = opts.modeField || 'delivery';
    var modeSelector = opts.modeSelector || ('#node-input-' + modeField);
    var dialectSelector = opts.dialectSelector || '#node-input-dialect';

    function currentMode(self) {
      return RED.mavlink.liveOr(modeSelector, self && self[modeField]);
    }
    function currentDialect(self) {
      return RED.mavlink.liveOr(dialectSelector, self && self.dialect);
    }

    var defaults = {
      dialect: {
        value: '',
        validate: function (v) {
          if (currentMode(this) === 'build') return !!v;
          return true;
        },
      },
      connection: RED.mavlink.connectionDefault({ modeField: modeField, modeSelector: modeSelector }),
      vehicle: {
        // No `required: false`. Paired with a validate, it short-circuits an
        // empty value to valid *before* the validator runs (measured on the
        // editor-client), so the Build + `__vehicle` rule below never fired on
        // the blank it exists to catch.
        value: '',
        type: 'mavlink-vehicle',
        validate: function (v) {
          if (currentMode(this) === 'build' && currentDialect(this) === '__vehicle') return !!v;
          return true;
        },
      },
    };

    if (opts.withFirmware) {
      defaults.firmware = {
        value: '',
        validate: function (v) {
          var dialect = currentDialect(this);
          if (currentMode(this) === 'build' && dialect && dialect !== '__vehicle') return !!v;
          return true;
        },
      };
    }

    return defaults;
  };

  /**
   * Show or hide a form row, tolerating a selector that matches nothing —
   * a dialog may legitimately not have every row a shared helper can toggle.
   *
   * @param {string} selector
   * @param {boolean} shown
   */
  RED.mavlink.toggleRow = function (selector, shown) {
    if (!selector) return;
    var $el = $(selector);
    if ($el && $el.length) $el.toggle(!!shown);
  };

  /**
   * Toggle the Build-tier dialect / vehicle / firmware / connection rows from
   * the current dialect + Build state. Thin helper — each node keeps ownership
   * of its remaining role/mode rows; this covers only the shared four.
   *
   * @param {object} opts
   * @param {boolean} opts.isBuild
   * @param {string} [opts.dialect]
   * @param {string} [opts.dialectRow]      jQuery selector, shown on Build
   * @param {string} [opts.vehicleRow]      shown on Build + `__vehicle`
   * @param {string} [opts.firmwareRow]     shown on Build + concrete dialect
   * @param {string} [opts.connectionRow]   shown on wire tiers
   */
  RED.mavlink.applyBuildTierRowVisibility = function (opts) {
    opts = opts || {};
    var isBuild = !!opts.isBuild;
    var dialect = opts.dialect || '';
    var toggle = RED.mavlink.toggleRow;
    toggle(opts.dialectRow, isBuild);
    toggle(opts.vehicleRow, isBuild && dialect === '__vehicle');
    toggle(opts.firmwareRow, isBuild && !!dialect && dialect !== '__vehicle');
    toggle(opts.connectionRow, !isBuild);
  };

  /**
   * §6 companion Send-as identity hides target addressing rows on wire tiers.
   * Build always shows them (must stamp targets). Payload passes
   * `hideCompidWhenCompanion: false` — compid addresses a payload device.
   *
   * @param {object} opts
   * @param {boolean} opts.isBuild
   * @param {string} [opts.identityId='']
   * @param {boolean} [opts.hideCompidWhenCompanion=true]
   * @param {string} [opts.combinedTargetRow]  single sysid+compid row (Command)
   * @param {string} [opts.targetSystemRow]
   * @param {string} [opts.targetComponentRow]
   * @returns {{isCompanion: boolean, targetSystem: boolean, targetComponent: boolean}}
   */
  RED.mavlink.applyCompanionTargetVisibility = function (opts) {
    opts = opts || {};
    var isBuild = !!opts.isBuild;
    var identityId = opts.identityId != null ? opts.identityId : '';
    var hideCompid = opts.hideCompidWhenCompanion !== false;
    var isCompanion = !isBuild && RED.mavlink.identityRole(identityId) === 'companion';
    var targetSystem = isBuild || !isCompanion;
    var targetComponent = hideCompid ? (isBuild || !isCompanion) : true;
    var toggle = RED.mavlink.toggleRow;
    if (opts.combinedTargetRow) toggle(opts.combinedTargetRow, targetSystem);
    toggle(opts.targetSystemRow, targetSystem);
    toggle(opts.targetComponentRow, targetComponent);
    return {
      isCompanion: isCompanion,
      targetSystem: targetSystem,
      targetComponent: targetComponent,
    };
  };
})();
