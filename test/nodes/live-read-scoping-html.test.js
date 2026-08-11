'use strict';

/**
 * #217: a validator's live-DOM read must be scoped to the node's own dialog.
 *
 * Node-RED's config-save handler validates every user of the saved config node
 * before its tray closes (red.js v5.0.4, the unconditional cascade after
 * "Now, validate the config node"), and trays stack — so a *closed* node's
 * validator runs while another node's dialog owns the DOM. Reproduced by
 * execution: a Send-tier command with broadcast target 0 — saved-legal — reds
 * "cannot be confirmed" the moment the shared Connection is Updated from
 * inside a confirm-tier sibling's dialog, because liveOr read the open
 * dialog's `#node-input-delivery`. The poisoned `valid` flag is cached and
 * deploy trusts the cache (red.js revalidates a config node only when `valid`
 * is undefined), so the red survives until the victim's dialog is reopened.
 *
 * These tests drive the REAL validators — the html scripts evaluated whole,
 * real RED.mavlink helpers underneath — not re-implementations. The
 * stub-over-fiction lesson (#267): a hand-written copy of the validator can
 * agree with the test and disagree with the node.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { installEditorHelpers } = require('../helpers/editor-resource');

const nodesDir = path.join(__dirname, '..', '..', 'nodes');

/**
 * Evaluate a node HTML's inline scripts against the real editor helpers, a
 * DOM keyed by selector, and a declared edit stack. Returns the registered
 * node definitions.
 *
 * @param {string} file  node HTML filename
 * @param {{dom?: Object<string,string>, editStack?: Array<{id: string}>}} [opts]
 * @returns {Object<string, object>} type → registerType definition
 */
function loadNodeHtml(file, opts) {
  opts = opts || {};
  const dom = opts.dom || {};
  const editStack = opts.editStack || [];
  const html = fs.readFileSync(path.join(nodesDir, file), 'utf8');
  const scripts = [...html.matchAll(/<script type="text\/javascript">([\s\S]*?)<\/script>/g)]
    .map((m) => m[1]);
  assert.ok(scripts.length > 0, `${file}: inline scripts found`);

  const registered = {};
  function $(selector) {
    const has = Object.prototype.hasOwnProperty.call(dom, selector);
    return {
      length: has ? 1 : 0,
      val: () => (has ? dom[selector] : undefined),
    };
  }
  const context = {
    RED: {
      settings: { httpAdminRoot: '/' },
      mavlink: {},
      nodes: {
        registerType: (type, def) => { registered[type] = def; },
        getType: () => null,
        node: () => null,
      },
      validators: { number: () => () => true },
      editor: { getEditStack: () => editStack },
      events: { on: () => {} },
    },
    $,
  };
  installEditorHelpers(context);
  for (const script of scripts) vm.runInNewContext(script, context);
  return registered;
}

// ── The reproduced poison: command targetSystem via the config-save cascade ──

test('command targetSystem: a foreign dialog cannot re-tier a closed node (#217)', () => {
  // Node A (id a1) has its confirm-tier dialog open — its delivery select is
  // the one in the DOM, and A is on top of the edit stack. The cascade is now
  // validating closed node B: Send tier, broadcast 0, a saved-legal pair.
  const registered = loadNodeHtml('mavlink-command.html', {
    dom: { '#node-input-delivery': 'confirm' },
    editStack: [{ id: 'a1' }],
  });
  const validate = registered['mavlink-command'].defaults.targetSystem.validate;
  const closedB = { id: 'b2', delivery: 'send', targetSystem: 0 };
  assert.equal(
    validate.call(closedB, 0, {}),
    true,
    "B's saved Send tier governs — A's live 'confirm' is not B's tier"
  );
});

test('command targetSystem: the own-dialog live read survives the fix (#260)', () => {
  // Same DOM, but the dialog belongs to the node under validation: the
  // operator switched delivery to confirm and has not saved. The broadcast
  // refusal must still fire from the live value.
  const registered = loadNodeHtml('mavlink-command.html', {
    dom: { '#node-input-delivery': 'confirm' },
    editStack: [{ id: 'b2' }],
  });
  const validate = registered['mavlink-command'].defaults.targetSystem.validate;
  const own = { id: 'b2', delivery: 'send', targetSystem: 0 };
  assert.match(
    String(validate.call(own, 0, {})),
    /broadcast \(0\) cannot be confirmed/,
    'the live tier still reds an in-dialog broadcast'
  );
});

test('command targetSystem: no dialog anywhere — the saved tier decides', () => {
  const registered = loadNodeHtml('mavlink-command.html');
  const validate = registered['mavlink-command'].defaults.targetSystem.validate;
  assert.equal(validate.call({ id: 'b2', delivery: 'send' }, 0, {}), true);
  assert.match(
    String(validate.call({ id: 'b3', delivery: 'confirm' }, 0, {})),
    /cannot be confirmed/,
    'a saved confirm tier with broadcast 0 is invalid with no DOM at all'
  );
});

// ── The filed instance: companion identity ids ───────────────────────────────

