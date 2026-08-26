'use strict';

/**
 * Connection editor: Vehicle and Identity must use Node-RED's standard
 * config-node select with edit/add buttons (DESIGN.md §6), not free-form ids
 * and not a buttonless <select> fallback.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadNodeDefaults, loadNodeType } = require('./html-assert');

const html = fs.readFileSync(
  path.join(__dirname, '..', '..', 'nodes', 'mavlink-connection.html'),
  'utf8'
);
const identityHtml = fs.readFileSync(
  path.join(__dirname, '..', '..', 'nodes', 'mavlink-local-identity.html'),
  'utf8'
);
// Shared RED.mavlink.* helpers now live in the stock resource file, loaded by
// every node dialog (DESIGN.md §6). Assert their source there, not in the LI HTML.
const resourceScript = fs.readFileSync(
  path.join(__dirname, '..', '..', 'resources', 'mavlink-editor.js'),
  'utf8'
);

test('Vehicle default declares type mavlink-vehicle (config-node picker)', () => {
  assert.match(
    html,
    /vehicle:\s*\{\s*value:\s*''\s*,\s*type:\s*'mavlink-vehicle'/,
    'defaults.vehicle.type must be mavlink-vehicle'
  );
});

test('Identity default declares type mavlink-local-identity', () => {
  assert.match(
    html,
    /localIdentity:\s*\{\s*value:\s*''\s*,\s*type:\s*'mavlink-local-identity'/,
    'defaults.localIdentity.type must be mavlink-local-identity'
  );
});

test('shared ensureConfigNodePicker uses RED.editor.prepareConfigNodeSelect (edit/add)', () => {
  assert.match(
    resourceScript,
    /ensureConfigNodePicker/,
    'helper is defined in the shared editor resource'
  );
  assert.match(
    resourceScript,
    /prepareConfigNodeSelect/,
    'helper must call Node-RED\'s standard config select builder'
  );
  assert.match(
    html,
    /ensureConfigNodePicker\(this,\s*'vehicle'/,
    'Connection oneditprepare asks for the Vehicle picker'
  );
  assert.match(
    html,
    /ensureConfigNodePicker\(\s*this,\s*'localIdentity'/,
    'Connection oneditprepare asks for the Identity picker'
  );
  assert.ok(
    !html.includes('ensureConfigSelect'),
    'buttonless select fallback must be gone'
  );
});

test('additionalIdentities has an editor row (issue #94 — feature must be reachable)', () => {
  // The runtime consumes config.additionalIdentities and the shared editor
  // helper reads conn.additionalIdentities for send-as selects; without this
  // list the feature is only reachable by hand-editing flow JSON.
  assert.match(
    html,
    /additionalIdentities:\s*\{\s*value:\s*\[\]\s*\}/,
    'defaults.additionalIdentities stays declared'
  );
  assert.match(
    html,
    /id="mav-conn-additional-identities"/,
    'template carries the editableList container'
  );
  assert.match(
    html,
    /editableList\(\{/,
    'oneditprepare builds the list with Node-RED\'s stock editableList'
  );
  assert.match(
    html,
    /this\.additionalIdentities\s*=\s*RED\.mavlink\.normalizeIdentityIds\(raw,\s*primary\)/,
    'oneditsave routes through the shared, unit-tested normalizer — the '
      + 'blank/duplicate/primary rules are behaviorally covered in '
      + 'mavlink-editor-resource.test.js, not re-derived here'
  );
});

test('Connection editor keeps swarm delivery separate from MAVLink addressing', () => {
  assert.ok(!html.includes('heartbeatInterval'), 'heartbeat interval belongs to Local Identity');
  // The Swarm address is a *delivery* option — where a `target_system = 0`
  // frame is written. It is not what makes a frame a broadcast; the message
  // field is. The form must offer no control for it, while the help text is
  // the right place to say so out loud.
  const [form, help] = html.split(/<script type="text\/html" data-help-name=/);
  assert.ok(help, 'help block is present');
  assert.ok(
    !/target_system\s*[=:]\s*0/.test(form),
    'no form control may present MAVLink broadcast addressing as a Connection setting'
  );
  assert.match(
    help,
    /target_system = 0[\s\S]{0,200}not a setting here/,
    'help must say plainly that addressing is a frame field, not this dialog'
  );
  assert.ok(
    !/SO_BROADCAST/.test(html),
    'the socket flag is an implementation detail of the address, not a user control'
  );
  assert.match(
    html,
    /row-conn-broadcastHost[\s\S]*toggle\(mode === 'udp'\)/,
    'swarm address is UDP-only — TCP has no broadcast at all'
  );
});

test('Connection editor offers UDP, TCP, and serial without “not yet” stubs', () => {
  assert.match(html, /<option value="udp">UDP<\/option>/);
  assert.match(html, /<option value="tcp">TCP<\/option>/);
  assert.match(html, /<option value="serial">Serial<\/option>/);
  assert.ok(!html.includes('(not yet)'), 'transport options must not be stubbed');
  assert.match(html, /function refreshTransportRows/, 'mode toggles transport field rows');
  assert.match(html, /node-config-input-serialPath/, 'serial path field is present');
  // A closed pulldown, not a number box: the rates are a fixed vocabulary,
  // so the control must not accept anything the list does not offer.
  assert.match(
    html,
    /<select id="node-config-input-baudRate"><\/select>/,
    'baud field is a select, painted from SERIAL_BAUDS'
  );
  assert.match(
    html,
    /serialPath:[\s\S]*validate:[\s\S]*mode !== 'serial'[\s\S]*!RED\.mavlink\.isBlank\(v\)/,
    'serial path is required in serial mode'
  );
});

test('serial path is a live dropdown fed by /mavlink/serial-ports, free text preserved', () => {
  // Behavior (fill, saved-value sentinel, select→input, refresh) is executed
  // in connection-html-serial-ports.test.js; here the wiring is pinned.
  assert.match(
    html,
    /<input type="text" id="node-config-input-serialPath"/,
    'the bound path field stays a free-text input — the dropdown writes into it'
  );
  assert.match(html, /id="mav-conn-serial-ports"/, 'detected-ports select exists');
  assert.match(html, /id="mav-conn-serial-refresh"/, 'refresh button exists');
  assert.match(
    html,
    /RED\.mavlink\.adminApiUrl\('\/mavlink\/serial-ports'\)/,
    'the fetch honours httpAdminRoot (14.31) — never a bare /mavlink path'
  );
  assert.match(
    html,
    /\(saved value\)/,
    'a saved path absent from the enumeration keeps a sentinel option'
  );
  assert.match(
    html,
    /#row-conn-serialPath, #row-conn-serialPorts, #row-conn-baudRate'\)\.toggle\(mode === 'serial'\)/,
    'the dropdown row follows serial mode like the path and baud rows'
  );
  assert.match(
    html,
    /\$\.getJSON\([\s\S]*?\.fail\(function \(\) \{\s*fillSerialPorts\(\[\]\)/,
    'a failed fetch degrades to the empty list, not a stuck dialog'
  );
});

test('remote host/port pairing: one without the other reds, both-or-neither passes', () => {
  // These drive the REAL validators — the html script evaluated whole, the
  // real RED.mavlink resource underneath — with no dialog open, which is the
  // state Node-RED validates in on import and on deploy: the saved config is
  // all there is. The runtime trusts this rule (udp.js sends only with both).
  const defaults = loadNodeDefaults('mavlink-connection');
  const reason = /Remote host and port are a pair/;

  // host set + port blank → reason on the host field
  assert.match(
    String(defaults.remoteHost.validate.call(
      { id: 'c1', mode: 'udp', remotePort: '' }, '10.0.0.9', {}
    )),
    reason
  );
  // port set + host blank → reason on the port field
  assert.match(
    String(defaults.remotePort.validate.call(
      { id: 'c1', mode: 'udp', remoteHost: '' }, '14551', {}
    )),
    reason
  );
  // both blank → listen-only, valid on both fields
  assert.equal(
    defaults.remoteHost.validate.call({ id: 'c1', mode: 'udp', remotePort: '' }, '', {}),
    true
  );
  assert.equal(
    defaults.remotePort.validate.call({ id: 'c1', mode: 'udp', remoteHost: '' }, '', {}),
    true
  );
  // both set → valid on both fields
  assert.equal(
    defaults.remoteHost.validate.call(
      { id: 'c1', mode: 'udp', remotePort: '14551' }, '10.0.0.9', {}
    ),
    true
  );
  assert.equal(
    defaults.remotePort.validate.call(
      { id: 'c1', mode: 'udp', remoteHost: '10.0.0.9' }, '14551', {}
    ),
    true
  );
  // serial mode hides the fields, so a stale half-pair must not red a
  // control the operator cannot see (same gate as bindPort).
  assert.equal(
    defaults.remoteHost.validate.call(
      { id: 'c1', mode: 'serial', remotePort: '' }, '10.0.0.9', {}
    ),
    true
  );
});

test('remote pairing: clearing both live fields switches back to listen-only (Codex, #287)', () => {
  // The other half of the pairing rule: the dialog is OPEN and the operator
  // empties both boxes over a saved full pair. Sibling reads go through
  // ownDialogField, so the emptied box is the answer — a `live || saved`
  // fallback would resurrect the saved sibling and red both fields forever,
  // making a configured remote impossible to un-configure (the #284 emptied-
  // box lesson, one node over).
  const saved = { id: 'c1', mode: 'udp', remoteHost: '10.0.0.9', remotePort: '14551' };
  const open = (dom) => loadNodeDefaults('mavlink-connection', {}, {
    dom, editStack: [{ id: 'c1' }],
  });

  const bothCleared = open({
    '#node-config-input-remoteHost': { val: '' },
    '#node-config-input-remotePort': { val: '' },
  });
  assert.equal(bothCleared.remoteHost.validate.call(saved, '', {}), true,
    'cleared host sees the cleared port, not its ghost');
  assert.equal(bothCleared.remotePort.validate.call(saved, '', {}), true,
    'cleared port sees the cleared host, not its ghost');

  // Clearing only one still reds — the live half-pair is real.
  const halfCleared = open({
    '#node-config-input-remoteHost': { val: '10.0.0.9' },
    '#node-config-input-remotePort': { val: '' },
  });
  assert.match(String(halfCleared.remoteHost.validate.call(saved, '10.0.0.9', {})),
    /Remote host and port are a pair/);

  // Same DOM but another node's dialog on top: these boxes are not this
  // node's answer, so the saved pair stands (#217 scoping).
  const foreign = loadNodeDefaults('mavlink-connection', {}, {
    dom: {
      '#node-config-input-remoteHost': { val: '' },
      '#node-config-input-remotePort': { val: '' },
    },
    editStack: [{ id: 'someone-else' }],
  });
  assert.equal(foreign.remoteHost.validate.call(saved, '10.0.0.9', {}), true,
    'a foreign dialog\'s empty boxes do not clear this node\'s pair');
});

test('transport numeric fields carry range rings; bind host is required for IP modes', () => {
  // The runtime hands these to the socket as saved (§0), so the walled garden
  // owns the ranges: ports are 16-bit and 0 is a silent trap (bind 0 is a
  // random port; a remote/swarm port 0 reads as "no destination" on send).
  const defaults = loadNodeDefaults('mavlink-connection');
  const portReason = /between 1 and 65535/;

  assert.equal(defaults.bindPort.validate.call({ id: 'c1', mode: 'udp' }, '14550', {}), true);
  assert.match(String(defaults.bindPort.validate.call({ id: 'c1', mode: 'udp' }, '0', {})), portReason);
  assert.match(String(defaults.bindPort.validate.call({ id: 'c1', mode: 'tcp' }, '70000', {})), portReason);
  // Serial hides the control, so a stale value must not red what cannot be seen.
  assert.equal(defaults.bindPort.validate.call({ id: 'c1', mode: 'serial' }, '', {}), true);

  assert.equal(defaults.bindHost.validate.call({ id: 'c1', mode: 'udp' }, '0.0.0.0', {}), true);
  assert.match(
    String(defaults.bindHost.validate.call({ id: 'c1', mode: 'tcp' }, '  ', {})),
    /bind host is required/
  );
  assert.equal(defaults.bindHost.validate.call({ id: 'c1', mode: 'serial' }, '', {}), true);

  // Blank remote/swarm ports stay legal (listen-only / no swarm address).
  assert.match(
    String(defaults.remotePort.validate.call(
      { id: 'c1', mode: 'udp', remoteHost: '10.0.0.9' }, '0', {}
    )),
    portReason
  );
  assert.equal(defaults.broadcastPort.validate.call({ id: 'c1' }, '', {}), true);
  assert.match(String(defaults.broadcastPort.validate.call({ id: 'c1' }, '65536', {})), portReason);
  // Hidden by the mode → stale values must not red what cannot be seen:
  // remote is IP-only, swarm is UDP-only (Codex, #331).
  assert.equal(
    defaults.remotePort.validate.call({ id: 'c1', mode: 'serial', remoteHost: '' }, '70000', {}),
    true
  );
  assert.equal(defaults.broadcastPort.validate.call({ id: 'c1', mode: 'tcp' }, '70000', {}), true);
  assert.equal(defaults.broadcastPort.validate.call({ id: 'c1', mode: 'serial' }, '0', {}), true);

  assert.equal(defaults.baudRate.validate.call({ id: 'c1', mode: 'serial' }, '57600', {}), true);
  // Closed list: a rate off it reds, whether it is nonsense or merely a real
  // baud the dropdown does not offer.
  assert.match(
    String(defaults.baudRate.validate.call({ id: 'c1', mode: 'serial' }, '-1', {})),
    /must be one of/
  );
  assert.match(
    String(defaults.baudRate.validate.call({ id: 'c1', mode: 'serial' }, '1000000', {})),
    /must be one of/
  );
  assert.equal(defaults.baudRate.validate.call({ id: 'c1', mode: 'udp' }, 'garbage', {}), true);
});

test('link id is a wire byte; peer-freshness overrides are blank or positive', () => {
  const defaults = loadNodeDefaults('mavlink-connection');

  // The signature block carries the link id as one byte — the runtime writes
  // it to the wire as saved, so out-of-range would truncate silently.
  assert.equal(defaults.linkId.validate.call({ id: 'c1' }, '0', {}), true);
  assert.equal(defaults.linkId.validate.call({ id: 'c1' }, '255', {}), true);
  assert.match(String(defaults.linkId.validate.call({ id: 'c1' }, '256', {})), /byte — 0 to 255/);
  assert.match(String(defaults.linkId.validate.call({ id: 'c1' }, '', {})), /byte — 0 to 255/);

  for (const field of ['staleMs', 'expireMs']) {
    assert.equal(
      defaults[field].validate.call({ id: 'c1' }, '', {}),
      true,
      `${field} blank means the peer table's built-in default`
    );
    assert.equal(defaults[field].validate.call({ id: 'c1' }, '5000', {}), true);
    assert.match(
      String(defaults[field].validate.call({ id: 'c1' }, '0', {})),
      />= 1/
    );
  }
});

test('mode gates read through liveOr — a foreign dialog cannot poison them (#217)', () => {
  // Source pin, scoped to the defaults block: oneditprepare's bare reads are
  // legitimate (its own dialog is open by definition), a validator's are not —
  // the config-save cascade validates closed nodes while somebody else's tray
  // is on top, and `live || saved` is the banned truthiness shape besides.
  const defaultsSrc = html.slice(html.indexOf('defaults:'), html.indexOf('credentials:'));
  assert.ok(
    !defaultsSrc.includes("$('#node-config-input-mode')"),
    'no validator may read the live mode field bare'
  );
  const liveOrCalls = defaultsSrc.match(
    /RED\.mavlink\.liveOr\(this,\s*'#node-config-input-mode',\s*this\.mode,\s*'udp'\)/g
  ) || [];
  assert.equal(
    liveOrCalls.length, 7,
    'all seven mode-gated validators (bindHost/bindPort/remoteHost/remotePort/'
      + 'broadcastPort/serialPath/baudRate) go through the scoped liveOr'
  );

  // Behavioral: a saved serial node validated while a FOREIGN dialog shows
  // mode=udp keeps its serial gate — the stray mode select is not this node's
  // answer, so its hidden IP fields must not red.
  const foreign = loadNodeDefaults('mavlink-connection', {}, {
    dom: { '#node-config-input-mode': { val: 'udp' } },
    editStack: [{ id: 'someone-else' }],
  });
  assert.equal(foreign.bindHost.validate.call({ id: 'c1', mode: 'serial' }, '', {}), true,
    'a foreign dialog\'s mode select must not resurrect the IP-mode gate');
  assert.equal(foreign.bindPort.validate.call({ id: 'c1', mode: 'serial' }, '', {}), true);
  assert.equal(
    foreign.serialPath.validate.call({ id: 'c1', mode: 'serial' }, '/dev/ttyUSB0'),
    true
  );

  // And the live read still wins in the node's OWN dialog: switching a saved
  // udp node to serial releases the now-hidden IP fields immediately.
  const own = loadNodeDefaults('mavlink-connection', {}, {
    dom: { '#node-config-input-mode': { val: 'serial' } },
    editStack: [{ id: 'c1' }],
  });
  assert.equal(own.bindHost.validate.call({ id: 'c1', mode: 'udp' }, '', {}), true);
  assert.equal(own.serialPath.validate.call({ id: 'c1', mode: 'udp' }, ''), false,
    'and arms the serial gate the saved mode would have skipped');
});

test('signing credentials are mutually exclusive in both directions, live-aware', () => {
  const creds = loadNodeType('mavlink-connection').credentials;
  const key = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
  const reason = /cannot be set alongside/;

  // Two-arg forms so a returned string renders as the invalid reason (§14).
  assert.equal(creds.signingKeyHex.validate.length, 2);
  assert.equal(creds.signingPassphrase.validate.length, 2);

  // Saved state, no dialog open (import/deploy): each side reds against the
  // other's `has_` boolean — including the passphrase field itself, the one
  // the operator actually touches.
  assert.match(String(creds.signingKeyHex.validate.call(
    { id: 'c1', credentials: { has_signingPassphrase: true } }, key, {}
  )), reason);
  assert.match(String(creds.signingPassphrase.validate.call(
    { id: 'c1', credentials: { has_signingKeyHex: true } }, 'correct horse', {}
  )), reason);

  // Blank always passes (signing is optional) and a lone credential passes.
  assert.equal(creds.signingPassphrase.validate.call({ id: 'c1', credentials: {} }, '', {}), true);
  assert.equal(creds.signingKeyHex.validate.call({ id: 'c1', credentials: {} }, '', {}), true);
  assert.equal(
    creds.signingPassphrase.validate.call({ id: 'c1', credentials: {} }, 'correct horse', {}),
    true
  );
  assert.equal(creds.signingKeyHex.validate.call({ id: 'c1', credentials: {} }, key, {}), true);
  // Wire format still guards the key before exclusivity is even asked.
  assert.match(
    String(creds.signingKeyHex.validate.call({ id: 'c1', credentials: {} }, 'abc', {})),
    /64 hex/
  );

  const openOwn = (dom) => loadNodeType('mavlink-connection', {}, {
    dom, editStack: [{ id: 'c1' }],
  }).credentials;

  // Own dialog open: typing a passphrase beside a key already in the key box
  // reds NOW, on the passphrase field — not only after save.
  const liveKey = openOwn({ '#node-config-input-signingKeyHex': { val: key } });
  assert.match(String(liveKey.signingPassphrase.validate.call(
    { id: 'c1', credentials: {} }, 'correct horse', {}
  )), reason);

  // Clearing the sibling box live releases the other side over its saved
  // ghost — the emptied box is the operator's answer (#284 lesson).
  const clearedPassphrase = openOwn({ '#node-config-input-signingPassphrase': { val: '' } });
  assert.equal(clearedPassphrase.signingKeyHex.validate.call(
    { id: 'c1', credentials: { has_signingPassphrase: true } }, key, {}
  ), true);

  // A FOREIGN dialog's key box is not this node's answer (#217 scoping).
  const foreign = loadNodeType('mavlink-connection', {}, {
    dom: { '#node-config-input-signingKeyHex': { val: key } },
    editStack: [{ id: 'someone-else' }],
  }).credentials;
  assert.equal(
    foreign.signingPassphrase.validate.call({ id: 'c1', credentials: {} }, 'correct horse', {}),
    true
  );
});

test('Sign outbound reds at deploy when checked with no signing credential', () => {
  const defaults = loadNodeDefaults('mavlink-connection');
  const key = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
  const reason = /passphrase or raw key/;

  // Two-arg form so a returned string renders as the invalid reason (§14).
  assert.equal(defaults.signOutbound.validate.length, 2);

  // Unchecked always passes — signing is optional.
  assert.equal(defaults.signOutbound.validate.call({ id: 'c1', credentials: {} }, false, {}), true);
  // Checked with both credential boxes blank is the start()-doomed deploy.
  assert.match(
    String(defaults.signOutbound.validate.call({ id: 'c1', credentials: {} }, true, {})),
    reason
  );
  // Either saved credential satisfies it — saved passwords surface as `has_*`.
  assert.equal(defaults.signOutbound.validate.call(
    { id: 'c1', credentials: { has_signingPassphrase: true } }, true, {}
  ), true);
  assert.equal(defaults.signOutbound.validate.call(
    { id: 'c1', credentials: { has_signingKeyHex: true } }, true, {}
  ), true);

  // Own dialog open: a key typed but not yet saved already counts.
  const own = loadNodeDefaults('mavlink-connection', {}, {
    dom: { '#node-config-input-signingKeyHex': { val: key } },
    editStack: [{ id: 'c1' }],
  });
  assert.equal(own.signOutbound.validate.call({ id: 'c1', credentials: {} }, true, {}), true);

  // An emptied credential box is the operator's answer over its saved ghost
  // (#284 lesson) — checked signing reds the moment its last key is cleared.
  const cleared = loadNodeDefaults('mavlink-connection', {}, {
    dom: { '#node-config-input-signingPassphrase': { val: '' } },
    editStack: [{ id: 'c1' }],
  });
  assert.match(String(cleared.signOutbound.validate.call(
    { id: 'c1', credentials: { has_signingPassphrase: true } }, true, {}
  )), reason);
});

test('Local Identity editor exposes heartbeatIntervalMs', () => {
  assert.match(
    identityHtml,
    /heartbeatIntervalMs:\s*\{\s*value:\s*1000/,
    'identity defaults own the 1 Hz heartbeat interval'
  );
  assert.match(
    identityHtml,
    /node-config-input-heartbeatIntervalMs/,
    'identity template must render the heartbeat interval control'
  );
});
