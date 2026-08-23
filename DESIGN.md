# DESIGN — Ground truth (§14), renumbered and re-verified

This file is the ground-truth register: one numbered entry per fact, grouped by
subject, stripped of narrative. Every entry was re-verified against this tree on
**2026-08-19** where verification does not need a rig; SITL measurements are kept as
recorded (owner's call, 2026-08-19). Facts that were superseded or disproved are
removed — the last section lists what went and why.

The build specification this replaces — §1–§13 (scope, code principles, nodes,
metadata, the field codec, UI rules, config nodes, peer table, the chain model,
fan-out, firmware support, build order, testing) and the original narrative §14 —
is kept verbatim in [`DESIGN_old.md`](DESIGN_old.md). Citations of the form
`DESIGN.md §1`…`§13` elsewhere in the tree still refer to that file.

Baseline at verification: `npm test` 1695 pass / 0 fail / 1 skip; `npm run lint` clean.

**Status tags**

| tag | meaning |
|---|---|
| ✔ | re-checked in this tree on 2026-08-19 (probe, grep, or the named test — suite green) |
| 🧪 | rig/SITL measurement, kept as recorded; the cited code and tests were confirmed to exist |
| 📖 | read from upstream source or spec on the recorded date, kept as recorded |

The standing rules from the old §14 header still apply: verify before asserting;
lessons update this document in the same change; PRs stay at or under 50 files.

---

## 14.1 – 14.5 Toolchain and packaging

**14.1 `node-mavlink` is the ArduPilot line; there is no `node-mavlink-mappings` package.** ✔
`node-mavlink@2.3.0` declares `github.com/ArduPilot/node-mavlink` as its repository, and
ArduPilot's mappings fork publishes as `mavlink-mappings`. Since the seed became the
dialect authority (14.6) `mavlink-mappings` is no longer a direct dependency — it rides
only as `node-mavlink`'s own dependency (generated wire classes and the CRC table), and
`test/vehicle/register-without-mappings.test.js` pins that the editor still works with it
stubbed out.
*Check:* `npm view node-mavlink repository.url`; `package.json` dependencies.

**14.2 `node-red-dev` is invoked isolated, never installed.** ✔
Adding `node-red-dev@0.1.6` to `devDependencies` pulls hundreds of legacy packages and
high/critical audit findings into the lockfile. The scorecard runs through the
`validate:node-red` npm script via isolated `npm exec` instead (it is no longer a CI
step — script only).
*Check:* `package.json` scripts; `rg node-red-dev .github` is empty.

**14.3 Bind-mounted source is not an installed package.** 📖 (npm behavior)
`require()` walks `node_modules` up from the *real* path of the loading file, and
`npm install /path` symlinks the package **without installing its dependencies**. A bare
mount therefore cannot resolve its own deps. Fix: `npm install --omit=dev` on the mount,
or install a real copy (`--install-links`, a packed `.tgz`, or a git URL).

**14.4 `grep -E` alternation is `|`; `\|` matches a literal pipe.** ✔ (trivially)
More than one measurement in the old §14 was wrong because of this — including a count
that measured the regex rather than the code.

**14.5 Linting editor HTML catches real defects.** ✔
`eslint-plugin-html` extracts the JavaScript from `<script>` blocks in `nodes/*.html`
and catches undefined names and dead bindings. Drift tests still own markup and
editor/runtime contract alignment.
*Check:* `npm run test:lint-config`.

## 14.6 – 14.18 Dialect metadata and seeds

**14.6 The seed blob is the dialect authority.** ✔
Shipped dialects come from `seed/mavlink-*.seed.gz` (pointer in `seed/active.json`;
current stamp `2026-07-29-de1e078`). There is no free-text XML path/upload control and
nothing that resolves one; private XML becomes a profile through the userDir catalog.
*Check:* `node -e "const {knownDialects,seedStamp}=require('./lib/metadata/bundled'); console.log(seedStamp(), knownDialects().slice(0,3))"`.

**14.7 Message-field `enum=` comes from the compiled seed/catalog XML.** ✔
The old `.d.ts` recovery pipeline is deleted and nothing references it.
*Check:* `rg -n 'metadata/dts|parseDtsText|parseModuleDts|numericTag' lib nodes test` — no matches.

**14.8 Command-param `enum=` is in the seed — no hand-maintained hint table.** ✔
The XML compiler writes `<param enum=>` links into `commands[*].params[*].enum` at seed
generate / catalog compile time. A missing `enum=` renders a number field; fix the
seed/XML, never a parallel table.
*Check:* `node --test test/metadata/commands-list.test.js`.

**14.9 Seed bundles carry the include chain; registries follow it and start empty.** ✔
`compileXml` walks `<include>` per selectable root into `bundle.files`. Unknown dialect
fails loud — never a silent fall-back to `common`. Five component dialects (`uAvionix`,
`icarous`, `loweheiser`, `cubepilot`, `csAirLink`) are already inside `ardupilotmega`'s
chain, and `storm32` includes `ardupilotmega` whole.
*Check:* `node --test test/connection/wire-registry.test.js`.

**14.10 Params without `enum=` are scalars, not gaps.** ✔ (seed-era count)
`enum=` marks *categorical*; its absence means render a number field (latitude, yaw,
altitude, radius…). Coverage is complete, not thin.

**14.11 `Empty` / `Reserved` description text is the legacy `reserved="true"`.** ✔
The majority of unlabelled params in `common.xml` carry `Empty`, `Empty.` or `Reserved`
as body text. Treat them as reserved; no numbered fallback grid survives anywhere.

**14.12 An enum referenced in one dialect file may be defined in another.** 📖
`HEARTBEAT` and `MAV_AUTOPILOT` are defined in `minimal.xml`; `common.xml` only
references them. Any lookup must resolve the include chain first.

**14.13 `ardupilotmega.xml` is byte-identical upstream and in ArduPilot's fork.** 📖 (checked at record time)
Keep the source selectable because it can drift; do not assume it has.

**14.14 Component IDs live in enum table `MAV_COMPONENT`, not `MAV_COMP_ID`.** ✔
Entry *names* keep the historical `MAV_COMP_ID_*` prefix, but the table is
`MAV_COMPONENT`; asking the catalog for `MAV_COMP_ID` returns nothing.
*Check:* `node -e "const {listEnumsCatalog}=require('./lib/metadata'); console.log(listEnumsCatalog('ardupilotmega',['MAV_COMPONENT']).enums.MAV_COMPONENT.find(e=>e.value===1).name)"` → `MAV_COMP_ID_AUTOPILOT1`.

**14.15 MAVLink defines no Blimp mode table; the toolkit synthesizes one.** ✔ + 📖 (2026-08-08)
No dialect (bundled or upstream master) defines `BLIMP_MODE`, but `Blimp/mode.h` in
ArduPilot defines modes 0–6 and HEARTBEAT `custom_mode` carries them verbatim.
`lib/metadata/commands-list.js` injects a synthesized `BLIMP_MODE` into any catalog that
already carries `COPTER_MODE` (i.e. ArduPilot dialects only). PX4 stays a number box —
its modes are a two-field encoding.
*Check:* probe shows 7 modes on `ardupilotmega`/`storm32`, absent on `common`/`development`.

**14.16 A missing Vehicle Profile never invents a dialect catalog.** ✔
Editor catalog requests name `vehicle:<id>` or `dialect:<name>`. A missing profile is
404 (unless an allow-listed bundled `?dialect=` is also named); an empty query is 400.
No silent `ardupilotmega`.
*Check:* `node --test test/command/commands-route.test.js test/vehicle/enums-route.test.js`.

**14.17 Custom dialect messages get synthesized wire classes.** ✔
`node-mavlink` serializes through generated classes and CRC-gates inbound frames against
its magic-number table — a custom message has neither. `lib/connection/wire-classes.js`
synthesizes classes from the compiled bundle (same layout rules as the generator) and
passes a per-splitter `{ magicNumbers }` override; correctness is pinned by regenerating
every bundled message and requiring identical layout. Identity collisions throw at wire
construction. The library's global `registerCustomMessageMagicNumber` is deliberately
not used (process-global, throws on redeploy).
*Check:* `node --test test/connection/wire-classes.test.js`.

**14.18 Stream decoders are per endpoint, not per Connection.** ✔
Framing state is a byte stream before sysid is known, so a shared splitter lets peer A's
partial packet corrupt peer B. One serialize registry per Connection; a decoder map
keyed `address:port` (capped 100, junk-first then LRU eviction; TCP clears on
`endpoint-gone`, UDP age-evicts idle pipelines).
*Check:* `node --test test/connection/wire-decoders.test.js`.

## 14.19 – 14.23 Parameter definitions (metadata)

**14.19 Both firmwares publish parameter definitions at known URLs; the editor pre-fills them.** ✔
ArduPilot: `https://autotest.ardupilot.org/Parameters/<Vehicle>/apm.pdef.json` (HTTP 200
re-checked 2026-08-19). PX4: `https://artifacts.px4.io/Firmware/_general/parameters.xml`
(same check). Custom firmware has no known pre-fill URL — there is nothing to invent —
and an ArduPilot profile whose vehicle family is `unknown` has no per-document URL either
(the union seed in 14.22 is names-only, not an Update source). The seed generator
(`scripts/generate-param-seed.js`) fetches the known sources at build time; the shipped
seed carries them all (see 14.22). At runtime the Vehicle Profile editor pre-fills
`paramDefsUrl` only when a URL is known (named ArduPilot document or PX4); the operator
can override that pre-fill for a different source. When none is known the field stays
blank rather than inventing one. Clicking Update fetches from whichever URL is in the
field.
*Check:* `params-active.json` lists every source URL and count; change
firmware/vehicle in the editor and watch the URL field update (or clear).

**14.20 The pdef URL is an update source, not a read path or cache key.** ✔
Ordinary reads are local-only from a holding file keyed by Vehicle Profile ID. Only the
explicit authenticated Update action fetches; it validates before atomic replacement and
keeps the last good file on failure. Corrupt local JSON never becomes a network fallback.
*Check:* `node --test test/param/defs.test.js test/param/defs-route.test.js`.

**14.21 ArduPilot's canonical pdef JSON is PascalCase and inline.** ✔
Vehicle/group namespaces expose `Description`, `DisplayName`, `Units`,
`Range: {low, high}`, `Increment`, `Values` directly. The parser accepts that shape and
the older lowercase one.
*Check:* same tests as 14.20.

**14.22 Parameter metadata is per firmware *and* per vehicle document; the union serves names only.** 🧪 (2026-08-05) + ✔ (probe re-run)
The same id differs between stacks (`RC1_MIN`: PX4 `us` 800–1500; ArduPilot `PWM`
800–2200) and between documents within one firmware (of ids in >1 ArduPilot document,
122 disagreed on `values`, 25 on `max`, 23 on `min` at measurement). So `unionSafe`
drops `min`/`max`/`increment`/`values` and keeps only text; naming the vehicle family is
what turns ranges and dropdowns on. `blimp` is a family; `generic` was renamed
`unknown`. Current seed sizes (probe 2026-08-19): copter 5740, blimp 3127,
antenna-tracker 3638, union/unknown 6848, px4 1836; no union entry carries `min`.
A family-selection test must use a family-unique id (`ACRO_BAL_PITCH` discriminates).
*Check:* the probe in `lib/param/seed.js` docs; `node --test test/param/seed.test.js`.

**14.23 The Param dialog names which document answered.** ✔
The Vehicle Profile — not the Connection's free-text name — decides which definitions
you see, and two different correct answers (id absent from the catalog vs firmware that
publishes no wire type) are indistinguishable from a broken feature without a label.
`catalogLabel` ("PX4 · 1836 definitions (shipped seed)") is composed **in the route**,
because only the route knows which document actually answered after profile fallback.
*Check:* `rg catalogLabel lib/vehicle nodes/mavlink-param.html`.

## 14.24 – 14.43 Node-RED editor facts

**14.24 One-argument editor validators treat an error string as valid.** ✔
Node-RED only treats a returned string/array as an invalid-reason when the validator's
arity is 2 — `function (v, opt)`. A one-arg validator's return is coerced with `!!`, so
any non-empty string passes the field. Every custom validator here declares `(v, opt)`.
*Check:* `node --test test/nodes/mavlink-editor-resource.test.js`.

**14.25 `required: false` beside a `validate` skips the validator on blank.** ✔
`validateNodeProperty` returns `true` for `''` before calling `validate` when the
definition has `required === false` — a conditional validator paired with it never sees
the one value it exists to judge. A conditional validator takes **no** `required` key.
*Check:* same test file as 14.24.

**14.26 Declaring `validate` on a config-node property disables the built-in reference check.** ✔
The `missing-config` / `invalid-config` branch is guarded by
`!("validate" in definition[property])`, so any validator silently takes the dangling-id
check with it and must restate the lookup itself.
*Check:* same test file as 14.24.

**14.27 A node's status badge survives redeploy; only removal clears it.** ✔
The runtime emits a status clear only when a node is *removed*, and the editor is pure
event replay. A node whose constructor can bail with a red badge must call
`node.status({})` on the path where config resolved — that clear is not the idle "ready"
badge §6 forbids.
*Check:* `node --test test/nodes/in-out-build.test.js`.

**14.28 `oneditsave` runs before Node-RED's generic form-to-node copy.** ✔
A stale hidden control overwrites an object-only assignment, so reshape the actual
editor control in `oneditsave`. A single-select also needs an explicit empty option:
`.val(x)` with no matching option makes jQuery return `null`, which Node-RED skips.
*Check:* `node --test test/nodes/local-identity-html.test.js`.

**14.29 Config-node refs get the select + pencil/plus only when the type registered.** ✔
Node-RED builds the standard control only if `RED.nodes.getType(type)` is a registered
config type at dialog-prepare time — so config-node modules must `registerType` even
when optional deps are missing.
*Check:* `node --test test/vehicle/register-without-mappings.test.js`.

**14.30 An empty CompID `<select>` reds before the async enum fill.** ✔
Validators run immediately after `oneditprepare`, while `/mavlink/enums` is in flight.
Seed the select synchronously and end `fillEnumSelect` with `trigger('change')` or the
`input-error` class never clears. The control stores the numeric id; the label is
display-only.
*Check:* `node --test test/nodes/local-identity-html.test.js`.

**14.31 Editor catalog fetches must honour `httpAdminRoot`.** ✔
Node-RED can mount the editor under a prefix; bare `/mavlink/…` then 404s. Browser URLs
go through `RED.mavlink.adminApiUrl`; server route registration stays `/mavlink/…`.
Drift tests forbid bare `'/mavlink/` in `$.getJSON`/`$.ajax`.
*Check:* `node --test test/nodes/local-identity-html.test.js test/nodes/command-html.test.js test/nodes/param-html.test.js`.

**14.32 Shared editor helpers live once, in `resources/mavlink-editor.js`.** ✔
Loaded by a relative `<script src>` from the first-listed node HTML; Node-RED defers
inline node scripts until module resource scripts fire `onload`, so `RED.mavlink.*` is
defined before any `registerType` — no async race. One implementation each for the
catalog-source matrix (`resolveCatalogTarget`), the fetch skeleton (`loadCatalog`,
caller-owned seq guard, no cache), compid reload, identity refresh, enum fills and
labels, band options, bitmask helpers, Build-tier defaults and row visibility, payload
verb catalog. Node-owned rows stay local.
*Check:* `node --test test/nodes/mavlink-editor-resource.test.js`; the `rg` sweeps in that
test forbid per-node copies.

**14.33 Build-tier enum catalogs must see the saved dialect synchronously.** ✔
`resolveCatalogTarget` reads the live `#node-input-dialect` value, so
`populateDialectSelect` pins the saved dialect onto the select before the dialects GET,
and builders re-run `reloadCompIdSelect` whenever the catalog source moves. Do not pass
a leftover Build dialect on wire tiers. `development` is the real PX4 dialect name, not
a load failure.
*Check:* `node --test test/nodes/local-identity-html.test.js`.

**14.34 Build's `target_component` is a MAV_COMPONENT pulldown despite no `enum=` in the XML.** ✔
§6 lists target components among the always-dropdowns; Build's dynamic field calls the
shared `reloadCompIdSelect` (numeric ids — the wire field has no enum metadata). The
enum fetch must treat `tier === 'build'` as Build tier.
*Check:* `node --test test/nodes/build-html.test.js test/nodes/compid-enum-pulldowns-html.test.js`.

**14.35 A `$('#id')` that matches nothing is silent; unit-testing the helper does not catch it.** ✔
The Force checkbox shipped dead because a nested helper re-read the DOM by a wrong id.
Thread values in as arguments, and keep the structural guard: every `$('#id')` in each
editor HTML file must name an id that file defines.
*Check:* `node --test test/nodes/editor-selectors-resolve.test.js`.

**14.36 The Payload form repaint is ~3 ms; a save-guard against it is dead code.** 🧪 (measured on a live editor)
The one slow call (~373 ms, first dialect load) lands on dialog open, not on a selection
change. The race is real in code and unreachable in time. **Declined on reachability —
do not re-raise without a new measurement.**

**14.37 Nothing carries across a payload selection change.** ✔
`mode`/`action` are shared row keys resolving to different enums per verb, every one
starting at 0 — a carried id is silently reinterpreted (gripper `HOLD` (2) becomes
`PARACHUTE_RELEASE` (2)). Changing topic/verb/path clears saved values.
*Check:* `node --test test/nodes/payload-verb-html.test.js`.

**14.38 A two-state (FALSE/TRUE) param is a checkbox; `—` on a boolean pulldown was a fiction.** ✔
`COMMAND_LONG` carries all seven params in a fixed struct — there is no absent on the
wire, and 0 *is* `MAV_BOOL_FALSE`, so `—` and `false` built byte-identical messages.
`isFalseTrueEnum` gates the checkbox to FALSE=0/TRUE=1 exactly; other two-option enums
keep their pulldown.
*Check:* `node --test test/nodes/mavlink-editor-resource.test.js`.

**14.39 Exactly one command param is a boolean upstream forgot to model.** ✔
Of ~1110 no-enum command params in ardupilotmega, `MAV_CMD_COMPONENT_ARM_DISARM` param2
(force, magic 21196) is the only genuine two-state; 17 of the other 18 magic-value
mentions are `Target Camera ID` (255 = all). It lives in
`RED.mavlink.MAGIC_BOOLEAN_PARAMS` — a deliberate, audited exception; prose-parsing was
declined.
*Check:* `rg MAGIC_BOOLEAN_PARAMS resources/mavlink-editor.js`.

**14.40 Move editor fields are mode-selected, not dual-labelled.** ✔
Dual "North / Lat" labels leave the wrong coordinate system visible; per-field rows plus
visibility refresh on mode/delivery.
*Check:* `node --test test/nodes/move-html.test.js`.

**14.41 Admin-API deploys do not materialize editor defaults.** ✔ 🧪 (2026-08-11)
Raw flow JSON posted to `POST /flows` keeps omitted properties absent —
`Number(undefined)` is `NaN`, and `setTimeout(..., NaN)` fires next tick. Every example
node that reads an editor-defaulted value ships it serialized; a contract test guards
this.
*Check:* `node --test test/sitl/example-json-contracts.test.js`.

**14.42 Vehicle Profile `dialectRevision` must be serialized for Admin deploy.** ✔ 🧪 (#317)
After affirmative dialect picks, a blank revision fails `resolveDialect` and the
Connection throws at deploy. Every example profile ships `"dialectRevision": "seed"`;
same contract test.

**14.43 An omitted action-node `identity` must not become the string `"undefined"`.** ✔ 🧪 (2026-08-18)
`String(undefined)` is a real override id that `Connection.send` fails to look up.
`resolveIdentity` treats only `null`/`undefined`/`''` as "use the Connection default";
missing values coerce to `''`.
*Check:* `node --test test/addressing/delivery-context.test.js`.

## 14.44 – 14.54 Node-RED runtime facts

**14.44 Status records are not stamped, and action nodes do not refuse them on input.** ✔
Silence on output 0 already stops the chain on failure; a stamp/refusal path is a
guardrail for bad wiring. Status records are plain objects on output 1; the only
suppress sentinel is `msg.payload === false`.
*Check:* `rg -n '__mavlinkStatusRecord__|_mavlinkStatus|refuseIfStatus|isStatusRecord' lib nodes` — no matches.

**14.45 Input-handler Catch is `done(err)`, never `node.error` + bare `done()`.** ✔
The latter pairs an error report with a successful finish.
*Check:* `node --test test/delivery/catch-path-scan.test.js`.

**14.46 Direct Connection references bind once, in the constructor.** ✔
Node-RED recreates direct consumers when their configuration nodes change, so a
per-message re-lookup buys nothing. Missing-Connection terminal behavior stays output 1
plus `done(err)`. (Measured against Node-RED 5.0.1's editor-client; re-check
`prepareConfigNodeSelect` after upgrades.)
*Check:* `node --test test/addressing/delivery-context.test.js`.

**14.47 Closing a node does not stop a promise chain it started; a cancelled run is not a failed one.** ✔
`close` removes the node without aborting in-flight awaits — an unhandled fan-out kept
sending live commands after redeploy. Cancellation needs: a signal checked between
members, an abort hook on each in-flight wait (including hand-rolled promises), and
timer-disposing pauses; `close` waits for the run to unwind. `'cancelled'` routes to the
quiet branch, never the Catch-visible failure branch. (The mechanism now lives in the
`inFlight` tracker + `AbortSignal` plumbing in `lib/fanout`.)
*Check:* `rg -n 'signal|cancel' lib/fanout/index.js nodes/mavlink-fanout.js`; `node --test test/fanout/`.

**14.48 Palette nodes share `lib/delivery`'s badge/status helpers.** ✔
Local `cap()`/`badge24()`/status-record copies drifted and are banned.
*Check:* `rg -n 'BADGE_MAX\s*=\s*24|function badge24|BAND_CONTROL\s*=' nodes` — no matches.

**14.49 Admin catalog routes and role×tier resolution are shared modules.** ✔
`registerDialectCatalogRoute`, `resolveCatalogSource`, `resolveDeliveryContext` own the
skeletons (`applyConnectionStatus` carries the deploy badge — `missingConnectionGate`
was absorbed into it). Canonical keys only: `targetSystem`/`targetComponent` everywhere
a node speaks; the Vehicle Profile alone keeps the `default` prefix because there it
genuinely is a default.
*Check:* `rg -n 'targetSysid|targetCompid' lib nodes resources test` — no matches.

**14.50 "Is this reader normal?" — ask what writes the key.** ✔ (rule of thumb)
If nothing in `defaults`, no input, and no lifecycle hook writes a config key, its only
possible source is flow JSON from an earlier dev build: a leftover reader, whatever it
is called. Pre-1.0 forbids those (no `oneditprepare` copy shims, no
`firstDefined(..., config.oldName)` dual readers).

**14.51 Lib holdouts share one owner per concern.** ✔
`endpoint-key`, NaN-safe `clone.deepCopy`, `xml-catalog.extractIncludes`,
`OutboundQueue._bestItem`, `carrier.commandByValue`, `commands-list` labels, param
`PARAM_TYPE` derived from codec `PARAM_TYPES`. Declined as non-dupes: the
`numberOr`/`valueOr` family, frame tables, transport write-drain skeletons.
*Check:* `node --test test/connection/queue.test.js test/metadata/admin-catalog.test.js`.

**14.52 Mission confirm without a Connection fails loud.** ✔
A chosen wire tier with no Connection is misconfiguration (`invalid config`, failed
status, no output-0 success) — the "fall back to Build" language in §9 is about the
*editor's default-tier preselection*, not a runtime invent.
*Check:* `node --test test/mission/node.test.js`.

**14.53 A numeric editor default does not make a cleared optional input nonblank.** ✔
Cleared number inputs reach the runtime as `''`; blank preserves the documented default
behavior (e.g. ACK timeout 10 s), an explicit number is honored.
*Check:* `node --test test/command/node.test.js test/payload/node.test.js`.

**14.54 Vehicle Profile target defaults reach nodes only through the addressing matrix.** ✔
Resolution is payload → companion derivation → node config → profile default,
implemented once in `lib/addressing`; the Connection exposes a frozen `node.vehicle`
snapshot. Blank editor sysid/compid means "inherit"; an explicit 1 means exactly 1.
*Check:* `node --test test/addressing/resolve.test.js`.

## 14.55 – 14.70 Wire, codec and connection

**14.55 `Buffer` already range-checks integers — and has three silent cases.** ✔ (probe re-run)
`writeUInt8(300)` throws `ERR_OUT_OF_RANGE`; do not re-implement. The silent cases:
`writeUInt8(undefined|null)` writes 0, `writeFloatLE('abc')` writes NaN.
Also: `new Clazz()` defaults every integer property to `0`, so an *omitted* field
that never reaches `assignFields` still serializes as 0 — the same silent path.
That silence is not a library refusal (§9). Owner carve (2026-08-20): before pack,
`wire.js` checks the **fields bag** — every core (non-extension) scalar int must be
spoken and finite (spoken `0` is fine). Else cryptic `invalid packet` (→ `failInput`,
status output 1). No class poison; no field-naming lecture. Extensions stay layout `0`
(14.65). Builders must not invent substitute ints/frames for blanks.

**14.56 A non-finite value on an integer field serializes as 0 — the broadcast address.** ✔ 🧪 (2026-08-06; pack bag-check 2026-08-20)
`Buffer.write*Int*` range comparisons are *falsely passed* by `NaN` (both `> max` and
`< min` are false), so a NaN target would hit the wire as `target_system 0`. Measured
false-success hazard. Pack refuses blank/non-finite/omitted core ints on the bag
before `assignFields`. Floats untouched — NaN is legal MAVLink ("field not used").
*Check:* `node --test test/connection/wire-nonfinite.test.js`.

**14.57 Packet sequence numbers cannot deduplicate across links.** 📖 (spec)
Each channel keeps its own counter. Surface the two-links-vs-two-vehicles condition;
never resolve it.

**14.58 Signing is a v2 feature and transmit is v2-only.** 📖 (spec)
An inbound v1 frame is the same case as an unsigned v2 frame — no separate rule.

**14.59 An invalid signature is not unconditionally rejected.** 📖 (spec)
The spec directs libraries to allow conditional acceptance of incorrectly signed packets
(key-recovery), with a conspicuous untrusted indication. Off by default; never advances
the timestamp store.

**14.60 node-mavlink's `sign()` cannot carry the runtime's signing timestamp and never sets `IFLAG_SIGNED`.** ✔ 📖
Its `timestamp` parameter is a Unix-ms clock reading (internally converted), so passing
the runtime's 48-bit 10 µs units double-converts, and omitting it stamps `Date.now()` —
two frames in one millisecond collide and a spec receiver rejects REPLAY. It also never
sets the signed bit, which lives in the CRC'd header. `wire.js` `signFrame()` therefore
writes the signature block itself. Do not "simplify back to the library call".
*Check:* `node --test test/connection/wire-signing.test.js`.

**14.61 Node core exposes no DSCP setter; marking needs a native binding.** ✔
`dgram`/`net.Socket` never reach `IP_TOS`/`IPV6_TCLASS`. The toolkit now ships that
binding: `sockopt` as an optional dependency, used by the transports.
*Check:* `rg -ln sockopt lib/connection/transport package.json`.

**14.62 Heartbeat cadence lives on Local Identity, not Connection.** ✔
MAVLink mandates no HEARTBEAT rate (~1 Hz is RF convention). Local Identity owns content
and `heartbeatIntervalMs` (blank = 1000, exactly one reader); Connection emits per bound
identity and keeps only peer-table stale/expire.
*Check:* `node --test test/connection/heartbeat.test.js test/identity/`.

**14.63 `target_system = 0` is one frame to N addresses, not one datagram.** ✔ 🧪
On a dialed-in (udpclient) fleet, "everyone" is each learned peer's own return path — a
single datagram to the configured remote reached nobody. `_pump` serializes once and
writes to every `endpointsForBroadcast` primary; an empty table falls back to the
configured remote. A failed write does not demote a primary on this path.
*Check:* `node --test test/connection/runtime.test.js`.

**14.64 A swarm address is delivery, not addressing.** ✔
`target_system = 0` in the frame is what makes vehicles act; the Swarm address is only
where the datagram is written. Precedence: configured swarm address → learned peers →
configured remote. Mechanism is read from the address itself (224.0.0.0/4 multicast +
loopback off, else `SO_BROADCAST`). UDP only — TCP fan-outs to each client, serial
dedupes to one write.
*Check:* `node --test test/connection/`; `lib/connection/transport/udp.js`.

**14.65 A decoded message field is never "absent" — omitted MAVLink 2 extensions arrive as 0.** ✔ (probe re-run)
Trailing zero-truncation destroys absence at the *sender*; the deserializer zero-pads.
Consumers surface the number; `null` is reserved for spec sentinels and for transactions
where no message arrived. Test fixtures for decoded messages must round-trip through
`createWire`, never be hand-built.
*Check:* serialize→decode probe prints `progress 0, result_param2 0`.

**14.66 The raw codec does no unit conversion — degE7/rad scaling belongs to the typed surfaces.** ✔
Every reference *raw* layer is unit-blind (pymavlink generated senders, node-mavlink
classes, MAVSDK passthrough); scaling lives one layer up in the command/move/payload/
mission builders. Locally decisive: `mavlink-in` emits raw wire fields, so a scaling
Build could not consume mavlink-in's own output.
*Check:* `node --test lib/codec/test/field.test.js`.

**14.67 Bit 31 is a sign bit three times over.** ✔
JS bitwise ops coerce to signed int32; the param wire decodes int32 so a full mask
arrives spelled negative (`LOG_BITMASK -1` is every bit); `writeInt32LE` rejects ≥ 2³¹.
Use `lib/codec/mask.js` (power-of-two arithmetic; `no-bitwise` lint in the codec dir)
and the editor's BigInt bitmask helpers — never raw `&`/`<<`.
*Check:* `node --test test/nodes/param-defs-editor.test.js`.

**14.68 Bytewise NaN-pattern integers survive the JS float round-trip.** ✔ (probe re-run)
V8 preserves quiet-NaN payloads through `readFloatLE`/`writeFloatLE` — bytewise INT32
−1 (0xFFFFFFFF) round-trips exactly. Only signaling NaNs canonicalize, and rejecting
those is correct. The two destroyers are `structuredClone` and JSON round-trips —
`lib/connection/clone.js` refuses both by design.
*Check:* `paramValueToWire(-1, 6, 'bytewise')` → `paramValueFromWire` → `-1`.

**14.69 UDP, TCP and serial ship on one Connection contract.** ✔
All three share the shallow-write/drain contract; serial is an optional lazy-loaded
dependency, and UDP/TCP installs must work without it.
*Check:* `node --test test/connection/transport-*.test.js`.

**14.70 `Number(' ')` is a finite zero — a blank test of `=== ''` is not a blank test.** ✔
A whitespace-only string zero-fills wherever `undefined|null|''` was the blank test
(measured hazards included a commanded EKF origin and a never-expiring TTL). Fixed at
the sentinel: `isBlank` trims (`Number('')`, `Number(null)`, `Number([])` are all 0 —
check what the language coerces before trusting any blank guard).
*Check:* `lib/addressing/resolve.js` `isBlank`; `node --test test/move/move.test.js`.

## 14.71 – 14.80 Addressing, targets and the Command node

**14.71 Target resolution happens once; builders do not re-default; no hardcoded final 1.** ✔
Matrix: payload → companion derivation → config → profile. The only `…, 1)` in the tree
is companion compid derivation in `lib/addressing/resolve.js` — a matrix address, not a
null-guard.
*Check:* `rg -n 'numberOr\([^,]+,\s*1\)|firstDefined\([^)]*,\s*1\)' lib nodes` — one hit, the derivation.

**14.72 An unresolved target breaking at encode beats inventing drone 1.** ✔
Inventing `{1,1}` can arm the wrong airframe; a non-finite id refuses at the wire choke
point (14.56) naming the field and the broadcast hazard.

**14.73 Build catalogs come from an explicit Dialect (or the Vehicle Profile escape) — never a silent default.** ✔
Empty dialect / empty escape-vehicle is editor-invalid; wire tiers hide the fields and
use the Connection's profile. Param/Mission Build require Firmware when not using a
profile. Hidden is not honored.
*Check:* editor HTML suites; `node --test test/addressing/resolve.test.js`.

**14.74 The default COMMAND_INT frame is 3, and a wrong frame has no safety net.** ✔ 📖
ArduPilot checks a COMMAND_INT takeoff frame with strict equality against
`MAV_FRAME_GLOBAL_RELATIVE_ALT` (3) and answers DENIED (4) otherwise — which no carrier
swap retries (only ack codes 7/8 arm it). ArduPilot's own LONG→INT upconvert fills in
frame 3, so the default gives the same answer. PX4 accepts either, which is why
PX4-first validation never caught it.
*Check:* `node --test test/command/carrier.test.js` — pinned to the literal 3.

**14.75 Blank preset coordinates are refused per preset, because the dialect cannot tell you.** ✔ 🧪
`hasLocation`/`isDestination` do not separate "blank means here" (takeoff, land) from
"blank means the Gulf of Guinea" (26 commands carry both flags). The rule rides the
preset (`requireLocation` on Go To/Orbit; `unless param1=1` on Set Home) and runs on the
operator's input *before* zero-fill; an explicit 0 still sends. Blank must survive to
the check: `mergeParams`' `isBlank` and fan-out's builder treat blank/whitespace as
absent. Since #286 the preset coordinate rule lives in the editor
(`nodes/mavlink-command.html` `params` validator). **Advanced mode is deliberately
unguarded — that is the escape hatch; do not re-raise.**
*Check:* `node --test test/command/presets.test.js`; `rg requireLocation nodes/mavlink-command.html`.

**14.76 Local-frame param5/6 are metres, not subject to the ±90/±180 degree gate.** ✔ 🧪
The editor check reads the selected MAV_FRAME; known local frames skip the degree gate,
COMMAND_LONG and global frames keep it, and an unknown frame stays on the degree path.
*Check:* `node --test test/nodes/command-html.test.js` (`localFrameSelected`).

**14.77 COMMAND_INT x/y has no cross-fleet "keep current" sentinel.** 🧪 📖
PX4 honors the *paired* `INT32_MAX/INT32_MAX` form; ArduPilot runs `check_latlng` with
no sentinel branch and NAKs it (214.7° is out of range). The cross-fleet way to say
"keep current position" is COMMAND_LONG with NaN param5/6.
*Check:* `node --test test/command/carrier.test.js`.

**14.78 Local-frame COMMAND_INT x/y really is metres × 1e4.** 🧪 (measured both stacks)
PX4 applies the frame-dependent divisor exactly as specified (÷1e4 local, ÷1e7 global,
read back from uORB); ArduPilot doesn't scale local frames — it *denies* them for
location-bearing commands. So ×1e4 fixes a real 1e4 error on PX4 and cannot regress
ArduPilot. Every `LOCAL_FRAMES` member was measured individually; frame 13 (tombstone)
deliberately stays unclassified/pass-through.
*Check:* `lib/command/carrier.js` `LOCAL_FRAMES`; probe recipe in the entry's history
(send before reading — `px4-listener` prints the retained previous value on start).

**14.79 Takeoff completion compares climb height; the takeoff param's datum is frame-dependent.** ✔ 🧪 (unit-tested; SITL 2026-08-22)
In an absolute frame the param is AMSL — comparing it to `relative_alt` never satisfies
at non-zero home elevation. Completion converts absolute frames via
`param − (alt − relative_alt)`; only the effective-INT carrier passes a frame.
AP Copter-4.7 at home AMSL ~584 m: 10 m relative takeoff completes at ~10 m
`relative_alt` (`node sitl/measure-verification-debt.js`).
*Check:* `node --test test/command/completion.test.js`; rig probe `takeoff-14.79-sitl`.

**14.80 A `PARAM_VALUE` echo is decoded by the frame's own `param_type`; the request's type only encodes the outbound set.** 🧪 (re-measured 2026-08-18)
ArduPilot stores by its own table type and *ignores* the wire type (a REAL32-labeled set
of 1 still stores 1.0 and echoes type INT32); the echo's `param_type` is the only
correct decode key. ArduPilot's integer slot is **c-cast** (1 → `0x3F800000`), PX4's is
**bytewise** (`0x00000001`) — the old "bytewise INT16 / denormal" reading did not
reproduce. Tolerance follows the wire: float32 precision for c-cast, exact for bytewise.
*Check:* `node --test test/param/param.test.js`.

## 14.81 – 14.89 Parameter protocol

**14.81 Param encoding resolves override → capability bits → named firmware; never invented.** ✔
Explicit `msg.payload.paramEncoding` wins; then `PARAM_ENCODE_BYTEWISE`/`_C_CAST`
capability bits; then named firmware (PX4 → bytewise, else c-cast). A present-but-invalid
override rejects; an empty ladder throws; `custom` firmware refuses rather than
defaulting to c-cast (deliberately no editor red-ring — either escape can make it
correct at message time). `resolveParamEncoding` is the only place the ladder runs.
*Check:* `node --test test/param/param.test.js test/addressing/resolve.test.js`.

**14.82 A parameter's encoding is not discoverable on ArduPilot.** 🧪 (2026-08-13, re-measured 2026-08-22)
Neither stack streams `AUTOPILOT_VERSION` unsolicited; on request PX4 reports the
bytewise bit, **ArduPilot reports neither encoding bit** (capabilities 64495). The
capability rung can only correct a mislabeled PX4; `HEARTBEAT.autopilot` (1 Hz, free)
subsumes the probe for every case either could fix.
*Check:* `node sitl/measure-capabilities-299.js` (rig).

**14.83 A wide bitmask does not survive c-cast — and the loss reports success.** 🧪 (2026-08-13)
float32 carries 24 mantissa bits: what breaks is *bit span*, not magnitude (−1 and −2³¹
survive exactly; bits 24+0 truncate; the only reliable test is
`Math.fround(v) === v` on the signed value — "spans > 23 positions" is wrong, the
two's-complement fold makes 8+32 exact). The float-tolerance confirm then collapses the
truncation into a clean "confirmed". Reachability kills the fix: every affected
ArduCopter param is a 32-channel mask needing a sparse high+low selection on real
high-channel hardware. **#298 stays documented-not-built.**

**14.84 The echo-match type gate is conditioned on the resolved encoding.** ✔ 🧪 (2026-08-18)
On c-cast (ArduPilot) the echo type is the vehicle's own table type, so a type-equality
check against the *sent* type false-fails with no storage failure to catch; on bytewise
(PX4) that check is the only thing between a garbage store and a confirmed success. The
condition is written "not proven c-cast" so an unresolved encoding keeps the gate.
Wrong-encoding sends corrupt silently in both directions (bytewise→AP zeroes the value,
except −1 whose NaN pattern AP ignores outright; c-cast→PX4 stores the float bits
verbatim).
*Check:* `matchesParamEchoWire` in `lib/param/index.js`; regression
`examples/sitl/12-param-fanout-set.json` (five *accepted*, not five *unconfirmed*).

**14.85 No library is coming for the parameter bit/int hazards — and the references verify less than we do.** 📖
node-mavlink serializes `param_value` as a plain float and leaves the union to the
application; pymavlink and QGC each solve the union in ~15 lines, unpackaged. Neither
reference compares the echoed *value* at all (pymavlink matches name only and caches the
encoded float; QGC clears its waiting map on any PARAM_VALUE for the name). The
float32-mantissa hazard is not solvable by anyone.

**14.86 Param actions build three different messages with disjoint fields.** ✔
`PARAM_REQUEST_READ` (id + index), `PARAM_SET` (id + value + type),
`PARAM_REQUEST_LIST` (targets only). Row visibility and validation follow the action
(`applyActionRows`) — **a hidden field's validator hides with it**, except the index,
which is stamped to −1 ("use param_id") because a leftover index wins on the wire.
*Check:* the bundled-metadata probe in the entry; `rg applyActionRows nodes/mavlink-param.html`.

**14.87 Peer capabilities arrive as BigInt.** ✔ 🧪
The codec yields `AUTOPILOT_VERSION.capabilities` as BigInt; JSON writers must
stringify.
*Check:* `node sitl/measure-peer-table.js` (rig); peer-table tests.

**14.88 The `MAV_PROTOCOL_CAPABILITY` bitmask can lie.** 📖 (2026-08-14)
Blimp advertises all three setpoint messages and handles none of them. Never gate a
feature on `AUTOPILOT_VERSION.capabilities` alone — there is one confirmed liar in the
fleet.

**14.89 Mode-name resolution is a ladder: vehicle `AVAILABLE_MODES` first, shipped tables second.** ✔ 🧪 (2026-08-18)
Both lab stacks answer `REQUEST_MESSAGE 512 param1=435` — the standard-modes protocol is
not PX4-only. Protocol record in `MAVLINK.md`; the toolkit rungs live in
`lib/vehicle/modes.js`.

## 14.90 – 14.93 Mission protocol

**14.90 An early error MISSION_ACK is the rejection, not a stale leftover.** ✔ 🧪
ArduPilot answers an oversized count with `NO_SPACE` *before requesting a single item*
(measured: 7 ms after MISSION_COUNT 60000); gating errors on delivery progress turns the
most common rejection into a retry stall with the reason discarded. Stale-ack protection
is the `mission_type` filter and subscription lifetime. Exempt only `INVALID_SEQUENCE`
(mid-transfer noise, non-terminal). Upload treats a premature `ACCEPTED` as a protocol
error; download ignores a vehicle `ACCEPTED` (the closing ack there is the GCS's own).
Download carries the identical rule (#246).
*Check:* `node --test test/mission/upload.test.js test/mission/download.test.js`.

**14.91 Mission command support is the firmware's call, not a validator's.** ✔ 📖 (#90, then #287)
The old NAV/DO numeric window silently rejected items PX4 accepts (530, 2000/2001,
2500/2501, 3000) while ArduPilot accepts a *different* set; the XML has no
mission-capable attribute; pymavlink/MAVSDK pass anything through and QGC treats
`MISSION_ACK` as the authority. The runtime item validator has since been **removed
entirely** — the vehicle judges (`MAV_MISSION_UNSUPPORTED` on output 1), the editor
validates the configured shape, and non-global frames are refused by both firmwares
(`MAV_MISSION_UNSUPPORTED_FRAME`), which is why the INT builder's local-frame
passthrough is unreachable rather than harmless.
*Check:* `ls lib/mission/` — no `validate.js`; `lib/mission/items.js` header.

**14.92 Mission upload items live under `msg.payload.items`, not a bare array.** ✔
A bare JSON array yields `[]` and is refused before any packet leaves.
*Check:* `nodes/mavlink-mission.js` (`resolveItems`).

**14.93 Mission Clear needs no confirmation gate.** ✔ (owner ruling, 2026-08-13)
Selecting Clear in the editor is the answer; checkbox, `msg.confirmed` escape and
`unconfirmed` phase are gone (#292). The destructive guard that stays is the
empty-upload refusal — an upload can never degrade into an accidental clear (#241).
*Check:* `rg confirmClear` → only the test pinning its absence.

## 14.94 – 14.112 Move and motion

**14.94 A local frame's position triplet is absolute or offset *per firmware*, not per frame.** 🧪 (2026-08-05, cornerstone)
One position-only probe (`x=10, y=0, z=-20` from a displaced, yawed start):
`LOCAL_NED` (1) is **absolute on both stacks** — a blank→0 is a real place;
`LOCAL_OFFSET_NED` (7) is a world-axis offset on ArduPilot, **no motion on PX4**;
`BODY_OFFSET_NED` (9) is a body-axis offset on ArduPilot, **no motion on PX4**;
`BODY_NED` (8) behaves like 9 on ArduPilot and is *not* an offset on PX4 (inconclusive,
provably not inert). Do not infer a third frame's behavior from two siblings' names.
PX4 mechanism (source): body frames are velocity-only (position discarded); frames
outside the switch are rejected.
*Check:* `node --test test/move/move.test.js` ("a blank local coordinate encodes 0, on
every frame"); raw data `local-ned-frame-results.json` on the test host.

**14.95 The same run refuted three firmware advisories and killed a mode.** 🧪 (2026-08-05/06)
Refuted: "ArduPilot ignores acceleration-only setpoints" (moved ≈43 m); "`BODY_NED` is
the PX4 body frame" (inverted — 8 works on AP, misbehaves on PX4); "PX4 rejects terrain
position targets" (accepted frame 11; datum honor not instrumented). Confirmed: the
force bit (512) is not actuated on either stack — and a measured-dead mode is not a
capability, so Force was **deleted**, not warned about (advise on what might work
elsewhere; delete what is measured to work nowhere). `mavlink-build` remains the raw
`type_mask` escape hatch.
*Check:* `grep -ri force lib/move` → nothing.

**14.96 Move speaks MAV_FRAME 0/3 at the action layer and encodes the `*_INT` twins (5/6) on the wire.** ✔ 📖
PX4 exact-matches 5/6/11 in the GLOBAL_INT setpoint handler and rejects the modern
spellings; ArduPilot accepts both; MAVSDK sends only the `*_INT` set. So
`PX4_COMPAT_FRAME` maps 0→5 and 3→6 at encode; terrain left the Move surface with the
Action redesign (altitude reference is home|msl). `time_boot_ms` is stamped from a
shared boot clock (`bootNow`), with `payload.timeBootMs` as the escape — neither
firmware reads it in these handlers.
*Check:* `lib/move/index.js` `PX4_COMPAT_FRAME`; `node --test test/move/move.test.js`.

**14.97 Move stream stop is a zero-velocity setpoint, not an all-ignore no-op.** ✔ 🧪 (#115)
`buildStopMessage` uses the velocity mask with `vx=vy=vz=0` (mask 3527) — active
braking, same encoding as a velocity stream. PX4 logs "invalid" only for true all-ignore
(3583), which is not what we send. Keep the stop packet; without it stream cessation
alone leaves only the offboard timeout.
*Check:* `lib/move/index.js` `buildStopMessage`; `node --test test/move/move.test.js`.

**14.98 Move SITL queue findings (#175/#179).** 🧪 (2026-08-08, re-measured 2026-08-22)
1. Stream-replace halt is invisible (~4% dip at 10 Hz) — thin null result (400 ms
   window, 4 samples/frame); enough to decline a mutate-in-place rewrite, not enough to
   rely on beyond that.
2. ArduPilot absolute-yaw yaw-only (mask 2559 exactly) does nothing — `hold_position()`
   never reads yaw. A yaw-only setpoint *with* a rate is a different mask and was
   measured slewing.
3. ArduPilot one-shot velocity brakes after ~GUID_TIMEOUT (~3.3–4 s): sustained velocity
   needs Stream.
4. PX4 held OFFBOARD at 5 Hz *and* 1 Hz with lab helpers; full silence exits OFFBOARD.
   No "<2 Hz" advisory.
5. Yaw + yaw_rate are complementary on both stacks, but **the commanded rate is not a
   speed limit**: commanded 20 °/s, measured ~60 °/s (AP) far from target and ~44 °/s
   at mid error (15–45°) — still above the commanded cap; near target (<15°) slew drops
   to ~0 as the vehicle arrives (🧪 2026-08-22, `sitl/measure-verification-debt.js`).
6. `GUID_TIMEOUT` also parks the yaw mode (🧪 2026-08-22): a one-shot yaw+rate stops
   slewing after ~3 s (`node sitl/measure-move-179.js`, `ap-guid-yaw-park` probe).
*Check:* `node sitl/measure-move-179.js` (rig).

**14.99 There is no working way to yaw an ArduPilot copter with a setpoint or reposition — yaw is a command.** 🧪 📖
`DO_REPOSITION` param4 is ignored (`use_yaw=false`; ArduPlane reads it as loiter
direction) and a yaw-only stream holds heading (14.98.2). ArduPilot yaws in guided via
`MAV_CMD_CONDITION_YAW` (115) — Copter and Sub only (14.104). PX4 has no CONDITION_YAW
handler; heading there rides the setpoint yaw field it does honour. Hence Turn derives
per firmware and fails closed on unknown.
*Check:* `lib/move/turn.js`; move HTML help text.

**14.100 `LOCAL_OFFSET_NED` (7) is not a deprecated alias; on ArduPlane it is the only local setpoint frame.** 📖 (2026-08-13)
common.xml names no successor for 7 (unlike 8/9 → BODY_FRD, which nothing actually
emits). ArduPlane's local-setpoint handler accepts *only* frame 7 and reads only `z` —
every other frame returns silently. ArduCopter adds current position for 7, **8** and 9
(one handler branch — the 2026-08-05 measurement was right). QGC's only local-setpoint
send is frame 7 (guided altitude change). Restored as Steer's "Offset from here"; blank
axes are legal there and nowhere else (a zero *offset* is no movement; a zero *absolute*
is the EKF origin). Stream is not offered — a repeating offset walks the vehicle (🧪
2026-08-22: AP Copter-4.7, 5 Hz `LOCAL_OFFSET_NED` z=+2 m climbed ~7.3 m in 3 s;
`node sitl/measure-offset-stream.js`).
*Check:* `lib/move/frames.js` comment; frame-7 row of 14.94.

**14.101 Which motion message an ArduPilot vehicle honours is a property of the vehicle, not the firmware.** 📖 (2026-08-14, cornerstone)

| Move action | Wire | Copter | Plane | Rover/Boat | Sub | Blimp | Tracker |
|---|---|---|---|---|---|---|---|
| Go to (command) | `DO_REPOSITION` | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ |
| Go to (Stream) | `SET_POSITION_TARGET_GLOBAL_INT` | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ |
| Steer | `SET_POSITION_TARGET_LOCAL_NED` | ✓ | frame 7, `z` only | ✓ | ✓ | ✗ | ✗ |
| Turn | `CONDITION_YAW` | ✓ | ✗ | ✗ | ✓ | ✗ | ✗ |
| Speed | `DO_CHANGE_SPEED` | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ |
| Attitude | `SET_ATTITUDE_TARGET` | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ |
| Manual | `MANUAL_CONTROL` | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ |

Blimp *discards* MANUAL_CONTROL (the base-class axes handler is an empty virtual Blimp
never overrides — accepted, no NAK, no motion) and its real primitive is
`DO_REPOSITION`. Tracker moves through MANUAL_CONTROL and SET_ATTITUDE_TARGET, just not
the position carriers. Neither Plane nor Rover handles CONDITION_YAW (Plane's substitute
is `GUIDED_CHANGE_HEADING` 43002). The family gate is per (firmware, family), editor
only; the runtime sends whatever it is handed. PX4 is deliberately not family-gated —
this is ArduPilot's dispatch.
*Check:* the grep recipes in the entry (upstream `*/GCS_MAVLink_*.cpp`, `GCS.h`).

**14.102 ArduSub's MANUAL_CONTROL vertical axis is 0..1000 with neutral 500.** 📖
An all-zero "neutral" message commands full reverse vertical thrust. Move's operator
surface is −1..1 per axis, mapped to the wire convention exactly once at encode. Silence
is a failsafe on ArduSub (pilot-input timestamp → disarm), so ceasing to transmit is a
real stop; no sender-side TTL needed.
*Check:* `lib/move/manual.js`.

**14.103 Position + acceleration without velocity is not a Move mode.** 📖 ✔
ArduPilot's handler branches are PosVelAccel / VelAccel / Accel / Pos; mask 3128 matches
none, the vehicle holds, and setpoints carry no ack to say so — a silent no-op. Removed
from `MODES` (#287); the editor reds the combination naming the reason. Restoring it
costs one line plus a SITL measurement of mask 3128 actuating.
*Check:* `rg 'position-acceleration' lib/move` → nothing.

**14.104 A blank field with a dialect sentinel sends the sentinel; the sentinel is spelled at the call site.** ✔ (mechanism updated — see removals)
`DO_CHANGE_SPEED` param2 −1 is the wire's own "no change"; `CONDITION_YAW` rate 0 is
"vehicle default" and direction 0 is "shortest" — those blanks transmit the dialect's
word (`SPEED_UNCHANGED`, `RATE_DEFAULT`, `DIRECTION_SHORTEST`, `BUTTONS_NONE`, each a
named constant beside its meaning). Fields with *no* such encoding (heading, sticks,
anchor coordinates) are required in the dialog; the runtime coerces and sends per §0,
with the wire's finite-integer choke as the crater for integer garbage. The hazards that
motivated this stand measured: `'MSL'` falling out an else-arm became frame 3 (a 500 m
MSL command flying at 900 m MSL with a clean ACCEPTED), and a blank heading reaching the
wire as 0 is a commanded turn to north.
*Check:* `lib/move/speed.js`, `lib/move/turn.js`, `lib/move/manual.js`.

**14.105 A finite-number check on operator input is a guardrail; refusing a blank is refusing to invent.** ✔ (owner ruling, 2026-08-14)
The two arms answer to different rules: NaN on a float is legal MAVLink the vehicle
judges; non-finite on an integer is already refused at the wire choke, which says more
than a builder could. The tell: a refusal because *nothing was supplied* keeps
information the flow lost; a refusal because *what was supplied looks wrong* is the
dialog's job. Mask-ignored filler zeros are spelled at the call sites, next to the bit
that makes them legal.
*Check:* `test/connection/wire-nonfinite.test.js`; the five mask-ignored call sites in
`lib/move`.

**14.106 Coerce vs refuse — the driver's one question.** ✔ (owner ruling, 2026-08-13)
The runtime never refuses trusted input *that has a defined safe coercion* (an explicit
NaN rides; a blank speed sends the sentinel). Where no safe value exists to coerce to —
a blank formation anchor coordinate would coerce to null island — it refuses loud.
*Check:* `lib/formation/index.js` `formationTargets` (refusals), `lib/payload/index.js`
`valueOr` (coercions) — both test-pinned.

**14.107 Telling the vehicle is not telling the flow — a Move stream announces its own expiry.** ✔
TTL expiry emits a status record (`result: 'expired'`) on **output 1** — never output 0,
whose contract is "arrival means proceed, at most once per input"; a second message
there runs the whole downstream chain again. Stops the flow itself caused (replacement,
redeploy) stay silent: announce what the flow could not otherwise observe, nothing else.
*Check:* `node --test test/move/node.test.js` — the TTL test asserts output 0 is null.

**14.108 PX4 accepts a one-shot `DO_REPOSITION`; `CHANGE_MODE` is the gate on both stacks.** 🧪 (2026-08-11/12, flag-clear 2026-08-22)
No OFFBOARD stream and no caller-side mode switch needed. Isolated one-field probes:
a reposition is **ACCEPTED iff `CHANGE_MODE` (param2 bit) is set OR the vehicle is
already in the stack's guided-capable mode** (GUIDED on ArduPilot, AUTO_LOITER/Hold on
PX4), otherwise **DENIED (2) on both stacks**. MAVSDK's per-autopilot pre-switch is the
same table client-side. PX4 in Hold (`0x03040000`) with `changeMode=false` → ACCEPTED
(🧪 2026-08-22, `sitl/measure-verification-debt.js`). Post-goto heading: PX4
honours param4 yaw (~70° vs 90° commanded, Δ20°); ArduPilot ignores it (355° vs
90°) — the completion tier reports ack only, not resulting heading (14.108-heading).
The 2026-08-11 run's `param4` was encoded in radians — units settled.
*Check:* `node sitl/measure-verification-debt.js`; one-field twins of examples 27/30.

**14.109 PX4 refuses a stick-driven mode airborne without RC.** 🧪 (2026-08-12)
Airborne with no RC input, `DO_SET_MODE` POSCTL answers TEMPORARILY_REJECTED forever —
the same command ACKed on the ground pre-arm. Ground-vs-airborne is the variable.

**14.110 PX4 `DO_SET_MODE` on the lab SIH wants main_mode in param2, not the HEARTBEAT bitfield.** 🧪
param2=196608 (POSCTL packed) is TEMPORARILY_REJECTED; param2=3 is ACCEPTED and
HEARTBEAT then reports 196608. Completion-tier mode match compares param2 to peer
`flightMode`, so delivery=complete cannot cross that encoding split. Re-measure if the
Compose digest changes.
*Check:* `examples/sitl/36-mode-tables.json`.

**14.111 A takeoff/motion-message capability field that exists is not a capability.** 📖 (summary rule)
Both COMMAND_INT yaw fields (14.99), Blimp's advertised setpoints (14.88), and
`hasLocation` (14.75) all demonstrate the same thing: presence of a field or flag in
the dialect proves nothing about any firmware acting on it. Hypothesis from source,
authority from measurement — in that order (read the handlers first; they would have
predicted the 2026-08-05 frame matrix in minutes, but only the rig answers actuation).

**14.112 Formation sphere is 3-D; pitch tumbles the pattern around body +Y.** ✔
`sphere` lays followers on a Fibonacci lattice with varying `down`; `pitchDeg` rotates
body offsets around +right before heading yaws around down. Planar shapes keep
`down: 0`; slot 0 rides the anchor; noses are not commanded (reposition yaw NaN).
*Check:* `node --test test/formation/formation.test.js test/formation/node.test.js`.

## 14.113 – 14.115 Fan-out

**14.113 The flow author is trusted end to end; only a filter may be quietly empty.** ✔ (owner rulings, 2026-08-09 → 2026-08-14 → current)
Selection dispatch is a §5 affirmative switch (`all` / `list` / `filter`); an
unrecognised mode selects no behavior — it neither defaults to the fleet (the original
sin: two negative `===` gates meant a typo selected *everyone*) nor gets a bespoke
vocabulary throw. Sysid lists are coerced, never vetted (one parser; an entry naming no
vehicle selects none, and the aggregate names who was actually selected). The
loud/quiet split stands: a `filter` matching nothing is a correct quiet answer (grey
`0 matched`, output 1 `success: false`); an empty explicit `list` or empty `all` is loud
(red badge, Catch-routable) — loudness follows whether the operator asserted vehicles
exist. Broadcast refuses any non-`all` selection by construction (target_system 0
cannot honour a subset).
*Check:* `lib/fanout/index.js` `selectFanoutMembers`, `parseSysidList`; `node --test test/fanout/`.

**14.114 Fan-out arm examples need a probe-arm, not a longer settle sleep.** 🧪
Peers reappear seconds after a restart but arm answers DENIED for another 20–40 s while
IMU/EKF settle; the settle time is not a constant, so a bigger sleep is a guess. A
`delivery=send` example passing is not evidence anything armed.
*Check:* `sitl/run-example-suite.js` (`waitApArmReady`).

**14.115 Vehicle-facing sends and per-member confirms all answer the close signal.** ✔
Four waits had to answer cancellation (inter-member pause, sequential AckWaiter,
param-echo confirm, broadcast confirm) — the hand-rolled promises needed their own
hooks; nothing reached them by default. See 14.47 for the general rule.
*Check:* `node --test test/fanout/` — cancellation tests were sabotage-verified (they
hang on the unfixed code).

## 14.116 – 14.130 SITL lab operations

All 🧪 — lab facts, kept as recorded; cited files verified to exist.

**14.116 Vehicles send telemetry *to* the Node-RED bind port.** AP `udpclient:<gw>:14550`,
PX4 `-t <gw> -o 14560`. `remotePort` is only the pre-peer fallback.
*Check:* `sitl/scripts/entrypoint-ap.sh`, `sitl/README.md`.

**14.117 PX4's example GCS bind is 14560→14561; companions 14540/14542.** ArduPilot `-I N`
occupies `14550 + 10×N`, so 14555 sat inside that band. `rg 14555 examples` is empty. ✔

**14.118 The ArduPilot lab image downloads the official prebuilt SITL binary.** ~7 MB from
`firmware.ardupilot.org`, x86_64-only, with the autotest default params (without them
ARM is DENIED). Image builds in under a minute; no waf compile.
*Check:* `sitl/Dockerfile.ardupilot`; `node --test test/sitl/entrypoint-ap.test.js`.

**14.119 Suite results live in `sitl-results` GitHub Issues, not result-only PRs.** Each run
closes the previous issue and opens a new one; harness JSON defaults to `/tmp/`;
`testing.md` is a pointer.

**14.120 The suite docker-restarts by restart class; examples are numbered in run order.**
Force-disarm cannot clear altitude (a vehicle at 18 m AGL gets takeoff DENIED), so
takeoff examples restart their fleet; most examples never take off and share one cold
prime (`restart: none`). Slug names are the durable identity.
*Check:* `sitl/lib/suite-schedule.js`; `node --test test/sitl/suite-schedule.test.js`.

**14.121 `waitMs` is a max wait.** The suite polls logs and early-exits on a specialized
PASS verdict only — never on PARTIAL/FAIL/UNKNOWN or the generic fallback.
*Check:* `node --test test/sitl/wait-until-ready.test.js`.

**14.122 ArduCopter takeoff examples set GUIDED before arm.** Armed STABILIZE→GUIDED is
DENIED until GPS/EKF ready; GUIDED while disarmed succeeds in seconds. Prep polls
HEARTBEAT custom_mode *and* probe-arms (cold boot needs ~30–40 s), then force-disarms.
Prep runners must pass `node -e` via argv, not `bash -c` quoting.

**14.123 ArduPilot cold-arm returns FAILED (4), not TEMPORARILY_REJECTED (1).** Arm acks are
FAILED with STATUSTEXT until ~23 s post-restart, then ACCEPTED; AckWaiter retries only
result 1, so FAILED is terminal. The retry example targets PX4 `DO_SET_MODE`
param2=196608, which stably returns (1) on the lab image.

**14.124 ARM in the same tick as the GUIDED ACK is FAILED.** Two stacked causes: ARM riding
the mode ACK within milliseconds fails on a warm vehicle (~1 s gap succeeds), and
STABILIZE-armable does not imply GUIDED-armable after cold restart.
*Check:* `examples/sitl/40-transition-events.json`.

**14.125 SITL 40 passes; the ACK→takeoff gap needs no padding.** The ON_GROUND frame lands
before liftoff at 2 Hz. Read the landed *value*: the first edge is 1→3
(`MAV_LANDED_STATE_TAKEOFF`), not 2 (`IN_AIR`) — gating "airborne" on `to === 2` misses
it. `HOME_POSITION` is not streamed (published at arming), so `home-changed` is a
baseline, never an edge.

**14.126 AP `DO_SET_HOME` GLOBAL_INT needs HOME/EKF origin first.** FAILED ~5 s after
restart, ACCEPTED once home exists (~20 s). Under selective restart the prep must
*request* home (a late Connection never sees the one-shot publication).

**14.127 Copter-4.7.0 SITL has no `WPNAV_SPEED`; unknown param names produce no echo.**
Live ids for examples: `LOIT_SPEED_MS` / `ARMING_OPTIONS` (AP, INT32),
`COM_RC_IN_MODE` / `MPC_XY_VEL_MAX` (PX4). `ARMING_CHECK` is gone. Note
`BATT_ESC_MASK` is in the published metadata but absent from the SITL build — metadata
presence does not imply the vehicle has the parameter.

**14.128 Payload SITL needs a dedicated AP with `--gimbal`.** The lab PX4 SIH has no
gimbal/camera stack. With `MNT1_TYPE=1` the legacy mount commands ACK 0; `CAM1_TYPE=1`
accepts IMAGE_START_CAPTURE and DENYs video; `GIMBAL_MANAGER_SET_PITCHYAW` is send-only.
Dedicated `ap-payload-31` on 14570.

**14.129 The signing example uses companion AP sysid 20 and the joke passphrase `hunter11`.**
`POST /flows` accepts a top-level `credentials` map keyed by node id — that is how Admin
deploys supply Connection signing credentials. Prep proves arm-ready *before*
`SETUP_SIGNING`; the companion keeps signing off the main GCS fleet ports.
*Check:* `examples/sitl/38-signing.json`; `sitl/run-example-suite.js`.

**14.130 Peer-table §8 fields were proven end-to-end from a live airborne vehicle.**
`sitl/measure-peer-table.js` asserts identity, armed/active, endpoints, position with
heading, GPS fix, battery, home, freshness, snapshot projection, `AUTOPILOT_VERSION`.
The State-snapshot example must `SET_MESSAGE_INTERVAL` for `GLOBAL_POSITION_INT` before
takeoff on this lab image.

## 14.131 Send path

**14.131 Every send serializes twice — validation dry run plus pump serialize — and stays that way.** ✔ (owner ruling, 2026-08-22)
`send()` dry-runs `serialize` (seq 0, unsigned, buffer discarded) so an unencodable
message — a name absent from the bound dialect, a field `Buffer.write*` range-rejects —
throws synchronously into the sending node's error path instead of dropping later in
`_pump()` behind a phantom green `sent`. The pump serialize is the real one: seq is
assigned in wire order at dequeue, and on signed links it sits inside the CRC'd + signed
region, so a cached dry-run buffer cannot be patched without redoing most of the encode.
Cost is microseconds per frame (per-message field metadata is precomputed, #371).
Declined: collapsing to one serialize (moves the failure past `send()`'s return — phantom
success), and a standalone cheap validator (re-implements the range coverage Buffer
provides per 14.55, then drifts). Do not re-raise without a measurement showing the dry
run matters at streaming rates.
*Check:* `lib/connection/runtime.js` `send()` (the dry run and its comment).

**14.132 Verification debt is inventoried; it does not block 1.0.0.** ✔ (owner ruling, 2026-08-22)
An external 1.0.0 readiness audit counted **29** rig-only §14 rows (🧪 without ✔ —
fourteen tagged plus fifteen lab-ops entries 14.116–14.130) and **21** source-read
gaps (fourteen 📖 headers without ✔ plus seven named open subclaims inside otherwise
settled entries). The inventory is real and lives in `docs/verification-debt.md` with
a drift script (`scripts/inventory-verification-debt.js`).
It is **not** a release blocker because: (1) rig debt is lab-harness and
example-timing knowledge, not missing driver validation — the runtime still sends what
it is handed (§0); (2) every source-read gap on a shipped operator path is either
withheld in the editor (e.g. Stream on offset Steer — 14.100), absent from the surface
(e.g. terrain alt ref), or labelled in help as source-read; (3) none produce silent
false success — the only promotion path for an unmeasured mechanism is a demonstrated
silence-or-false-success outcome (§9). Post-1.0 measurement priority is ordered in the
inventory doc; the highest-value probe is confirming the offset-stream withhold on SITL.
*Check:* `node scripts/inventory-verification-debt.js`; `docs/verification-debt.md`.

**14.133 Swarm multicast and subnet broadcast reach real vehicles on the lab.** 🧪 (2026-08-22)
With the driver fixes on main (loopback at OS default; bound-identity echo dropped in
`_onFrame`), a Connection bound `0.0.0.0:14550` with swarm address `239.255.145.50`
learns ap-mcast-41, arms it with one `target_system=0` write, and does not register
sysid 255 as a peer. Two group members on one host hear each other. PX4 sysid 42 on the
bridge accepts subnet broadcast (`172.18.255.255:18570` with `MAV_0_BROADCAST=1`) and
arms from `target_system=0`. **Lab topology:** the compose bridge does not deliver
inter-container IPv4 multicast — ap-mcast-41 needs `network_mode: host` (INSTANCE 5);
the measurement script runs on the host. PX4 broadcast is tested from the host against
the bridge gateway path.
**Verdict: the Swarm address ships as-is (keep, 2026-08-22).** All five entrypoint-brief
probes passed on the first measured run; delivery works in both directions. The
multicast-interface option stays deferred until a multihomed host actually misroutes
(the lab trap was container topology, not the driver).
*Check:* `docker compose --profile mcast up -d`; `node sitl/measure-swarm-mcast.js`.

## 14.134 Safety confirmation

**14.134 The `msg.confirmed` gate was never owner intent; 14.93 was always the whole rule.** ✔ (owner ruling, 2026-08-23)
The old spec's "every Safety preset requires an explicit confirmation" and the fan-out
Flight-Termination / broadcast-position-setpoint gate (`DESIGN_old.md` §"Safety", §10)
recorded a policy no owner asked for: an agent built the gate, wrote it into the spec,
and later agents — and the review bots reading the spec — treated the record as gospel;
it even survived 14.93 as a supposed special case. Ruled: wiring the message is the
decision, for every command. The runtime gate, the `msg.confirmed` escape, and Fan-out's
Confirm checkbox are gone (#356). The protector that stays is the editor: a preset's
`requiresConfirmation` now drives only the Safety notice row
(`mavlink-command.html` `refreshSafetyNotice`), never a send refusal. The lesson is the
register's own scope rule: a recorded *policy* is a hypothesis about owner intent until
the owner ratifies it — only measurements are self-supporting ground truth. Do not
re-derive a confirmation gate from `DESIGN_old.md`.
*Check:* `rg "msg.confirmed" lib nodes` → nothing; `refreshSafetyNotice` in
`nodes/mavlink-command.html`.

---

## Removed from the old §14, and why

Entries and passages dropped in this rewrite. The *measurements* they carried survive
above; what is gone is decisions since reversed, mechanisms since replaced, and claims
since refuted. (Verified against the tree, 2026-08-19.)

1. **The `OFFSET_FRAMES` blank-coordinate guard and every coordinate refusal** — retired
   #284/#286; the editor's all-or-nothing triplet rule replaced them. The frame
   measurements stand as 14.94.
2. **The Move advisory table and `advisoryFor`** — removed #285. The measurements that
   built it stand as 14.95/14.98.
3. **Force mode** — deleted outright (14.95); the old "keep with a warning" resolution
   was itself superseded before removal.
4. **`requireNumber` and the blank-throws-naming-the-field design** (owner rulings,
   2026-08-14) — the helper no longer exists. Under the current §0/§5 doctrine the
   dialog requires what has no sentinel, sentinels are spelled at call sites, and the
   wire's finite-integer choke is the crater. Facts preserved in 14.104/14.105.
5. **Move enum resolvers throwing on unknown tokens** (`enumValue`, same rulings) —
   replaced by §5 affirmative switches returning NaN, refused at the wire choke. The
   altRef `'MSL'`→frame-3 hazard that motivated it is kept in 14.104.
6. **`sendAs` / Move `delivery` / band membership throws** (selection-typo cluster,
   2026-08-14/15) — re-resolved by the §5 sweep: affirmative dispatch with empty
   defaults, editor as the protector, `msg` trusted (§0). The one live remnant is the
   fan-out mode lesson, kept in 14.113. The "mavlink-build band twin not yet fixed" flag
   is obsolete — under current doctrine it is not a defect (`msg.band` is trusted;
   `config.band` is editor-owned).
7. **Strict `parseSysidList` on every tier** (two-parsers entry, 2026-08-08) — reversed:
   one parser, deliberately coercing, per trusted-author (14.113). The lesson that an
   undocumented strict/lenient *pair* is a coin toss stands on its own.
8. **The mission item validator** — the #90 numeric window was wrong, its
   family-reservation replacement has since been removed with the rest of runtime
   mission validation; the vehicle judges (14.91). The uint16-truncation defense of
   `lib/mission/validate.js` went with the file.
9. **"Move keeps the superseded `*_INT` frames (5/6/11 only)" and "`time_boot_ms` 0
   stays"** — the surface now speaks 0/3 and encodes 5/6 (terrain dropped);
   `time_boot_ms` is a real boot-clock stamp (14.96).
10. **The example-13 "AP might be bytewise / REAL32-typed set garbage-stores" reading** —
    refuted by the 2026-08-18 wire capture: AP is c-cast, stores by its own table type,
    ignores the wire type (14.80/14.84).
11. **"Both firmwares answer a Move reposition the same way" (2026-08-11)** — confounded
    run; replaced by the measured CHANGE_MODE gate (14.108).
12. **The "SITL 02 green does not yet confirm the vehicle-judges fence path" caveat** —
    #287's world is the current tree; the caveat described the transition, not a fact.
13. **The bytewise "INT16 / denormal echo" claim** — did not reproduce (14.80).
14. **`missingConnectionGate` / `positionAxisValidator` / `lib/move/frames.js` pointers**
    — renamed or absorbed (`applyConnectionStatus`, `steerAxisValidator`,
    `lib/move/action.js`); pointers updated in place above.
15. **Stale param-document counts** (5719/3617/6827…) — superseded by the current seed;
    updated in 14.22.
16. **"CI invokes the scorecard"** — no workflow does; the isolated `npm exec` posture
    survives as the `validate:node-red` script (14.2).