test('identity ids: a foreign role select cannot invalidate a companion (#217)', () => {
  // The landmine as filed: a companion's blank ids are legal, and a foreign
  // dialog's role select says 'gcs'. No v5.0.4 editor path validates a
  // sibling identity while another identity dialog is open — but the read
  // must not trust whatever dialog happens to be on top, because one foreign
  // read poisons `valid` and the Connection reds through the config cascade.
  const registered = loadNodeHtml('mavlink-local-identity.html', {
    dom: { '#node-config-input-role': 'gcs' },
    editStack: [{ id: 'other' }],
  });
  const defaults = registered['mavlink-local-identity'].defaults;
  const companion = { id: 'ci', role: 'companion' };
  assert.equal(defaults.sourceSystemId.validate.call(companion, '', {}), true);
  assert.equal(defaults.sourceComponentId.validate.call(companion, '', {}), true);
});

test('identity ids: the own-dialog role switch still validates live', () => {
  // The reason the live read exists at all: role changed in-dialog, not yet
  // saved. Blank ids are invalid for the gcs role the operator just picked.
  const registered = loadNodeHtml('mavlink-local-identity.html', {
    dom: { '#node-config-input-role': 'gcs' },
    editStack: [{ id: 'ci' }],
  });
  const defaults = registered['mavlink-local-identity'].defaults;
  const companion = { id: 'ci', role: 'companion' };
  assert.match(
    String(defaults.sourceSystemId.validate.call(companion, '', {})),
    /required for this role/
  );
});

test('identity ids: stale saved role with blank ids stays invalid — data, not race', () => {
  // Sequence (g) from the #217 investigation: role 'gcs' saved alongside
  // blank ids reproduces the reported symptom with no DOM race at all. That
  // is bad saved data and must keep redding — the fix scopes the live read,
  // it does not paper over an inconsistent config.
  const registered = loadNodeHtml('mavlink-local-identity.html');
  const defaults = registered['mavlink-local-identity'].defaults;
  assert.match(
    String(defaults.sourceSystemId.validate.call({ id: 'ci', role: 'gcs' }, '', {})),
    /required for this role/
  );
});

// ── The migration guard, and the validators the missed migration disabled ────
//
// The first cut of the owner migration missed mavlink-move's two stream
// validators (Codex, #273): under the new signature their selector string
// landed in `owner`, `owner.id` was undefined, and liveOr returned '' in
// every state — so `'' !== 'stream'` skipped the rateHz/ttlMs checks
// entirely, own dialog and deploy alike. streamValue in the runtime guards
// payload overrides only and trusts config by doctrine, so a rateHz of 0
// would have deployed and turned the stream timer into a ~1 ms flood.

test('liveOr refuses a selector in the owner slot — misuse fails loud, not silent', () => {
  // The enforcement lives in the helper, not in a source grep: red.js wraps
  // validator calls in try/catch, logs the error, and reds the node naming
  // the property, so a wrong-shaped call cannot survive its first validation
  // in the real editor — including call sites in files no grep list names.
  // These behavioral tests then catch it at suite time, because an
  // unmigrated validator throws instead of silently passing everything.
  const { installEditorHelpers: install } = require('../helpers/editor-resource');
  const ctx = install({
    RED: { mavlink: {}, editor: { getEditStack: () => [] }, nodes: { node: () => null } },
    $: () => ({ length: 0, val: () => undefined }),
  });
  assert.throws(
    () => ctx.RED.mavlink.liveOr('#node-input-delivery', 'stream'),
    /first argument is the owning node/
  );
});

test('move stream validators: saved stream tier is checked on deploy', () => {
  // The state the regression silenced: no dialog anywhere, saved delivery
  // 'stream' — deploy-time validation must still refuse a flood-shaped rate.
  const registered = loadNodeHtml('mavlink-move.html');
  const defaults = registered['mavlink-move'].defaults;
  const saved = { id: 'm1', delivery: 'stream' };
  assert.match(String(defaults.rateHz.validate.call(saved, 0, {})), /at least 0\.1 Hz/);
  assert.match(String(defaults.rateHz.validate.call(saved, 'abc', {})), /at least 0\.1 Hz/);
  assert.equal(defaults.rateHz.validate.call(saved, 5, {}), true);
  assert.match(String(defaults.ttlMs.validate.call(saved, -5, {})), /milliseconds/);
  assert.equal(defaults.ttlMs.validate.call(saved, 0, {}), true, '0 = no TTL is legal');
});

test('move stream validators: own dialog reads the live tier, foreign does not', () => {
  // Own dialog, delivery switched to stream and unsaved: live wins, rate 0 reds.
  const own = loadNodeHtml('mavlink-move.html', {
    dom: { '#node-input-delivery': 'stream' },
    editStack: [{ id: 'm1' }],
  });
  assert.match(
    String(own['mavlink-move'].defaults.rateHz.validate.call({ id: 'm1', delivery: 'send' }, 0, {})),
    /at least 0\.1 Hz/
  );

  // Foreign dialog showing 'stream': a closed Send-tier node must not have
  // its rateHz judged against somebody else's tier (#217 scoping).
  const foreign = loadNodeHtml('mavlink-move.html', {
    dom: { '#node-input-delivery': 'stream' },
    editStack: [{ id: 'other' }],
  });
  assert.equal(
    foreign['mavlink-move'].defaults.rateHz.validate.call({ id: 'm1', delivery: 'send' }, 0, {}),
    true
  );
});
