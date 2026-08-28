# v1.0.0 doctrine sweep — audit record

Working document for the pre-1.0.0 cleanup. Full-tree audit against `AGENTS.md`
(re-read at `0e4df0e`), performed at `main` = `cd3720c` (post-#402). Every
citation was read in context, not just grepped. Findings only — no code was
changed while auditing. Owner decides what ships; this file does not survive
into the release (delete it in the branch's final commit, or before merge).

## Status — executed 2026-08-28

- **Done:** A1 (helper + test deleted), B1, B2 (fences deleted), B4 (better fix
  than planned: the fetch already rode `loadEnumsCatalog`; `_typeSeq` replaced
  by the sibling dialogs' `enumLoadToken`, cancelled in both close paths),
  C1 (cache/waiters/drop deleted; per-site `{seq}` registry preserves the
  concurrent-caller fix; open bumps every site), E1 (split finding: the
  autopilot fallback was dead; HB Type had a real editor gap — `allowEmpty`
  let an untouched fresh dialog save blank — closed in the editor, runtime
  reads saved values directly; CHANGELOG carries the re-pick note),
  S1 (+3), S2 (+20), S3 (+27) — the §5 conversions' +50 runtime is the price
  of the affirmative-dispatch shape, taken on the owner's explicit ask.
- **Checked, stays — reasons now in-code or below:** B3 (the presets endpoint
  is target-free and must load exactly when `loadCatalog` would short-circuit
  on an unresolved target; the 4-line fence keeps a why-comment),
  C2 (the null during reload windows is itself the staleness guard for the
  stale `change.mavmsgForm` handler; a closure catalog would repaint from the
  wrong dialect), D1 (keys are credentials, absent in ways no editor
  validator sees), D2 (documented §0-rule-3 false-success class).
- **Owner's, still open:** deleting this file when the PR merges.

## Status — second round, 2026-08-28 (owner rulings on §5 forks)

Doctrine landed on `main` (`96bc0e8`): §6 no-migrations is unconditional;
§5 gained the stacked-case-labels rule — never a boolean fork on one member,
a stray falls to the empty default and selects nothing.

- **Converted (545fa49):** every remaining tier/mode boolean fork —
  `lib/addressing/delivery-context.js` (one switch composes the role
  context; wire stack is the union of every caller's tiers:
  send/confirm/complete/collect/stream), command's `coordKinds` and
  `modeContext`, param's band pick, fan-out's stub selection / output
  shaping / badge / `classifyMessage` / warnings / both executors. Stray
  tiers compose nothing and every caller's own tier dispatch then selects
  nothing — traced per site to loud failure or legal no-op, never silent
  success. Cost +74 runtime.
- **Checked, stays:** the two fan-out refusal-composing conditions
  (broadcast+non-all, broadcast+stale-peers) — a switch there is the one-arm
  validation switch §5 removes on sight; `mavlink-build.js` `tierKnown` —
  its stray behavior is the ruled loud per-run refusal (Gitar #310), which
  select-nothing would downgrade to silence; the seven
  `applyConnectionStatus(node, delivery !== 'build', …)` boolean *arguments*
  — value computation, not dispatch, and select-nothing semantics would
  un-badge the most-broken configs.
- **`applyConnectionStatus` — DELETED (owner ruling; §14.137 on `main`).**
  The "stays" verdict below rested on a disabled-config-node state that no
  editor UI can produce — the Connection's own Disable checkbox constructs
  an inert stub (sends throw the named disabled error; no badge case), and
  its label records that Node-RED cannot disable config nodes. The remaining
  `getNode`-null paths are §9-refused hand-edits: senders crater per message
  through their existing catch, `in`/`state`-feed crater at construction.
  Helper + 13 call sites + `in`'s badge-and-return deleted; four tests
  re-pinned to the loud outcomes; three verdict reversals in one finding,
  each forced by an owner measurement. The superseded reasoning, kept for
  the record: the editor ring
  (`connectionDefault`, embedded by `buildTierDialectDefaults`; stock
  `required: true` on always-wire nodes) covers blank, deleted, and invalid
  references — but not a **disabled** Connection, which validates green in
  the editor while `RED.nodes.getNode()` returns null at runtime. That is a
  deliberate operator state no editor ring can red, so the badge reports a
  condition the editor never validated — not the forbidden second
  deploy-time error path. For the input-less consumers (in, state) the
  badge is also the only signal on an otherwise silently dead node
  (§0 rule 3). Already ruled: §14.49 ("applyConnectionStatus carries the
  deploy badge"), and `nodes/mavlink-state.js:23-24` documents the posture
  in place.

Owner rulings received during the audit, to be recorded in doctrine (straight
to `main`, own commits, per §2):

1. **No migrations, ever — not just pre-1.0.** Landed on `main` (`96bc0e8`):
   the `AGENTS.md` §6 / `CLAUDE.md` clauses lost their "pre-1.0" qualifier.
2. **Stacked case labels, never a boolean fork on one member** — the owner
   rejected the boolean-fork proposal and ruled the opposite; §5's stacked-label
   bullet (`96bc0e8`) is the record, and the second-round status above is the
   execution.

---

## A. Dead code — confirmed, delete

**A1. `resources/mavlink-editor.js:231` — `RED.mavlink.booleanEntryLabel` has
zero callers.** Nothing in `nodes/` or `resources/` calls it; only its own test
(`test/nodes/mavlink-editor-resource.test.js:608-612`) and the comment at
`resources/mavlink-editor.js:212` (which counts it among "the three readers")
name it. `DESIGN_old.md` records the former Command/Build caller — gone.
Fix: delete helper + its test, fix the :212 comment.

**A2. `DESIGN_old.md` (repo root)** — archived doc shipping in the v1.0.0
tree; nothing references it. Owner call: delete or keep as archive.

## B. Unreachable-race guards (the 61d7a5f class) + fence duplication

Four hand-rolled copies of the staleness fence `RED.mavlink.loadCatalog`
(`resources/mavlink-editor.js:1291`) already owns. Three guard races that need
two human actions inside one localhost round trip — the class reverted in
`61d7a5f` and recorded as a CodeRabbit learning.

**B1. `nodes/mavlink-param.html:334` `_defsSeq`** (checks :406, :415). All
triggers of `loadParamDefs` are human select changes; fetch is local admin API.
The by-key cache write is keyed by the *request's* key (:402-404), so a stale
response cannot poison the validator cache — the seq protects only transient
visible display state (`_paramDefs` / `_defsCatalog` / notice row). Delete.

**B2. `nodes/mavlink-payload.html:128` per-open `seq`** (checks :262, :266).
Scoped inside `oneditprepare`, so it cannot cover the one reachable case
(response landing after close, into a reopened dialog — the old closure
compares against its own frozen variable and passes). What it does cover is
within-dialog reordering of local fetches on topic/verb/path/connection
changes — human hands. Delete, or adopt the `enumLoadToken` pattern
(local-identity:111, state:103) if close-coverage is wanted.

**B3. `nodes/mavlink-command.html:37-51` `_presets.seq`** — comment says
"Same fence as loadCatalog's", hand-rolled beside three real `loadCatalog`
uses in the same file. Route `loadPresets` through `RED.mavlink.loadCatalog`;
fence deletes.

**B4. `nodes/mavlink-fanout.html:6` `_typeSeq`** — module-scoped, so it *does*
cover the reachable close-then-reopen case (why `61d7a5f` left it standing).
Still a hand-rolled copy of the loadCatalog fence. Route the MAV_TYPE fetch
through `loadCatalog` with a `{seq: 0}` state for identical coverage on the
shared spelling.

Census of staleness spellings (the §3 one-owner argument): `enumLoadToken`
(mavlink-local-identity.html:111, mavlink-state.html:103), shared `loadCatalog`
seq (mavlink-in.html:4, mavlink-build.html:11-12, mavlink-command.html:27/31),
plus the four hand-rolls above. Six spellings; `loadCatalog` is the owner.

## C. Held catalogs of local fetches (the 21e2df0 class)

**C1. `nodes/mavlink-command.html:29,35,58-98` — `_currentCmdCatalog` +
`_cmdCatalogWaiters` + `dropCommandsCatalog()`.** ~30 lines of warm cache,
waiter coalescing, and invalidation whose stated purpose (:60-62) is avoiding
"two fetches of the same catalog" — on the local admin API, the cost the owner
ruled acceptable in `21e2df0`. Both read sites already carry the async
fallback path with a "Loading…" placeholder (:893 advanced, :976 preset), so
nothing requires the sync warm serve.
Constraint discovered in the code: the waiter queue fixed a real recorded bug
(:67-70) — `loadCatalog`'s *shared* seq state discarded a concurrent caller's
callback (the Advanced open lost its MAV_CMD list when the presets response
landed mid-flight). So the smallest fix is per-call-site seq state (distinct
`{seq: 0}` objects per caller), after which cache + waiters + drop all delete.

**C2. `nodes/mavlink-build.html:14,414,476` — `_currentMsgCatalog`** — same
family, weaker case: `refreshFieldForm` reads it synchronously but already
owns a "Loading…" placeholder path (:416-418), so the async machinery exists.
Verify the repaint trigger chain, then stomp the held copy.

**Checked and load-bearing — do NOT remove:**
- `nodes/mavlink-in.html:17` `_currentMsgCatalog` — `paintRow` (:28-38) runs
  synchronously when an editableList row is added before the catalog lands
  (:19-23); a sync paint path cannot refetch.
- `nodes/mavlink-param.html:149` `_paramDefsByKey` — read by a *synchronous
  validator* (:106), which cannot await; the cross-firmware motive is
  documented at :146-148.

## D. Runtime checks to re-litigate against §6 (verify §14 first, then decide)

**D1. `lib/connection/runtime.js:185-189`** — `signing.validate()` throwing at
`start()`. The editor's signOutbound ring reds the same condition;
`CLAUDE.md` forbids a second deploy-time error path. Counterpoint: keys are
*credentials*, deployed separately from config, and can be absent in ways no
editor validator saw — that may be why it fails closed here. §14 check before
touching.

**D2. `lib/connection/runtime.js:400-407`** — `assertHealth` throws on a
closed connection and on an identity not in the bound set. Both are documented
as §0 rule 3 / false-success prevention (a lease on an unbound id would report
healthy with no scheduler behind it) — the one promotable guard class. Likely
stays; worth one look at whether the editor truly closes every route to the
unbound-id case.

## E. Runtime defaults on editor-owned fields

**E1. `nodes/mavlink-local-identity.js:67-68`** —
`config.heartbeatType || preset.heartbeatType` and the `heartbeatAutopilot`
twin. Editor declares `heartbeatType: { value: '' }`
(mavlink-local-identity.html defaults), so either blank is a legal saved state
and the default belongs in the editor (stamp the preset at save), or the
editor always saves a value and the fallback is dead. `heartbeatAutopilot`
has a non-blank editor default (`MAV_AUTOPILOT_INVALID`), making its runtime
fallback dead-on-arrival. Either reading is a §6 finding; resolve which and
delete/move accordingly.

## S. §5 — if/else chains that should be switches

**S1. `nodes/mavlink-payload.js:254-276` — `source.kind` if-chain; the switch
already exists next door.** `lib/metadata/admin-catalog.js:126-138` dispatches
the same `resolveCatalogSource` kinds with the model §5 shape (affirmative
cases, empty `default: break`, explicit post-switch refusal into the endpoint's
catch). Convert payload's field-tips endpoint to the same spelling. The
`known.includes(source.dialect)` on the else path (:281) stays — admin-HTTP
ingress, not config validation. §5 violation + §3 two-spellings in one.

**S2. `nodes/mavlink-param.js:326-334, 356-364+` — delivery×action dispatch as
boolean flags.** `isConfirmSet` / `isConfirmRead` / `isCollectList` are ANDed
vocabulary tests; the subscribe callback then chains
`if (isConfirmSet) … else if (isConfirmRead) … else …`. §5's forbidden shape
across two vocabularies. Switch form is nested (`switch (delivery)` →
`switch (request.action)`) or a composite key. Caveat: the flags also gate
setup code (:330, :350), so this is a restructure of the node's hottest path —
own commit, existing param tests prove equivalence.

**S3. `lib/metadata/compile.js:235-244, 268, 292, 341-343` — XML tag walks as
else-if chains.** Two chains (4-7 branches) on `tag`, a closed vocabulary,
selecting parse behaviors in `lib/**`. By the letter of §5 these are switches;
the current no-else fall-through is the empty-`default:` semantic unspelled.
Mechanical conversion, zero behavior change. Alternative: owner exempts
third-party-structure parsers in a §14 entry instead.

## Checked clean — with reasons, so bots do not relitigate

- **Driver `throw`s**: every one in `lib/**` carries
  `eslint-disable no-restricted-syntax` with a §0-step justification (a lint
  rule enforces this). Sampled and verified: `lib/vehicle/index.js:163-204`
  (files genuinely absent — step 1), `lib/connection/wire.js` (serializer
  refusals), seed-integrity throws in `lib/metadata/bundled.js`.
- **Admin-HTTP guards** (`lib/param/defs.js:41-43`,
  `lib/metadata/commands-list.js:24-27`, `lib/metadata/xml-catalog.js:620`) —
  ingress doorguards on unvalidated HTTP input (path traversal, dialect
  interpolation), the same trust domain as `mavlink-in`'s wire ingress. Not
  config validation.
- **All 17 `default:` arms** in `lib/**` are empty §5 arms
  ("This space intentionally left blank"). The `default:` hits in
  `lib/payload/index.js` / `lib/metadata/*` are data-table keys, exempt.
- **`||` / `??` population in the driver**: internal DI seams
  (`opts.now || Date.now` etc.), display maps
  (`RESULT_NAME[code] || String(code)`), third-party-file parsing
  (`lib/param/defs.js`, `lib/metadata/compile.js`), and documented presence
  semantics (`payload.x || config.x` per §5's msg-override bullet;
  `payload ?? {}` per §5 presence rules). `lib/connection/peer-table.js:88-89`
  `??` is deliberate and documented (:79, :98 — keeps a configured 0).
- **`lib/command/completion.js:99`** `params[6] ?? 0` — mirrors the wire's
  zero-fill so completion judges the climb target the vehicle actually got;
  not an invented value (comment :96-98).
- **`lib/state/index.js:50-51`** — blank filter = "no filter" presence
  semantics, documented.
- **`nodes/mavlink-fanout.js:36-46`** `if (!connectionNode)` — affirmatively
  selects the Build-tier list stub (documented §6 Fan-out exception), and
  `buildListStub`'s `.includes` (:245) is data lookup inside the stub.
- **`nodes/mavlink-in.js:94-99`** badge-and-return on unresolved Connection —
  visible badge, documented; not silence.
- **`nodes/mavlink-command.js:221-224`** `applyModeName` presence checks —
  presence dispatch on the mode-name ladder; unresolvable name rides as NaN to
  the wire choke (loud), documented (Gitar #346).
- **`nodes/mavlink-move.js:650-652`** `firmwareFor` optional chaining —
  documented tier-dependent presence (Build vs wire), fails closed.
- **`nodes/mavlink-connection.js:371-390` `rejectedSurface`** — an if-chain
  but a *display mapping* (reason tag → log/badge text); §5's last paragraph
  exempts display mappings outright.
- **Outcome chains** (`nodes/mavlink-mission.js:237-251`,
  `nodes/mavlink-payload.js:179`, fanout equivalents) —
  `succeeded` / `cancelled` / *everything else fails*. The else-arm is the
  general failure path, not a substituted default member; a switch would need
  a behaviorful `default:`, which §5 forbids. The if-chain is the correct
  spelling.
- **Binary vocabulary forks** — `tier === 'build'`
  (`lib/addressing/delivery-context.js:34` + ~10 node sites),
  `mode === 'broadcast'` (`lib/fanout/index.js:85,210,215,238,808`).
  Established idiom, survived the driver-guardrails PRs (#396-400);
  DESIGN.md:262 treats `tier === 'build'` as canonical. Conversion is churn
  for zero behavior — covered by proposed doctrine sentence (2) above.
- **Codec `typeof`/`kind` chains** (`lib/codec/numeric.js`,
  `lib/codec/field.js`, `lib/connection/wire-classes.js:145-147`) — numeric /
  type conversion; §5: "do not widen this rule into unrelated numeric logic."
- **Ternaries in the driver** — all `typeof` normalization or data-key
  derivation (`lib/param/seed.js:108`, `lib/state/index.js:145`); none select
  behavior on a config/msg vocabulary.
- **Single-caller exports on `RED.mavlink`** (`applyFieldTitle`,
  `applyFieldUnits`, `enumOptionLabel`, `fillIdentitySelect`,
  `identityWireIds`, `magicBooleanValue`, `splitCompIdsByTopic`,
  `vehicleIdFrom`) — each has exactly one internal caller; they are exported
  for the resource test suite's direct coverage, not identity wrappers. No
  action unless the owner wants them private.

## Execution plan — superseded

The original three-commit plan executed and grew two more rounds; the Status
sections above are the record. Remaining work: the owner's merge, and deleting
this file in the commit that lands with it.
