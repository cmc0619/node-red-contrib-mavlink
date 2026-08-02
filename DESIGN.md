# MAVLink for Node-RED — Build Specification

A toolkit, not an application. The same node set is the bones of a ground control station or
of an onboard companion controller, and every tool either role needs is in the package.

---

## 1. Scope

Node-RED as a MAVLink participant — not a viewer of the conversation, a station in it, with
its own address, sending traffic vehicles act on.

**Two roles, one toolkit.**

- As a **GCS**: operator-facing, one connection carrying one vehicle or a hundred, commands and
  missions outbound, telemetry and state inbound.
- As a **companion**: onboard, sharing the vehicle's sysid with its own component ID,
  originating telemetry as well as consuming it, reacting to vehicle state locally.

Neither role is a subset of the other and neither is bolted on afterward. If a capability one
role needs is missing, the package is incomplete.

- Firmware: PX4, ArduPilot, and custom dialects.
- Transmit is **MAVLink v2 only**. v1 frames decode inbound for free; nothing emits v1, and
  there is no version negotiation or downgrade. Deliberate — do not "fix" it.
- Signing is supported on v2 and is **optional** — off by default, enabled per connection.

Not a flight controller. The autopilot flies; this orchestrates. Anything streaming setpoints
carries explicit freshness and stop behavior.

## 2. Code principles

**Shared logic lives in `lib/`, not in nodes.** Any behaviour that applies in more than one
place is a module with a single owner. Nodes stay thin: read config, call a library function,
shape the output. The field codec (§5) and the metadata service (§4) are the two largest
instances of this rule, not exceptions to it.

**One implementation per concept.** One conversion path between JavaScript values and MAVLink
bytes. One metadata service feeding both editor and runtime. One peer table per connection. If
a second implementation appears, one of them is wrong — delete it rather than keep two in sync.

**Defer to `node-mavlink`.** Framing, encode and decode, CRC, splitting, signing primitives.
Custom wire-layer code must justify its existence against the library, and "the library already
does this" is grounds for deletion.

**JSDoc, not line comments.** Exported functions, public runtime methods, config and message
schemas, state machines, and anything safety-relevant carry JSDoc stating purpose, units,
ranges, side effects, and error behaviour. Line comments are for a short inline *why*. No
boilerplate on trivial one-liners.

**Perfect-world programming.** Node-RED is an interpreter model: flows are checked at deploy,
and a runtime error in one node is caught, surfaced, and contained by the platform. Write for
the world where everything holds — the happy path *is* the code — and let a violated assumption
error gracefully upward, exposing the logic error instead of absorbing it. The goal is a
codebase that is small, right, and readable, and those three arrive together: every try/catch,
null-check, and fallback that isn't earning its place makes the code longer, hides which
assumptions actually matter, and gives a real logic error somewhere to disappear into.

Concretely: no try/catch around synchronous code — a throw is the platform's to route, and it
arrives with a stack trace pointing at the logic error. No fallback values that let execution
continue past a broken assumption; wrong-and-loud beats wrong-and-plausible. Error handling
exists in exactly two places — the boundary, where arbitrary input is rejected with a reason,
and async sources, where an unhandled failure is fatal to the runtime (below). Everything
between those two runs clean.

The principles that follow are this posture applied to specific inputs.

**Guard the boundary, not the interior.** Two rules that sound opposed and are not — they
concern different inputs.

*Validate what arrives over a socket.* Wire bytes are the only genuinely arbitrary input — a
malformed frame, a truncated payload, a hostile packet. Rejecting those cleanly is the job.

*A `msg` is not outside.* It came from a node the flow author wired up. No schema check, no
shape guard, no "is this an object," and nothing gets range-checked merely because it arrived
over a wire rather than being typed into a dialog. Encoding correctness is a separate concern and
belongs to the conversion module, not here.

*Dialect XML is the authority, not an input.* It defines what correct means; validating its
content is incoherent. What remains is a compiler either producing a bundle or reporting that it
could not — the file is not XML, an include is missing, the graph has a cycle (§4). That is a
compiler failing, not a guard.

*Trust everything that came from the deploy.* A referenced config node exists at runtime by
assumption. Do not null-check it, do not write a fallback for its absence, do not wrap it in
try/catch "just in case." A flow referencing a deleted Vehicle Profile is a broken build, and if
it somehow runs, the crash is the correct and most useful signal. A polished error message there
converts an obvious build error into a runtime mystery.

"Fail closed" describes *how to reject bad input* — safely, loudly, with a reason. It is not a
licence to add checks everywhere. Defensive code written for situations that cannot occur is
noise, and noise is where real bugs hide.

**Node-RED already provides two layers you would otherwise rebuild.**

*Configuration is graphical and validated before it runs.* Node properties declare their own
validation in the editor, a bad node is flagged visually, and the operator sees it while
building rather than discovering it at runtime. That is where config guarding belongs —
declaratively, in the node definition — not as runtime checks re-asking questions the editor has
already answered.

*A bad node does not take down the application.* Node-RED is a supervising runtime. Throw
synchronously inside an input handler and it is caught, routed to Catch nodes and the debug
pane, and every other flow keeps running. This is why "let it crash" is a reasonable position
here and would not be in a bare Node process: the blast radius is one message in one node.

**The platform ruleset.** This is Node-RED node code, not Node.js application code. For each of
these jobs the platform ships the mechanism (nodered.org/docs/creating-nodes); using it is the
whole implementation, and building a parallel one is a spec violation — however few lines it
costs. *Small is not a justification: the question is never how many lines a second mechanism
adds, it is that a second mechanism now exists.* The runtime-side counterpart — trust
editor-validated configuration, guard only real runtime boundaries — is the configuration-trust
ruleset in `AGENTS.md`. Rigor is relocated, not abandoned: pedantry belongs in the test suite,
the lint gate, and the CI pipeline — pinned byte vectors, cross-validation against generated
ground truth, drift asserts — never as defensive branches in the shipping code.

| Job | The platform mechanism — and nothing else |
|---|---|
| "this field must be set / valid" | `required` / `validate` on the property definition. The editor reds the field and puts the missing-config marker on the node. No bespoke pending states, placeholder options, or hint rows for unconfigured fields |
| dialog fields load and save | `node-input-<prop>` / `node-config-input-<prop>` ids auto-populate and auto-save. `oneditprepare`/`oneditsave` exist only for what that cannot do: dynamically built selects, TypedInput, reshaping. `oneditsave` runs before Node-RED copies those form values onto the node, so reshaping must update the editor fields rather than only mutating `this.<prop>` |
| dialog layout and widgets | `form-row` rows, `red-ui-button`, `TypedInput`, `RED.editor.createEditor` — no custom widget where a stock one exists |
| runtime state in the editor | `node.status({fill, shape, text})` — text under 20 characters, `{}` clears |
| errors while handling a message | **one** Catch path: `done(err)` when `done` is present; `node.error(err, msg)` only if there is no `done`. Never `node.error` then bare `done()` — that is the wrong pairing (Catch via error, message finished as success). Do not leave throws uncaught from the handler; catch and call `done(err)`. (§2 notes that a slipped throw is contained by Node-RED — that is a safety net, not the preferred path.) |
| replying in a flow | reuse the received `msg` object; send via the listener-provided `send` |
| cleanup on redeploy | the `close` handler (accepting `done` when async) |
| help text | `data-help-name` with `<h3>` sections and `message-properties` definition lists |
| node design | one well-defined purpose per node; forgiving in accepted input types, consistent and documented in what it sends |

**The exception, and it is the only one that matters:** Node-RED does *not* contain asynchronous
failures. An unhandled promise rejection, or an `error` event on a socket with no listener, kills
the runtime and takes every unrelated flow with it. So the discipline goes there and nowhere
else — every socket, stream, and promise chain gets an error handler, attached at creation and
still attached through teardown. Effort spent null-checking a config reference is effort not
spent on the one failure mode that is actually fatal.

**Check, do not recall.** Facts about the dialect XML, the installed libraries, and the MAVLink
specification are cheap to verify and expensive to get wrong. §14 records the ones already
measured, each paired with the plausible wrong belief it displaces.

**Unknown failures are acceptable. Invisible ones are not.**

Do not write handling for a failure mode nobody has observed. The bar for adding a guard is that
the condition has actually happened, or that it arrives from outside the boundary — where
arbitrary input is certain by definition. Everything else waits for a bug report. A USB serial
port vanishing on autopilot reboot, a transport that stops reconnecting, a peer that behaves
unlike any firmware in the test matrix: these get handled when someone reports them, not in
advance on the strength of an argument that they might.

The trade only holds if failures are legible. An unhandled condition must produce a loud,
locatable failure — a real stack trace, a node status that changes, an error naming what was
being attempted. A guard that is skipped costs nothing; diagnostics that are skipped cost the
bug report.

So a plausible suggestion to add a null check, a retry, or a fallback for something nobody has
seen is **declined**, and declining it is the finished outcome rather than a deferred task. This
applies with particular force to automated review: several bots flagging the same line is one
heuristic repeated, not independent confirmation, and none of them know which states this design
makes unreachable.

## 3. Nodes

**Config nodes**

| Type | Answers |
|---|---|
| `mavlink-local-identity` | Who is Node-RED on the wire? Owns source sysid and compid, the role preset, heartbeat content and interval, and the signing credential reference |
| `mavlink-vehicle` | Who is being addressed, in what dialect? Owns the **dialect library** pickers (dialect name + version: Seed or a catalog date) and the catalog refresh/compare actions |
| `mavlink-connection` | How does traffic move, and stay channel-correct? Owns the transport (UDP, TCP, serial), the peer table, its bound Vehicle Profile, the outbound queue and its bands, signing switches and channel state, the default identity plus opt-in additional ones, and the disable switch. Palette nodes reach the runtime through `node.subscribe`, `node.send`, `node.peerTable`, and `node.vehicle` — a frozen snapshot `{id, targetSysid, targetCompid, firmware, dialect, autopilot}` that palette nodes use to inherit the profile's target defaults; explicit node config wins, empty editor fields mean inherit. `id` is the profile node id: anything needing the compiled bundle resolves that node and calls `getDialect()` — never a bundled-registry lookup by name, which breaks custom XML dialects |

**Palette nodes**

| Type | Purpose |
|---|---|
| `mavlink-in` | Subscribe to decoded traffic. Filter by message, sysid, compid; changed-only; rate limit keyed on the *(message, sysid, compid)* tuple |
| `mavlink-out` | Transmit content not constructed by an action node — raw buffers, messages forwarded from another connection, envelopes built in a Function node |
| `mavlink-build` | Any message in the loaded dialect. Full Delivery tiers, plus an optional repeat interval that reports achieved rate against configured rate in status |
| `mavlink-command` | `MAV_CMD`, grouped presets through to the full dialect |
| `mavlink-move` | `SET_POSITION_TARGET_*`, streamed, with TTL and stop |
| `mavlink-mission` | download / upload / clear × mission / fence / rally |
| `mavlink-param` | read one, set one, request list |
| `mavlink-payload` | camera, gimbal, servo, release |
| `mavlink-state` | peer table reads, transitions, snapshots |
| `mavlink-swarm` | group fan-out with aggregation |

**Dependencies.** `node-mavlink` for framing/CRC/signing primitives, a shipped MAVLink XML
seed (`seed/mavlink`) for dialect definitions, an XML parser, and `serialport` as an
**optional** dependency lazy-loaded only
when a serial connection is used. UDP and TCP installs must load and pass tests without it;
selecting serial when it is absent gives a clear error, not a native module stack trace.

Both npm packages are already the ArduPilot line — install nothing else (§14).


## 4. Metadata — seeded XML is the dialect authority

**Ship a pinned MAVLink seed blob.** Dialect definitions come from upstream
`mavlink/mavlink` `message_definitions/v1.0` (MIT — see https://mavlink.io/en/#license),
not from `mavlink-mappings`. `scripts/generate-seed.js` pins a commit, walks `<include>`
for each selectable root, and writes a **single** gzipped JSON file named with the stamp —
`seed/mavlink-YYYY-MM-DD-<shortsha>.seed.gz` — plus `seed/active.json` pointing at it
(NOTICE + manifest + every precompiled {@link DialectBundle}). Runtime resolves the
pointer and gunzips once into memory. A weekly GitHub Action refreshes the blob and
opens a PR when upstream moves. Catalog updates still overlay newer XML under the
Node-RED userDir when internet is available.

**One bundle shape.** Seeded dialects and catalog downloads compile to the same
{@link DialectBundle}. Field `enum=`, command-param enums, descriptions, and the real
include chain come from the XML — no `.d.ts` recovery and no hand-maintained
`DIALECT_CHAINS` table.

**Dialect library (editor).** Pick a dialect name, then a version: **Seed** (the shipped
blob) or a **downloaded catalog date**. There is **no** free-text XML path mode and **no**
per-profile file-upload control in the Vehicle dialog. Official (and fork) XML enters the
library via catalog update under the Node-RED userDir; once it is there it is only a
pulldown entry. Configuration updates happen on a bench with internet; the seed covers the
boat.

**Legacy custom path.** Old flows that still persist `dialectSource: custom` +
`customDialectPath` keep compiling at runtime. The editor surfaces them as Version =
"Custom path (legacy)" until the user picks Seed or a catalog date (which clears the path).
Do not treat that escape as a supported way to add new dialects.

**Private / vendor dialects (deferred).** Ingesting a private include chain that is not in
any catalog snapshot is future work. When it lands it must join the same library shape
(compile once into a {@link DialectBundle}, then a pulldown entry) — not resurrect a
path field. Until then, vendor XML is out of scope for the editor.

**Remote fetch / catalog.** The XML catalog downloads a pinned commit (source selectable:
`mavlink/mavlink` or `ArduPilot/mavlink`), follows includes, timestamps the snapshot, and
can replace or diff against the seed.

Fail loud on compile: missing include, cyclic include, msgid collision between two files
defining different messages. Redefinition of the same message is an override, resolved by
include order, and shown as a diff against the same-named seeded dialect.

Never assume a dialect includes `common.xml`. Some define their own base set — measured:
upstream `icarous.xml` has no `<include>`, so the seeded bundle is `['icarous.xml']` alone.

**Wire classes.** Message classes are synthesized from the bundle for every dialect
(including seeded ones). `node-mavlink` remains for framing, CRC, splitter/parser, and
signing HMAC — not for dialect registries.

### Parameter definitions are a second, separate source

Dialect XML describes *messages and commands*. It says nothing about the thousands of
**vehicle parameters** a Param node reads and writes — their descriptions, units, ranges,
increments, and enumerated values live in firmware-specific files that are not MAVLink at all.
Without them the Param node is a raw name-and-number box, which contradicts every rule in §6 on
the node where users face the most opaque data in the system.

- **ArduPilot** publishes per-vehicle definitions at a stable URL —
  `https://autotest.ardupilot.org/Parameters/<Vehicle>/apm.pdef.json`, with an XML form
  alongside. Vehicle directory follows the frame type: `ArduCopter`, `ArduPlane`, `Rover`, `Sub`.
- **PX4** has no equivalent stable public URL. The editor supplies one — a release asset, a
  self-hosted copy, or a version pin — and the value dropdowns populate once it is given. Ship no
  baked-in default that will rot.

Parameters are firmware- *and version*-specific, so a definition set is bound to a Vehicle
Profile, not global. Cache by source URL with the fetch recorded, exactly as dialect XML is
(above). A profile with no definition set still reads and writes parameters — it just does it
without labels, and the node says so rather than pretending.

## 5. The field codec

A standalone library, not a layer buried in the package. It converts between JavaScript values
and MAVLink field values, driven by compiled dialect metadata, and it is where the expensive
bugs live.

**Why it needs a name.** MAVLink fields have exact widths — 8 bits unsigned here, a 32-bit float
there, a 64-bit integer next to it — and those bytes go on the wire literally. JavaScript has one
number type, a 64-bit float, no unsigned anything, and bitwise operators that silently coerce to
*signed* 32-bit. Something must translate.

**What the library already gives you.** `node-mavlink`'s serializers are one-line pass-throughs
to Node's `Buffer.write*`, so type-width fit checking is free and loud: `writeUInt8(300)`,
`writeUInt8(-1)`, `writeUInt32LE(1 << 31)` and a Number handed to `writeBigUInt64LE` all throw
`ERR_OUT_OF_RANGE`. Do not re-implement that.

**What silently produces wrong bytes.** `writeUInt8(undefined)` and `writeUInt8(null)` write `0`
with no error. `writeFloatLE('abc')` writes NaN with no error — and in a field where NaN means
*keep current*, that silently commands the opposite of the intent. These are the failures worth
building a module around, and none of them are catchable without knowing what the field means.

**Scope in, scope out.**

| In | Out |
|---|---|
| compiled dialect metadata, passed as an argument | the XML compiler — that stays behind (§4) |
| field conversion, both directions | transports, sockets, framing |
| integer fit checking per declared width | anything Node-RED — no RED object, ever |
| `NaN` and sentinel semantics per field | `node-mavlink` itself — see below |
| bitmask assembly | |
| `char[]` as Latin-1, padded or truncated to declared length | |
| 64-bit integers as decimal strings | |
| parameter int/float union reinterpretation | |

It does not import `node-mavlink` — a constraint accepted rather than a benefit claimed. Staying
out means duplicating a little knowledge of what the serializers expect; going in would tie a
reusable library to one consumer's dependency and drag framing into its tests. The trade is worth
it only because the output shapes are stable and few.

**Rules.**

- **Never coerce a missing or non-numeric value.** `undefined`, `null`, `''` and non-numeric
  strings are errors naming the field. Left alone they reach `Buffer` and become `0` or NaN with
  no complaint, which is the one class of wrong byte nothing downstream can detect.
- **Report, never wrap.** Where a declared `minValue`/`maxValue` is narrower than the type width,
  a value outside it is an error.
- **No bitwise operators anywhere in this library.** Masks are built by summing powers of two —
  `mask + 2 ** bit` to set, `Math.floor(mask / 2 ** bit) % 2 === 1` to test. Bit 31 then comes out
  as 2147483648: positive, exact, and accepted by `writeUInt32LE`. `1 << 31` is negative in
  JavaScript and MAVLink mode and type masks routinely set bit 31, so the operator is simply
  removed rather than corrected after the fact. Nothing then needs `>>> 0`, since `readUInt32LE`
  already returns unsigned.
- **`uint64` masks use BigInt.** Exact integer arithmetic holds only to 2^53, which covers every
  32-bit mask and no 64-bit one. BigInt shifts are safe — it has no 32-bit coercion — and the
  value leaves as a decimal string regardless.
- **No bitwise-math dependency.** `bitset`, `bitwise`, `bitfield` and the pre-BigInt `long` family
  all exist and none are needed. Arithmetic plus BigInt covers every case here.
- **Blank, zero, and absent are three states.** A blank active field is an error; an explicit `0`
  passes through untouched; an absent field is left absent rather than zero-filled. No carve-outs:
  a sentinel (`INT32_MAX` "unknown", `INT32_MIN` "at infinity") is an ordinary integer the
  operator enters as the label says — the raw surface never guesses one from a blank.
- **`NaN` survives losslessly on every float.** Never through `JSON.stringify`. It means "keep
  current" only in the fields whose metadata declares `invalid="NaN"`; elsewhere it is simply
  invalid.
- **Floats are not range-checked.** A float field takes what it is given and the vehicle clamps
  or rejects. Only integers need fit checking, and only because they cannot be encoded without it.

**Nodes contain none of this.** No shifts, no `parseInt`, no sign handling, no mask arithmetic.
One module, one place to get right, one place to test — and correctness is proven in CI rather
than by guards scattered through the palette.

**Tests are the deliverable, not an afterthought.** Round-trips across every field type, compared
NaN-aware and at float32 precision rather than with `===`, **plus** pinned canonical payload
bytes. A round trip alone blesses a symmetric codec bug: encode and decode can be wrong in the
same direction and remain perfect inverses, passing every round-trip test while emitting bytes no
other MAVLink implementation accepts. Compare payloads, not whole frames — sequence, signature
and timestamp legitimately vary, and a failing frame comparison gets "fixed" by loosening the
assertion.

**Build it extractable before extracting it.** Its own directory, tests, and README from the
start, with a hard rule against importing anything above it. Publishing later is a move and a
`package.json`, not a refactor.

## 6. UI rules

**Everything enumerable is a dropdown.** Messages, commands, enum-typed params, enum-typed
message fields, modes, frames, mission types, target components.

**Every enumerated entry shows its screaming name and numeric value:** `ENTRY_NAME (value)`.

```
MAV_CMD_COMPONENT_ARM_DISARM (400)
MAV_CMD_NAV_TAKEOFF (22)
MAV_TYPE_GCS (6)
MAV_COMP_ID_AUTOPILOT1 (1)
SPEED_TYPE_AIRSPEED (0)
```

**Fields are created and destroyed by selection.** Pick a command, the form becomes that
command's params. Pick a different one, the old fields are gone. Nothing greys out; nothing
lingers.

**No raw numbered param field appears anywhere.** Four cases, in order:

| Condition | Render |
|---|---|
| `reserved="true"` | hidden; send declared default (0 unless XML says otherwise) |
| description is `Empty` / `Empty.` / `Reserved` | hidden; send 0 — legacy form of reserved |
| has `label` | field labelled from `label` |
| no label, real description | field labelled from description |

Measured against `common.xml`: 171 commands, 947 non-reserved params. 279 of the 420
unlabelled params carry the legacy `Empty`/`Reserved` markers and hide under case 2. The
remainder have real descriptions and render under case 4. There is no fifth case, so no
fallback grid is needed.

**`COMMAND_LONG` and `COMMAND_INT` are the exception that proves the rule.** Their message
schema really does declare fields named `param1` through `param7`, generic floats marked
`invalid="NaN"`. Rendered literally, Build would produce the numbered grid this section forbids.
It does not, because the `command` field carries `enum="MAV_CMD"` — so the moment a command is
selected, Build hands off to the same command-param renderer the Command node uses and the
fields become that command's named params. One module, two consumers (§2).

**Control type follows the metadata.** `enum=` present → dropdown. Otherwise → number field
carrying `units`, `minValue`/`maxValue`, and `increment` as constraints. In `common.xml`: 527
params carry `label`, 171 carry a range, 166 carry units, 115 carry an increment, 85 carry an
enum reference. A param without `enum=` is a scalar — latitude, yaw, altitude, accept radius —
and a dropdown there would be wrong.

**Help lives in hover text and the help panel.** Descriptions ride as tooltips. Inline hints
are limited to units and range. The dialog stays compact. Tooltip *text* always comes from the
dialect registry / admin catalogs (enum entry, message, command, command-param, param-def, or
Payload field-tips join) — never from baked protocol copy in editor HTML. Structural joins
(which UI field maps to which `MAV_CMD` param index) are the shared `PAYLOAD_RECIPES` in
`lib/payload` — one recipe drives the wire builder, tip lookup, and inline units; hover text
is the XML `description`, and the trailing unit hint is the XML `units` attribute (never baked
into Payload HTML).

### Addressing and identity — the role × tier matrix

Action-node dialogs inherit traits and override them, object-style: the **identity role** is the
base class, the **delivery tier** is a mixin, node config overrides inherited values, and
`msg.payload` is the runtime override of last resort. Two facts anchor the whole table:

- **A Vehicle Profile is a class inbound and an address outbound.** Everything arriving on a
  connection decodes against the profile's dialect (§7), and several airframes of that class may
  share the wire. But every *outbound* message addresses one concrete sysid — the profile's
  target defaults are numbers, never blank, and a fleet operator sets explicit targets per node.
- **The identity role is the paradigm switch.** A `gcs` (or `custom`) identity talks *to*
  vehicles and must say which one. A `companion` identity is *on* an airframe: its source sysid
  is derived from that airframe, and its implied target is its own autopilot — same sysid,
  compid 1. A companion belongs to one airframe (enforced at bind, §7), so nothing needs asking.

**All reshaping is edit-dialog time.** Rows show and hide while the tray is open, exactly like
the Move mode reshape. Deploy freezes the shape. At runtime only `msg.payload` overrides
*values*; nothing changes shape. **Hidden is not honored:** a field hidden by the current
role/tier is ignored at runtime even if an earlier configuration saved a value into it — the
same rule the identity node already applies to role changes.

**By role** — driven by the identity selected *on the node*, never inferred from the connection
(sender nodes: Command, Move, Param, Payload, Mission):

| | `gcs` / `custom` | `companion` |
|---|---|---|
| Send-as (identity) | dropdown of identities bound to the selected connection; first eligible preselected and written into config | same dropdown (with one bound identity it is simply shown selected — "hardcoded") |
| Target sysid | shown; blank inherits the profile default | hidden — derived from the airframe (identity's own sysid) |
| Target compid | shown; blank inherits the profile default | hidden, pinned to 1 (the autopilot) — except Payload, whose compid addresses a payload device and stays visible |

**By tier** (same sender nodes — and the Build node shares the Build-column catalog pattern):

| Field | Build | wire tiers (Send / confirm / complete / collect / Stream) |
|---|---|---|
| Connection | hidden — nothing is sent; output 0 feeds `mavlink-out` or a Build-node trigger, which brings its own connection | shown, required |
| Dialect | shown — bundled dialect list plus a `from Vehicle Profile…` escape; required (empty is editor-invalid — no silent `ardupilotmega`) | hidden — the connection's profile dialect governs catalogs |
| Vehicle Profile | shown **only** when Dialect is `from Vehicle Profile…`; empty stays invalid until a profile is chosen (no auto-pick) | hidden — the profile arrives via the connection |
| Send-as (identity) | hidden — source ids are stamped at the wire by whichever node eventually sends | per role table |
| Target sysid/compid | shown — a builder must stamp targets | per role table |
| Firmware (Param, Mission) | shown and required when Build is **not** using Vehicle Profile; hidden (inherited from the profile) when it is | no dropdown — inherited from the connection's profile |
| Timeout / retries / band | hidden | shown |

Command, Move, Payload, and the Build node do not show Firmware on Build — they only need the
dialect for catalogs. Param and Mission need firmware for encoding / defs / mission-type gating,
so on Build they take **Vehicle Profile** *or* **(Dialect and Firmware)**.

**Runtime target resolution**, one order everywhere, per field (sysid and compid resolve
independently; a configured 0 is broadcast and survives; blank means inherit):

1. `msg.payload.target`
2. companion send-as identity → derived `{airframe sysid, 1}` (node config target ignored —
   hidden is not honored; Payload's compid still resolves from its visible field)
3. node config target
4. profile default — the connection's bound profile on wire tiers; on Build, only when Dialect
   is `from Vehicle Profile…` (the selected profile's target defaults). A concrete bundled
   dialect on Build has no profile rung — blank stays unresolved.

There is no fifth “hardcoded 1” rung and no silent dialect default. Companion's compid `1` is
the derived autopilot address, not a global null-guard.

`lib/addressing` owns one resolution path (`resolveActionTarget`). Builders take that
resolved `{sysid, compid}` as-is. Sysid/compid ranges are editor-only
(`RED.mavlink.validateUint8`). Flow `msg` and deployed config are trusted at runtime.

Confirm/complete matching (COMMAND_ACK, param echo) keys on the *same resolved target* — the
matcher and the sender share one resolution, pinned by test.

**Enum controls in builders.** Bitmask-marked enums use the native multi-select (ctrl-click)
unless the enum is an exact binary false/true pair — exactly two members, `*_FALSE` (or
`FALSE`) with value `0` and `*_TRUE` (or `TRUE`) with value `1` (e.g. `MAV_BOOL`). Those render
as true/false using the declared wire values. Mixed tables such as
`GIMBAL_AXIS_CALIBRATION_REQUIRED` (UNKNOWN / TRUE / FALSE=2) stay ordinary selects. Upstream
`bitmask` marks and value-shape heuristics do not reliably tell additive masks from exclusive
or mixed enums; keep multi-select and caveat emptor outside that binary exception.

**Exceptions, deliberate:**

- **Build node** — raw builds for the whole dialect. Same Build-column Dialect /
  `from Vehicle Profile…` pattern as the senders; no connection or identity on Build. On wire
  tiers the connection's profile governs the catalogs, because that dialect is what the wire
  will encode.
- **Swarm** — gcs-paradigm by nature. Its send-as dropdown offers only gcs-enabled identities
  (`gcs` or `custom`, first one preselected); selection modes replace the single-target rows.
  Build tier with `all`/`filter` selection still shows the connection — the live peer table is
  the only place those selections can resolve. Build + explicit `list` needs no connection; when
  it loads a MAV_CMD/enum catalog without a governing connection profile, it uses the same
  Dialect / `from Vehicle Profile…` rules (no silent `ardupilotmega`).
- **In and State** — read side. Their sysid/compid fields are *filters* where blank means
  everything; no target semantics, no reshape.
- **Out** — fully message-driven; nothing to reshape.

### Node status

The badge is the first thing anyone reads, and there are two vocabularies because there are two
kinds of node. Do not mix them.

**Config nodes report a state machine** — a persistent condition, true until it changes.

| State | Badge |
|---|---|
| connected, listening | green dot |
| connecting, reconnecting | yellow ring |
| idle, closed, disabled | grey ring |
| error, invalid | red ring |
| unrecognised | grey ring |

**Action nodes report last activity** — the most recent thing that happened, not a condition.

| Situation | Badge |
|---|---|
| transaction open | blue dot, text ending in an ellipsis (`sending ARM…`) |
| completed | green dot naming what completed (`ARM accepted`) |
| dry run or preview | yellow dot with a count |
| failed | red ring |
| misconfigured at deploy | red ring, `invalid config` |

The last row is the one exception: an action node shows a *state* before any message has arrived,
because a node that cannot possibly work should say so without being triggered first.

Shape carries meaning independently of colour — **ring is not-running or not-ok, dot is active or
settled-good** — so the badge is still readable to anyone who cannot separate red from green.

Two hard rules:

- **Status is a badge, never a wire message.** Anything a flow needs to act on goes out output 1.
- **Cap badge text at 24 characters** with a single-glyph ellipsis, applied to anything carrying
  dialect or user data — message names, command names, param ids. Uncapped text truncates
  mid-glyph in the editor.

### Editor endpoints

Dropdowns are populated by admin HTTP routes the config nodes register. The routes themselves are
ordinary; five constraints are not, and each is the part a builder skips:

- Register with `RED.auth.needsPermission` — the admin API can configure live vehicle control.
- Treat every path segment as hostile: a dialect or profile name resolves against a known list,
  never into a filesystem path.
- Error responses name the problem, not the machine — no filesystem paths, no stack traces.
- Serve compiled bundles from cache. A keystroke must not recompile a dialect.
- Compile off the event loop. A blocked loop stalls every flow, not just the editor (§2).

**Saved values survive async metadata loads.** A late-arriving dropdown population merges into
persisted config; it never overwrites a valid saved selection with empty. Derived UI state —
validity badges, availability — recomputes on every redeploy, not only first load. For
`<select>` fields filled after `oneditprepare`, that means: (1) seed the saved value into the
control before the function returns so Node-RED's immediate post-prepare validation sees it,
and (2) `$select.trigger('change')` after the async fill so a pre-fill `input-error` clears
through the stock change→validate path (never a parallel validation API).

**Editor helpers are shared, not pasted.** The `RED.mavlink.*` browser helpers — config-node
pickers, enum/dialect catalog fills, `currentCatalogQuery`, `validateUint8`, the catalog source
matrix `resolveCatalogTarget`, the shared catalog fetch `loadCatalog(endpoint, cache)`, Target
CompID reload `reloadTargetCompId`, identity refresh `refreshIdentitySelect`, select title-sync /
missing-option helpers (`bindSelectTitleSync`, `ensureSavedEnumOption`), `enumOptionLabel`
(§6 `NAME (value)`; Node twin in `lib/metadata/commands-list.js`), queue-band picker
`BAND_OPTIONS` / `fillBandSelect`, companion target-row visibility
`applyCompanionTargetVisibility`, the payload verb catalog (`PAYLOAD_VERBS` /
`refreshVerbOptions`), bitmask select helpers (`bitmaskTitle`, `booleanEntryLabel`,
`selectedBitmaskValues`), the Build-tier dialect/vehicle/firmware default descriptors
`buildTierDialectDefaults`, and the Build-tier row toggle
`applyBuildTierRowVisibility` — live once in `resources/mavlink-editor.js`, loaded via the stock
resource mechanism (a relative `<script src>` in the first-listed node). Node-RED guarantees that
file runs before any inline `registerType`, so nodes call the shared helpers rather than copying
them (§14 records the load-order fact and the picker API).

**Runtime helpers are shared, not pasted.** Palette `nodes/*.js` call `lib/delivery`
(`capBadge`, `makeStatusRecord`, `applyActionStatus`, `shouldSuppress`), `lib/addressing`
(`firstDefined`, `resolveActionTarget`, `resolveDeliveryContext`, `missingConnectionGate`,
`dialectFromVehicleId` / `dialectFromConnection`), `lib/command` (`mergeParams`,
`DEFAULT_TIMEOUT_MS` / `DEFAULT_MAX_RETRIES`), `lib/connection/bands` (`BAND.*`),
`lib/move` config mappers (`positionFrom` / `velocityFrom` / `valueFrom`), and
`lib/metadata/admin-catalog` (`loadMetadata`, `registerDialectCatalogRoute`,
`resolveCatalogSource`), `lib/connection/endpoint-key` + `clone.deepCopy`,
`lib/metadata/xml-catalog.extractIncludes`, `lib/command/lookup.commandByValue`,
catalog `nameValueLabel` / `mapEnumEntries`, and param `PARAM_TYPE` derived from
codec `PARAM_TYPES` — rather than re-declaring `BADGE_MAX = 24`, hand-slicing badge
text, pasting the vehicle/dialect catalog route skeleton, or copying role×tier
resolution between action nodes. Command's editor target fields are the canonical
`targetSystem` / `targetComponent` only (pre-1.0: no leftover-key readers) (§14).

## 7. Config nodes

| Node | Owns |
|---|---|
| **Local Identity** | source sysid/compid, role, heartbeat content and interval, signing policy |
| **Vehicle Profile** | target defaults, dialect, firmware, vehicle family, mode and param metadata |
| **Connection** | transport, peer table, bound Vehicle Profile, queue, subscriptions, signing link ID, sequence and replay state |

Identity is separate from target so that **selecting a different vehicle cannot silently change
who Node-RED transmits as.** A combined object makes that error representable; three objects do
not. It also allows one link carrying several identities — a GCS and a companion on the same
radio — and one identity across several links with different signing. Both are normal MAVLink
and both are inexpressible in a merged object.

**Signing is optional and off by default.** Three switches per connection. **Sign outbound** and
**require signed inbound** are independent — all four combinations are legal, including
require-on with sign-off: a listen-only companion wanting authentic telemetry without
transmitting anything. The third, **accept invalid signatures**, is a recovery override detailed
below and orthogonal to both. A connection with everything off behaves exactly as if signing did
not exist, and that is the normal case.

| Frame | Behavior |
|---|---|
| valid signature | accept, subject to the timestamp rules below |
| invalid signature | reject, unless *accept invalid signatures* is on |
| no signature | accept, unless *require signed* is on |

**Accept invalid signatures** is off by default and exists for one purpose the spec names:
recovering a vehicle whose key is corrupted, where seeing its position matters more than
trusting it. When on, node status must show the connection as untrusted conspicuously, such
packets never advance the timestamp store, and they are advisory only — they must never drive
control.

**v1 needs no special rule.** A v1 frame carries no signature block and arrives identical to an
unsigned v2 frame, so it lands in the third row automatically. There is no v1 branch to write.

When *require signed* is on, a narrow allowlist of message types may be accepted unsigned.
`RADIO_STATUS` is the case the spec names — SiK radios inject it and cannot sign, so requiring
signatures otherwise kills link-quality data silently. Everything on that list is
unauthenticated and must never drive control.

### Timestamps and replay

The spec defines this; implement it rather than inventing a scheme. The timestamp is 48 bits in
10 µs units since 1 January 2015 GMT — offset 1420070400 seconds from the Unix epoch. A logical
stream is the tuple **(system ID, component ID, link ID)**, and every rule below is per stream.

*Outbound.* Strictly increasing, at least +1 per message on that stream. On start, use the
greater of the system-clock-derived timestamp and any stored value. A Node-RED host normally has
an NTP-disciplined clock, so the clock alone keeps timestamps monotonic across restarts and
persistence is optional; a host with no RTC needs the stored value. If persisting, keep two
values, write the smaller and read the larger — that is the spec's race guard.

*Inbound.* Discard a signed packet when any of these hold:

1. the computed signature does not match;
2. the timestamp is not greater than the last accepted timestamp for that stream;
3. the timestamp is more than 6,000,000 units — one minute — behind local time.

*First contact.* With no prior record for a stream, accept if the timestamp is not more than one
minute behind local time. That is the bootstrap case, and without it no new peer is ever
accepted.

*On accept.* Advance the stored timestamp when the incoming one is greater. Never advance it
from a packet that failed verification, including one admitted by *accept invalid signatures* —
doing so would let a forged packet raise the floor and lock out the real peer.

Replay state is per connection, in memory, keyed by stream. It needs no persistence: after a
restart the one-minute window discards anything captured earlier, and the monotonic rule resumes
once a fresh packet re-establishes the floor.

Signing is a property of the link, so its state — link ID, outgoing sequence, replay memory —
belongs to the **Connection**, not the identity. Local Identity may reference a credential and
a policy; it never owns channel state. The library provides signing and verification
primitives only; accept/reject policy, the allowlist, and the timestamp store are ours. These
rules are binding:

- Passphrases and raw keys live in Node-RED encrypted credentials only. Never in exported flow
  JSON, never in logs, never echoed back to the editor.
- The key comes from exactly one of two credential fields: a **passphrase** (sha256 — Mission
  Planner's convention, which node-mavlink deliberately copies) or a **raw key** (64 hex chars =
  the 32 bytes both firmwares are provisioned with via `SETUP_SIGNING`, and the only way to match
  a fleet whose key is not a sha256-of-passphrase — QGC, for instance, derives via PBKDF2, which
  no passphrase entered here can reproduce). Both set at once is an ambiguous deploy and fails
  loud at construction; the connection never guesses which key wins.
- Sign-outbound enabled without a key source **fails the connection closed**. It does not
  quietly transmit unsigned.
- Two connections sharing a key still need **distinct link IDs**. Reusing one identity across
  connections must not share channel state.

**Role presets** keep the common path short. Ground station suggests 255/190 and a
`MAV_TYPE_GCS` heartbeat. Companion locks sysid to the vehicle's and offers component 191.
The identity dialog reshapes itself by role.

**One connection, one Vehicle Profile.** Everything arriving on a connection is decoded against
its profile — one dialect, one firmware, no per-packet lookup. There is no route table, no
accepted-sysid allowlist, and no policy for unmatched traffic, because none of those questions
arise.

**One stream decoder per TCP client / UDP endpoint.** MAVLink framing is a byte stream. A
Connection keeps one *serialize* registry, but each network peer (`address:port`) gets its own
`MavLinkPacketSplitter` pipeline. Sharing one splitter across peers lets a partial frame from
vehicle A contaminate the next bytes from vehicle B. TCP peer disconnect releases that
decoder; idle UDP pipelines are evicted on the peer-table expire interval (TCP/serial do
**not** age-evict — only `endpoint-gone` / Connection close). A TCP `endpoint-gone` fires
only while that socket still owns the `address:port` map slot — a delayed close after the
same tuple reconnects must not wipe the replacement stream's decoder (emit once on
supersede instead). A hard cap (default **100**)
evicts under pressure: never-validated junk (empty buffer or no MAVLink STX) first, then
validated pipelines whose splitter buffer is empty, then Map-order LRU among remaining
mid-frame entries — including a peer whose *first* frame is still incomplete (not yet
`validated`). Spoofed UDP source churn cannot grow memory without bound while a live peer
with a partial frame buffered is preferred. Steady per-drone endpoints reuse the same
tuple and stay under the cap. Serial is one endpoint and needs only one decoder.

A mixed fleet is expressed as **more connections**, not more configuration inside one. A listener
on 14550 bound to an ArduPilot profile and another on 14551 bound to a PX4 profile is the whole
mechanism; the operator points each vehicle at the port that matches it. Two profiles sharing a
firmware are unambiguous for the same reason — they are on different connections.

**HEARTBEAT verifies the binding rather than choosing it.** Every heartbeat declares its stack in
the `autopilot` field — `MAV_AUTOPILOT_ARDUPILOTMEGA` is 3, `MAV_AUTOPILOT_PX4` is 12 — and the
peer table already records it. When it contradicts the connection's profile, warn on the
connection and mark the peer entry. Detection never silently reassigns a profile: the remedy is
repointing the vehicle at the right port, so the whole job is telling the operator plainly that
they have not. Derived data checking declared configuration, not replacing it.

Connection carries a **disable switch**, since Node-RED cannot disable config nodes. Disabled
means no runtime is constructed at all: no dialing, listening, or timers.

**Teardown.** Node-RED calls `close(done)` on every redeploy, and skipping cleanup leaves two
live copies — the old socket holds the port, or old timers keep firing after redeploy.
Two traps beyond the obvious: release locks and stop timers on *every* exit path, including a
constructor that threw halfway; and never re-resolve a config reference inside `close` — record
what was bound at bind time and tear that down, because a lookup that throws synchronously in
`close` never calls `done` and hangs the deploy.

**Subscriptions.** In nodes subscribe to a Connection; the Connection delivers each decoded
message as a **copy per subscriber**, or one Function node mutating a payload corrupts what every
other subscriber sees. A subscription is unregistered in the subscriber's own `close`, or a
redeployed flow leaves the old node still receiving.

### Heartbeat

The spec is explicit: components **must** regularly broadcast HEARTBEAT and monitor for the
heartbeats of others. Both roles need one. A GCS heartbeats as `MAV_TYPE_GCS` with
`MAV_AUTOPILOT_INVALID` — the autopilot field is only meaningful for flight controllers. A
companion heartbeats as `MAV_TYPE_ONBOARD_CONTROLLER`, also `MAV_AUTOPILOT_INVALID`, sharing the
vehicle's system ID under its own component ID.

This is not a formality. The spec directs components to broadcast *even when not commanding
anything*, and ArduPilot's GCS failsafe fires on heartbeat loss — stop sending and the vehicle
reacts. Rate is not defined by MAVLink; 1 Hz with disconnection after four or five missed is the
normal RF convention. Local Identity owns the interval and defaults to `1000 ms`; the peer
table's stale threshold should mirror the inbound freshness expectation.

**Ownership splits.** Local Identity owns the *content and interval* — type, autopilot field,
system status, source IDs, and cadence. Connection provides the channel and send path; its
scheduler is an implementation detail driven by each bound identity's interval. An identity bound
to two connections heartbeats on both.

**A faulted component must not heartbeat.** The spec says so directly, and warns specifically
against publishing from a thread unaware of the rest of the component's state. So the emitter
reads health rather than running as a blind timer: a fatal condition stops the heartbeat and it
resumes when the condition clears, logged once at each transition. `MAV_STATE` reflects actual
state rather than a constant. A dead companion that keeps announcing itself is worse than one
that goes quiet, because silence is a signal every other participant already knows how to read.

### Queue bands

Every outbound message carries a band. Priority here is not importance — it is what happens if
the message is late.

| Band | Traffic | Late means | DSCP | Handling |
|---|---|---|---|---|
| 0 Emergency | flight termination, forced disarm (21196) | harm | EF (46) | never coalesced, never dropped, never delayed |
| 1 Liveness | HEARTBEAT | peer trips a failsafe | CS5 (40) | at most one outstanding per identity; never queue two |
| 2 Control | commands, mode, arm, mission start/pause, param set, payload actions | wrong action at the wrong time | AF41 (34) | ordered, not coalesced |
| 3 Streaming | setpoints, manual control, RC override | worthless | CS4 (32) | coalesce per (message, target); last value wins; drop stale rather than send late |
| 4 Bulk | mission and param transfers, FTP, periodic telemetry origination | slow | AF11 (10) | latency-tolerant, must not starve anything above |

Marks descend monotonically with the band, so a device that only compares the field still
orders correctly. **CS6 (48) and CS7 (56) are deliberately unused** — those are reserved for
network control, and marking application traffic into them either gets it remarked or competes
with the routing protocols keeping the link up.

**Ageing promotes, but clamps at band 2.** An aged bulk item must be able to make progress, or a
long param download starves behind steady control traffic. It must never reach Liveness or
Emergency — clamping *into* a band still wins on an age tie-break, so the ceiling sits one band
above Liveness, not at it.

**Every queue is bounded, and overflow behaviour differs by band.** Streaming drops the oldest,
which is free because the newest value supersedes it. Bulk rejects the newest with an error.
Control raises rather than silently discarding a user-initiated action. Emergency overflowing is
a fault condition, not a drop.

Coalescing keys always include the local identity, or two identities sharing a connection
collapse into each other's traffic.

### Scheduling is the driver's, not the kernel's

The OS socket buffer is FIFO with no notion of priority. Write everything into it and the band
scheme is defeated at the kernel boundary — an emergency command sits behind whatever mission
items were already handed down. So the driver keeps the socket buffer **shallow** and holds
depth in its own queue: dequeue by band, write one message, wait for the transport to accept it,
then dequeue again.

- UDP — send with a callback and treat that as the release, with a small send buffer.
- TCP — `write()` returns false past the high-water mark; wait for `drain`. Set the mark low.
- Serial — the same pattern against the port's drain.

Serial has no bands worth marking, but it has the same starvation problem and the same fix.

**DSCP marking, IP transports only.** Node exposes no traffic-class setter — `dgram` covers
broadcast, TTL, multicast and buffer sizes, `net.Socket` covers timeout, nodelay and keepalive,
and neither reaches `IP_TOS` or `IPV6_TCLASS`. Marking therefore needs a native `setsockopt`
binding, carried as an **optional dependency on the `serialport` pattern**: present, traffic is
marked; absent, the queue behaves identically and frames go out unmarked. A compiled module in
the base install would undo the clean UDP-and-TCP story for no safety gain.

Because bands differ per message on one socket, the mark is set immediately before each send.
That is only safe because the driver dequeues serially — with concurrent sends the mark would
race against the payload it was meant to describe. Driver-side scheduling is what makes
per-message marking possible at all.

**Where it pays.** On a managed LAN, and on WiFi, where 802.11e WMM maps the class selector to
an access category — Emergency and Liveness land in voice, Control and Streaming in video, Bulk
in background — which genuinely reorders frames on the air. Across the public internet marks are
routinely remarked or cleared, so treat DSCP as an optimisation on links you control, never as a
guarantee. Nothing in the band scheme may depend on the mark being honoured.

## 8. Peer table

Connection builds and owns it. Populated from HEARTBEAT, enriched from everything else.

**Keyed by sysid, with components nested underneath.** Not flat `(sysid, compid)` — a vehicle
is a system; its autopilot, gimbal, and companion are components of it. Flat keys turn "is the
copter armed" into a search.

| Source | Yields |
|---|---|
| `HEARTBEAT` | presence, type, autopilot, armed state, flight mode, system status |
| `AUTOPILOT_VERSION` | firmware version, capability flags |
| `SYS_STATUS` | sensor health, battery summary |
| `GPS_RAW_INT` | fix type, satellite count |
| `GLOBAL_POSITION_INT` | position, altitude, heading |
| `BATTERY_STATUS` | per-battery detail |
| `HOME_POSITION` | home |
| `STATUSTEXT` | recent messages |
| *transport* | the set of source endpoints this component has been seen on, each with its own last-seen, one marked primary |

**An endpoint is always address *and* port.** Ten SITL instances on one host share an IP and are
distinguished only by port; a bare address identifies nothing. Serial endpoints are the port
path.

The endpoint set is what makes targeted sending possible, but it is not a key. Several sysids
commonly arrive from one endpoint when a router or bridge forwards a fleet, and one sysid can
arrive from several endpoints — either a redundant link or two vehicles misconfigured to the
same ID.

**Do not try to tell those two apart automatically.** MAVLink has no cross-channel
deconfliction, and sequence numbers cannot supply it because each channel carries its own
counter. Surface the condition instead: a component seen on more than one endpoint is reported,
and the operator decides which case it is. Sending follows the **primary** endpoint, falling back
to another on non-transient failure — the spec's own recommendation — rather than alternating
between them. Transient OS errors (ICMP unreachable while a peer reboots, full socket buffers)
warn but keep the endpoint: one lost packet must not turn the best-known address into a
permanently forgotten one (issue #91); genuinely dead peers age out via the expiry sweep.

Emit an event when the primary changes. That is a link failover or a spoof, and both are worth
seeing.

**Freshness is per section, not per record.** A 1 Hz heartbeat must not make a two-minute-old
position look live. Timestamp heartbeat, position, battery, and GPS independently.

**Two thresholds.** *Stale* — missed N heartbeats, still listed, marked. *Expired* — dropped
from the table. Both emit events so a flow can react rather than poll.

The `mavlink-state` node reads this table: edge-triggered transitions, snapshots on interval or
on demand, and a live status-text feed.

## 9. The chain model

### Two outputs

Every action node has **output 0 = continue** and **output 1 = status**.

**Output 0 is a trigger, not a report.** It fires only when the step succeeded, and chaining is
node-to-node on it. Its payload still varies by tier — a built message in Build, a result in
Send — but its *meaning* never does, so a downstream node never has to inspect the payload to
know whether to proceed.

**On any other outcome it emits nothing at all.** Silence is the mechanism. Node-RED runs a node
whenever a message arrives and never inspects the payload, so emitting a failure result — even
one clearly flagged as a failure — would still trigger the next step. Not sending is what stops
the chain, and it is the only thing that does.

**Output 1 emits on every terminal outcome**, success included: succeeded, failed, unconfirmed,
timed out, rejected. It carries the full record — result code, how the outcome was confirmed,
target, elapsed time, retry count. This is the Debug wire, and it is always the same wire
regardless of what happened. Branching on failure is a `switch` on the result, which is cheaper
than the alternative of teeing successes out of port 0 to see them.

Failures report through **`done(err)`** when the input handler has a `done` callback
(`node.error(err, msg)` only if `done` is absent). Never `node.error` then bare `done()`.
That is independent of the ports.

Mission and Param conform: their progress updates are status records, not a separate port.
Status records are plain objects on output 1 (typically at message root: `msg.result`, …) —
there is no stamp, marker field, or miswire refusal.

### What triggers an action node

A node fires on message arrival, as everything in Node-RED does. Requiring a specific trigger
value would break the commonest flow there is — an inject node wired straight to a Command node,
whose default payload is a timestamp. One narrow exception:

- **`msg.payload === false` suppresses.** The node does nothing and emits nothing, which gives a
  `switch` upstream an explicit way to hold a chain without inventing a convention.

Do **not** refuse status records (or any other shape) as a special "miswire" class. Output 0
already does not fire on failure, so chaining on continue is what stops the flow; wiring
output 1 into another action is operator error, not something the runtime stamps and rejects.
Payload contents supply parameters where the node is configured to read them from the message,
and are ignored otherwise.

### Delivery tiers

A **Delivery** dropdown on every action node. The tiers offered are computed per command, not
fixed — a node only shows what its selected command can actually do.

| Tier | Output 0 carries | Offered when |
|---|---|---|
| **Build** | the constructed message, for inspection, modification, or fan-out before transmission | always |
| **Send** | fire-and-forget result | a connection is configured |
| **Send & confirm** | terminal acknowledgement | the message has an ack or an echo |
| **Send & await completion** | vehicle state satisfies the goal | the command has a completion condition |

**Send & confirm is the default tier** where a connection is configured and the message supports
confirmation, falling back to Send where it does not and to Build where no connection is set.
Confirm does what was asked and reports whether it worked, without blocking for an unbounded
period the operator did not choose. The operator changes it freely.

Build's output goes to `mavlink-out`.

Which config references and address fields a tier shows — and where blank targets inherit from —
is governed by the role × tier matrix (§6).

Move has no acknowledgement of any kind, so its third tier is **Stream** instead — sustained
setpoints with TTL and stop, no confirmation possible.

### Three kinds of confirmation

Not every message can be acknowledged, and the node must offer the right one:

| Node | Confirmation |
|---|---|
| Command | real `COMMAND_ACK` |
| Mission | `MISSION_ACK`, via the mission protocol |
| Param | none — confirm by matching the `PARAM_VALUE` the vehicle broadcasts back |
| Payload | per verb — command-backed verbs ack; `GIMBAL_MANAGER_SET_PITCHYAW` is a message with none |
| Move | none, ever — setpoints carry no acknowledgement |

Param is echo-confirm, not ack. Different mechanism, different failure mode, and it must not be
presented as the same checkbox.

**The echo is decoded by the vehicle's `param_type`, not the request's.** `PARAM_VALUE` carries
its own type, and `param_value` was encoded per *that* type — so it is the only type the reply
can be read with. The type the operator configured governs how the outbound `PARAM_SET` is
encoded and nothing more; a node set to `REAL32` against a vehicle whose parameter is an integer
still has to read the integer echo the vehicle sends. Preferring the request's type misreads the
bytes: bytewise, an integer `1` arrives as `1.4e-45` and never matches, so a set the vehicle
applied reports `echo timeout` (§14).

**Echo comparison tolerance follows the wire, not the type alone.** A value that passed through
a float32 — any `REAL32` parameter, or anything sent c-cast — comes back quantized, so `47.9`
echoes as `47.900001525878906` and an absolute epsilon rejects it; compare at float32 precision.
A bytewise *integer* echo carries the vehicle's exact bits, so it compares exactly — no epsilon,
no float32 rounding: above 2^24 consecutive integers collide under float32, and granting
tolerance there would confirm a stored value the operator never asked for. Both sides are
integers on that path (the codec rejects a non-integer value for an integer type at encode time,
so a set that reached the wire had one), and false success is the one outcome echo-confirm exists
to prevent.

**An echo whose type is unusable does not match.** If the frame's `param_type` is not a known
type and the request never named one, the bytes cannot be decoded and there is nothing to compare
— decline the match. Guessing `REAL32` would confirm a set from a frame whose type cannot be
trusted; a confirm that never fires is reported honestly as an echo timeout. A real vehicle
always populates `param_type`, so this is the malformed-frame path.

**`COMMAND_ACK` can arrive twice.** A takeoff commonly acks `IN_PROGRESS`, then `ACCEPTED`
seconds later. Treating the first as final reports success early or times out on a command that
was working. Wait for a terminal result.

### A missing ack is not a failure

Losing a `COMMAND_ACK` on the return leg is common and says nothing about whether the command
ran. A confirm timeout is therefore not a result — it is the point at which the node checks the
peer table.

- **Completion condition exists** → check state. An armed vehicle means the arm worked; report
  success, noting the confirmation came from observed state rather than acknowledgement.
- **No completion condition** → the outcome is genuinely unknown. Report **unconfirmed**, a
  third result rather than a dressed-up success or failure.

Unconfirmed does not fire Continue by default, so a chain halts rather than proceeding on an
assumption; the status record says why. A per-node option lets it continue anyway, for commands
where a lost ack does not matter. Every status record carries how the outcome was confirmed — by
acknowledgement, by observed state, or not at all — because downstream logic reasons differently
about each.

Retry follows the same logic. It is safe where the command is idempotent, which most `set`
semantics are: arming an armed vehicle acks `ACCEPTED`. It is not safe for commands that restart
or toggle — `MISSION_START` and `PREFLIGHT_REBOOT_SHUTDOWN` among them — and those never
auto-retry.

### The vehicle answers "can you do this right now"

Do not build a client-side precondition table. `MAV_RESULT` carries the answer from the only
party that knows, and each value implies a different chain behaviour:

| Result | Meaning | Chain |
|---|---|---|
| `ACCEPTED` (0) | executed | continue |
| `TEMPORARILY_REJECTED` (1) | valid, not right now — busy state machine, no GPS lock yet | back off and retry; the spec says retrying later works |
| `DENIED` (2) | supported, parameter values invalid | retrying identically never works; fail |
| `UNSUPPORTED` (3) | unknown to this stack | fail — a firmware mismatch, not an operator error |
| `FAILED` (4) | valid but execution failed — uncalibrated sensors, out of memory | fail; something must be fixed first |
| `IN_PROGRESS` (5) | running, more updates coming | keep waiting for a terminal result |
| `CANCELLED` (6) | cancelled by `COMMAND_CANCEL` | stop |
| `COMMAND_LONG_ONLY` (7) / `COMMAND_INT_ONLY` (8) | wrong carrier message | resend in the other form |
| `COMMAND_UNSUPPORTED_MAV_FRAME` (9) | frame not supported | fail, naming the frame |
| `NOT_IN_CONTROL` (10) | this system does not hold control | fail and surface it — another GCS has authority |

`TEMPORARILY_REJECTED` is the readiness answer. A takeoff sent before the vehicle is ready comes
back with it, and the right response is to wait and retry — not to consult a table that would
need maintaining per stack and per firmware version.

The chain's real protection is upstream: **await completion on each step and the next cannot
fire early.** Awaiting mode-active on Set Mode is what guarantees the following command arrives
in a mode that accepts it.

### Ack is not completion

`ACCEPTED` means the command was accepted, not that the vehicle got there. `Arm → Takeoff →
Move` chained on acks fires Move while the vehicle is still climbing.

The **await completion** tier closes that gap inside the node. The condition comes from the
command plus its own params, checked against the peer table:

| Command | Completion |
|---|---|
| `COMPONENT_ARM_DISARM` | armed state matches the requested param |
| `NAV_TAKEOFF` | climb height reaches the commanded climb, within tolerance |
| `NAV_LAND`, `NAV_RETURN_TO_LAUNCH` | landed state reports on-ground |
| `DO_SET_MODE` | active mode matches the requested mode |

The node already holds the param, so it already holds the threshold. Commands with no
meaningful completion state do not offer the tier — the dropdown stops at confirm.

**Takeoff completion reasons in climb height, not raw altitude, because the takeoff param
is a different datum per frame.** `GLOBAL_POSITION_INT` reports both `relative_alt`
(above home) and `alt` (AMSL); the peer table stores both as the raw wire millimetres, and
`lib/command/completion.js` divides by 1000 to reason in metres. For a relative frame — and for `COMMAND_LONG`,
which carries no frame at all — the takeoff param *is* the climb, so completion compares it
directly to `relative_alt`. For an absolute frame (`GLOBAL` 0, `GLOBAL_INT` 5) the param is
an AMSL target, so the climb target is `param − home`, where home is derived as
`alt − relative_alt`; completion then compares that climb target to `relative_alt`. This
keeps the ±10% tolerance meaningful — 90% of an AMSL number is a point below the ground — and
avoids a false timeout from comparing an AMSL target against a relative reading. Because only
`COMMAND_INT` puts a frame on the wire, the command node passes the frame to completion only
when the effective carrier (after any INT→LONG swap) is INT; a `COMMAND_LONG` takeoff always
uses the relative datum. The AMSL branch is reasoned from the frame semantics and unit-tested
against synthetic peer positions, not yet measured against SITL. Terrain frames
(`GLOBAL_TERRAIN_ALT` 10/11) are treated as relative-to-home; over near-home takeoff terrain
that holds, but a terrain-relative completion datum is unimplemented.

Every completion wait carries a timeout. A vehicle that accepts a takeoff and never climbs must
not hang the flow — the wait ends, Continue does not fire, and the status record names the
timeout.

With this, the chain is `Arm → Takeoff → Move`, three nodes, each set to await completion.

### Coordinate frames

Three rules, each of which encodes a wrong message if missed:

- **Wire lat/lon are `degE7` integers, and unit conversion belongs to exactly one of two
  surfaces.** The **typed operator surfaces** — command/swarm/payload/mission builders — take
  degrees and scale (×1e7 global, ×1e4 local, §14-measured), deciding *whether* from static
  schema (command identity, frame), never from the value. The **raw surface** — mavlink-build's
  codec — performs **no unit conversion in either direction**: a field labelled `degE7` takes
  degE7, matching every reference raw layer (pymavlink's generated `*_send`, node-mavlink's
  message classes, MAVSDK's passthrough — none contain a single unit multiply). This split is
  also what makes `mavlink-in → mavlink-build` compose: mavlink-in emits raw wire fields
  (`lib/connection/wire.js` `extractFields`, no codec decode), so Build must accept them
  unchanged — sentinels (`INT32_MAX` "unknown", `INT32_MIN` "at infinity") included, as plain
  integers with no mapping to guess wrong. The one degE7-specific kindness on the raw surface
  is the error message: a degrees-looking decimal is rejected naming the unit and the fix
  (× 1e7), not with a generic non-integer complaint.
- **A COMMAND_INT coordinate scales by frame.** Global frames take degrees × 10⁷; local frames
  take **metres × 10⁴** — the divisor is frame-dependent per common.xml, and both halves are
  measured (§14), not inferred. This applies to real coordinate params only: a natively-degE7
  param and a non-location `param5`/`param6` (gimbal flags and the like) carry what the operator
  entered in either frame. `MISSION_ITEM_INT` declares the same field semantics but its decode
  path is separate firmware code and **has not been measured** — do not assume it follows until
  it has been.
- **NED is down-positive.** Every UI and every operator says altitude up-positive, so the sign
  flips exactly once, at encode, in Move — never in the UI and never twice.
- **A metre offset scales longitude by latitude.** North is metres ÷ 111,320 in degrees;
  east divides further by cos(latitude), or offsets shrink toward the poles. Used by Swarm
  expansion and anything computing relative positions.

### Command presets

A preset is not a separate command. It is **(command, pinned params, exposed params, friendly
name)** over the same metadata everything else uses. Arm and Disarm are one `MAV_CMD` with
param 1 pinned to opposite values; Yaw and Rotate are one command with the relative flag pinned.
That is why the preset list is short and hand-curated while remaining maintenance-free — a
dialect update changes the fields, never the preset definitions.

Exposed params render by the §6 rules: `enum=` becomes a dropdown, everything else a number
field with units and range. Pinned params are hidden.

**Basic**

| Preset | Command | Pinned | Exposed |
|---|---|---|---|
| Arm | `COMPONENT_ARM_DISARM` (400) | Arm = 1 | Force (0 or 21196) |
| Disarm | `COMPONENT_ARM_DISARM` (400) | Arm = 0 | Force |
| Set Mode | `DO_SET_MODE` (176) | — | Mode, from the profile's firmware table |
| Takeoff | `NAV_TAKEOFF` (22) | — | Altitude, pitch, yaw |
| Land | `NAV_LAND` (21) | — | Abort altitude, latitude, longitude, altitude |
| Return to Launch | `NAV_RETURN_TO_LAUNCH` (20) | all | — |
| Set Home | `DO_SET_HOME` (179) | — | Use current, latitude, longitude, altitude |

**Autonomy**

| Preset | Command | Pinned | Exposed |
|---|---|---|---|
| Go To / Reposition | `DO_REPOSITION` (192) | — | Latitude, longitude, altitude, speed, yaw, flags |
| Change Speed | `DO_CHANGE_SPEED` (178) | — | Speed type (enum), speed, throttle |
| Yaw | `CONDITION_YAW` (115) | Relative = 0 | Angle, angular speed, direction |
| Rotate | `CONDITION_YAW` (115) | Relative = 1 | Angle, angular speed, direction |
| Orbit | `DO_ORBIT` (34) | — | Radius, velocity, yaw behavior, latitude, longitude, altitude |

`DO_REPOSITION` yaw takes `NaN` to hold the current heading. That is a live case of the §5 rule
that `NaN` is a sentinel only in fields whose metadata declares it, and the editor must be able
to express it.

**Mission**

| Preset | Command | Pinned | Exposed |
|---|---|---|---|
| Mission Start | `MISSION_START` (300) | — | First item, last item |
| Pause | `DO_PAUSE_CONTINUE` (193) | Continue = 0 | — |
| Resume | `DO_PAUSE_CONTINUE` (193) | Continue = 1 | — |

**Telemetry / System**

| Preset | Command | Pinned | Exposed |
|---|---|---|---|
| Request Message | `REQUEST_MESSAGE` (512) | — | Message (dropdown of the dialect's messages), response target |
| Set Message Interval | `SET_MESSAGE_INTERVAL` (511) | — | Message (dropdown), interval, response target |
| Stop Message Interval | `SET_MESSAGE_INTERVAL` (511) | Interval = −1 | Message (dropdown) |
| Reboot Autopilot | `PREFLIGHT_REBOOT_SHUTDOWN` (246) | — | Autopilot action, companion action |

Message ID params are dropdowns of the dialect's message list, not free-text integers. The
metadata already carries the names.

**Safety** — every preset here requires an explicit confirmation before it will send.

| Preset | Command | Pinned | Exposed |
|---|---|---|---|
| Flight Termination | `DO_FLIGHTTERMINATION` (185) | — | Terminate |

**Advanced** — every `MAV_CMD` in the loaded dialect, enumerated with its numeric value, all
params exposed under the §6 rendering rules. Nothing is pinned and nothing is hidden. This is
the path for custom-dialect commands and for anything the preset list does not cover.

Preset availability is filtered by the profile's firmware where support is known. A preset that
the selected stack does not implement is not offered rather than offered and silently rejected.

### Mission protocol

Three state machines over one item-transfer protocol, and the only place in the package where
the vehicle drives the conversation.

**Download.** `MISSION_REQUEST_LIST` → `MISSION_COUNT` → request each item by sequence →
`MISSION_ACK`. A count of zero terminates immediately with an ack; do not wait for items that
will never come. The `mission_type` on every message must match the one requested — a vehicle
answering about a different type is a mismatch, not a mission. **Only the first count opens the
walk**: a `MISSION_COUNT` arriving mid-walk is a retransmission and is ignored (the in-flight
item step's timer drives recovery) — restarting from it discards progress, resets the retry
ceiling, and a smaller stale count truncates the mission.

**Upload.** `MISSION_COUNT` → the vehicle requests items by sequence → send each → `MISSION_ACK`.
**The vehicle chooses the order**, and it may re-request an item it already received; answer
whatever it asks for rather than assuming a walk from zero. Answer each request in the item
format it asked for — a `MISSION_REQUEST_INT` is not satisfied by a `MISSION_ITEM`.
**An error ack ends the upload immediately, at any phase**, carrying the vehicle's result code —
the vehicle's only channel for "count too big" / "busy" / "can't allocate" is an error
`MISSION_ACK` sent before any item request. Two exceptions: `INVALID_SEQUENCE` is dropped
(ArduPilot emits it mid-transfer for duplicated items on lossy links while keeping the transfer
alive), and an `ACCEPTED` before every declared item was requested is a protocol error — a
failure, never a success and never silently ignored.

**Clear.** `MISSION_CLEAR_ALL` → `MISSION_ACK`. This one is destructive and gets a confirmation
gate.

Rules across all three:

- **A failed upload fails.** It must never degrade into a clear. A vehicle left with a partial
  mission is recoverable; one silently emptied is not.
- **Retry per item, with a ceiling**, then abort the whole transfer with the sequence number
  that stalled. A transfer that hangs forever is worse than one that fails.
- **Item validation is per type, and reserves families — it does not allowlist commands.** A
  mission item may carry *any* command except the fence and rally families; fence items are only
  `MAV_CMD_NAV_FENCE_*`; rally is only `MAV_CMD_NAV_RALLY_POINT`. Three validators, not one with a
  flag. The mission validator deliberately does **not** decide which commands a firmware supports
  (issue #90): PX4 and ArduPilot accept different sets, the dialect XML carries no
  "mission-capable" attribute, and every reference client at this layer (pymavlink `MAVWPLoader`,
  MAVSDK `MissionRaw`, QGroundControl on upload) passes any command through and lets the vehicle's
  `MAV_MISSION_UNSUPPORTED` be the authority. So do we. The fence/rally *reservation* is the one
  exception, and its command set must track every dialect that defines one — `common.xml`
  (fence 5000–5004, rally 5100) **and** `development.xml` (fence 5005 `NAV_FENCE_HOME_CIRCLE_INCLUSION`,
  WIP). A fence id missing from that set would leak into a mission upload. Measured from the XML,
  id by id — not a reserved id *range*, which would assume ids the dialect has not defined (§14).
  Command ids are also required to be `uint16` integers before the family test, so a value like
  `5001.9` cannot truncate on the wire into reserved fence `5001`.
- **Lock per connection, profile, and type.** A fence upload and a mission download run
  concurrently; two fence uploads do not.
- **Progress is status, not a port.** Phase and item counts go out output 1 as they happen.
- **Firmware gates the type list.** ArduPilot carries mission, fence, and rally over this
  protocol; PX4 does not treat fence and rally the same way. Read the profile's firmware field
  and offer what that stack supports rather than three options where one silently no-ops.

### Payload topics

Camera: photo, start video, stop video, set mode, trigger by distance.
Gimbal: aim, set mode, ROI set/clear — and aim has two message paths
(`DO_MOUNT_CONTROL` vs `GIMBAL_MANAGER_SET_PITCHYAW`) chosen by gimbal generation, so that is a
per-verb choice inside the topic, not a node-level setting. Servo: set, repeat. Release:
gripper, winch, parachute.

## 10. Swarm

`mavlink-swarm` fans one action out across a selected group.

**Selection** comes from the peer table: all vehicles, an explicit sysid list, or a filter on
type, firmware, or armed state. Groups resolve at execution, not deploy — a vehicle that went
stale is not in the group.

**Execution** is an explicit control with two values, chosen at design time.

- **Sequential** (default) — one targeted send per member at a configurable interval. Paced, not
  blasted; a hundred vehicles must not become a burst that overruns the link.
- **Broadcast** — one packet for the whole group, detailed below.

The mode is not switched at runtime. A partial sequential run followed by a broadcast re-executes
the command on everything already commanded.

**Aggregation** is explicit. Output 0 fires only when every member succeeded. Output 1 carries
the aggregate either way, with per-vehicle detail — a partial failure must never look like
success.

**Dry run** is a checkbox orthogonal to Delivery: expand the group, build every message, emit
the preview, send nothing.

**Broadcast** sets `target_system = 0` so one packet reaches every vehicle on the link at once —
no pacing, no expiry window, and real simultaneity instead of sends spread over seconds. Where
sequential fan-out proves too slow for a manoeuvre, the flow is built to broadcast.

What comes with it:

- **Pin `target_component` to the autopilot (1), not 0.** All-systems *and* all-components
  reaches gimbals, cameras, and companions. Harmless for arm; not harmless for
  `PREFLIGHT_REBOOT_SHUTDOWN`.
- **Uniform commands only.** Anything carrying per-vehicle values is meaningless broadcast.
- **One packet carries one param set,** so a broadcast connection is single-stack wherever the
  params are stack-specific — `DO_SET_MODE` custom mode values differ between PX4 and ArduPilot.
  A mixed fleet is two connections and two broadcasts, which is a normal design, not a
  limitation worth engineering around.
- **Retry is re-execution.** A broadcast cannot be retried for the few that did not answer
  without re-running it on the many that did.
- **Acknowledgements arrive together.** Paced fan-out also paced the return traffic. A hundred
  vehicles answering one broadcast produce a hundred `COMMAND_ACK`s inside a few milliseconds —
  nothing on a LAN, a collision burst on a shared telemetry radio. Broadcast moves congestion
  from outbound to inbound. On constrained links, confirm by peer-table state rather than by
  counting acks.
- **Confirmation needs an expected set.** *Send & confirm* against a broadcast waits on the group
  resolved from the peer table with a per-vehicle timeout, not on a single acknowledgement.

Simultaneity is only as good as the links. Two UDP connections on one LAN land within
milliseconds; a WiFi link and a 57600-baud serial radio do not, once serialization and TDM slot
latency are counted.

**A member expiring mid-fan-out does not abort the run.** Continue, and report that member as
failed in the aggregate status. Aborting leaves the fleet half-commanded, which is worse
than either end state; re-resolving silently adds vehicles the operator never approved. Continue
is the only option that ends in a state the operator can reason about.

**Swarm wraps single-message actions, never multi-message transactions.**

| Action | Fan-out | Why |
|---|---|---|
| Command | yes | one message, one acknowledgement per vehicle |
| Move | yes | setpoints, no acknowledgement to correlate |
| Payload | yes | commands, same shape as Command |
| Param — set one | sequential only | one message confirmed by echo; broadcast makes the echoes a storm |
| Param — request list | no | a bulk transfer, not a message |
| Mission — any action | no | a conversation the vehicle drives |

Mission is the instructive exclusion. Upload is `MISSION_COUNT`, then the vehicle requesting items
by sequence, then an acknowledgement — many messages to *one* target. Broadcasting it starts a
hundred interleaved conversations on one socket, and doing it sequentially serializes on the
per-connection lock anyway, turning a hundred vehicles into a hundred multi-second transactions
end to end.

A swarm also rarely wants the *same* mission. Giving each vehicle its own area is N distinct
payloads — a loop over the Mission node, not one action fanned out. If that loop ever becomes a
first-class feature it is a different node with a different shape, not an option here.

Swarm is single-connection. Cross-connection fleets are out of scope for this pass.

## 11. Firmware support

Vehicle Profile carries the firmware field: PX4, ArduPilot, or custom. It affects:

- **Flight modes** — entirely different tables, and custom mode is a firmware-specific bitfield.
- **Mission types** — as above.
- **Parameter encoding** — `PARAM_SET` / `PARAM_VALUE` carry typed values in a float slot.
  Encoding is resolved as: explicit `msg.payload.paramEncoding` (`bytewise` | `c-cast`) →
  peer `AUTOPILOT_VERSION.capabilities` (`PARAM_ENCODE_BYTEWISE` / `PARAM_ENCODE_C_CAST`) →
  known firmware (PX4 → bytewise bit-cast; any other named firmware → C-cast). Missing
  firmware after those steps fails loud — do not invent ArduPilot/C-cast. A present override
  outside the two legal values is rejected (dynamic `msg` input); only an absent override
  falls through. Do not invent encoding from firmware alone when the peer has advertised a
  capability bit.
- **Command support** — not every `MAV_CMD` is implemented by both stacks.

Custom means: use the compiled dialect, offer no firmware-specific behavior, and do not pretend
to know the mode table.

## 12. Build order

1. **Metadata pipeline.** Seed blob + catalog overlays, XML compile with include resolution,
   the shared bundle shape, dialect library pickers. Nothing else is buildable until
   enumeration works.
2. **The field codec (§5).** The standalone conversion library and its test suite. Everything
   that touches a wire value depends on this, and nothing above it is trustworthy until it
   passes.
3. **Config nodes and identity resolution.**
4. **Connection: transports, peer table, queue, lifecycle — with room for signing.** Signing
   is off by default at runtime, but the channel state must carry link ID, sequence, and replay
   memory from the first commit. The feature is optional; the state model accommodating it is
   not. Bolting it on later means reworking Connection. **UDP, TCP, and serial ship together**
   on the same driver contract (shallow write, wait for accept/drain, then dequeue). Serial
   lazy-loads optional `serialport`; UDP/TCP installs must work without it.
5. **In, Out, Build.** First end-to-end traffic.
6. **Command, Move, Param, Payload, State.**
7. **Mission.**
8. **Swarm.**
9. **Examples**, once node contracts are stable. Examples are a product surface, not a test
   directory.

### Remaining after the §12 spine

The spine above is in tree. What follows was skipped, stubbed, or left partial — not abandoned
by silence. Update this list when an item lands.

| Item | Status | Notes |
|---|---|---|
| **Custom dialect upload in the Vehicle editor** | deferred | Superseded by the dialect library (Seed + catalog dates). No path/upload UI. Legacy `customDialectPath` still resolves; private-dialect library ingestion is future work. |
| **Command node `COMMAND_INT`** | **done** | Carrier is a required operator choice (no default; node reds out unset) and every tier — build included — honours it. Positional params are always degrees; the INT carrier scales ×1e7 per the dialect XML's own classification (`intCoordKinds`: `hasLocation` + not-degE7 → scale; natively-degE7 params carry raw; non-location param5/6 like gimbal flags never scale; unknown command → historical scaling). NaN in param5/6 refuses the INT build loud — the spec routes NaN-meaning commands to COMMAND_LONG, and coercion would aim at null island. On `COMMAND_INT_ONLY`/`COMMAND_LONG_ONLY` warns and rebuilds once from the canonical degree params in the other form; second wrong-carrier fails loud (no auto-swap in Swarm/Payload — homogeneous fleets per node, the named result tells the operator which way to flip). Swarm command/payload actions and Payload command-backed verbs share the same required-carrier rule and the same `lib/command` builders; message-kind payload verbs ignore the carrier. |
| **DSCP socket marking** | **done** | Optional `sockopt` marks `IP_TOS`/`IPV6_TCLASS` from band DSCP immediately before each IP send; absent → unmarked, queue unchanged. |
| **Param definition catalog** | **done** | `lib/param/defs.js` fetches ArduPilot `apm.pdef.json` by family or Vehicle `paramDefsUrl` (PX4/custom); cache; Param editor datalist + units/enums. |
| **Full command-param `enum=` recovery** | **done** | Seed compile carries common.xml `<param enum=`> links into the bundle (e.g. Arm → `MAV_BOOL`). The old `hints.js` overlay is gone. |
| **Move editor §6 reshape** | **done** | Per-field rows + mode/delivery visibility in the Move dialog. |
| **Payload verb field completeness** | **done** | Editor exposes streamId/statusFrequency, ROI lat/lon/alt, stabilize flags, cameraId/sequence/shutter/trigger, gimbal flags/device id; §6 show/hide per verb. |
| **`httpAdminRoot` on non-enum admin routes** | **done** | Command/Build/In/Swarm/Param/Vehicle editor catalogs use `RED.mavlink.adminApiUrl('/mavlink/…')`. |
| **SITL example flows** | **done** | `examples/sitl/` 01–25 (companion, INT matrix, Move, param echo, In/Build/Out, inherit, TCP template) + README; regular demos in `examples/` (see `CATALOG.md`). |
| **SITL Docker lab** | **done** | Compose under [`sitl/`](sitl/README.md): 5× AP + 5× PX4 + companions 20/21; arm-only logs; optional `nodered` profile. |
| **SITL-backed tests (§13)** | open | Fixture suite in CI; firmware behaviour still needs the live five+five rig (local Docker lab). Live suite results are logged as GitHub Issues (`sitl-results`), not in-repo `testing.md` churn. |
| **Cross-connection swarm** | out of scope | As designed (§10): two Connections → two Swarm nodes. |

## 13. Testing and SITL

**The rig.** Five ArduPilot and five PX4 SITL instances at unique system IDs — ArduPilot 1–5,
PX4 11–15. The gap is deliberate: a mistyped sysid lands nowhere rather than on the wrong stack.
The two stacks sit on separate connections with one profile each, which is the arrangement the
design expects rather than a testing convenience. Five vehicles per connection is what exercises
the peer table, queue pacing, and swarm fan-out. Examples use one instance or five.
GCS ports for examples and the Docker lab: ArduPilot **14550→14551**, PX4 **14560→14561**.
Companion-mode vehicles (sysid **20** AP / **21** PX4) use **14540→14541** and
**14542→14543**.

**Docker lab.** A Compose harness that launches this rig (plus the companion pair) lives under
[`sitl/`](sitl/README.md). Operator instructions stay there — this section defines the rig;
`sitl/README.md` / [`sitl/AGENTS.md`](sitl/AGENTS.md) are how to run it.

**Live suite results.** Each suite run closes the previous open GitHub Issue labeled
`sitl-results`, publishes the new curated PASS/PARTIAL/FAIL/SKIP table in a new
`sitl-results` issue, and does not open a results-only PR. Do not land per-run
`testing.md` or `example-suite-results.json` updates in product PRs — those only churn
review bots. `testing.md` in-tree is a pointer to this workflow.

**Test sources are two, and only two.** Pain points conceived up front, written before the code
they guard. Then one regression test per bug, added when the bug is found. No coverage target —
a percentage would only reward testing the parts that were never going to break.

*Pain points testable with fixtures alone:*

- **Field codec** — bit-31 masks, blank versus explicit zero, `NaN` sentinels, the parameter
  int/float union, `char[]` length handling, 64-bit as decimal string. Round-trip compared
  NaN-aware at float32 precision, plus pinned payload-byte vectors.
- **Registry load** — all ten bundled dialects assemble from `mavlink-mappings`; include-chain
  merge surfaces `HEARTBEAT` / `MAV_AUTOPILOT` on `common`; unknown dialect fails loud.
- **`.d.ts` recovery** — a known enum-typed message field resolves to its enum; missing
  declarations degrade field→enum to empty rather than failing the dialect load.
- **XML compile (custom only)** — include ordering, missing include, cyclic include, msgid
  collision between files, same-message override precedence.
- **Param rendering** — the four-case rule, `reserved` and `Empty`/`Reserved` hiding, and the
  increment-collapse case where min, max, and increment admit only a few values.
- **Identity resolution** — an explicit override that is not a bound identity is rejected and
  does not fall back to the default.
- **Peer table** — per-section freshness, stale versus expired transitions, endpoint-change
  event.
- **Signing** — first-contact acceptance, out-of-order rejection, the one-minute floor, and the
  timestamp store refusing to advance from an unverified packet.
- **Queue** — priority clamping below the emergency band, coalescing keyed including identity.

*Pain points needing SITL, because firmware behaviour cannot be faked honestly:*

- **Completion tiers** — `IN_PROGRESS` followed by `ACCEPTED` on takeoff, and the timeout path
  when a vehicle accepts a takeoff and never climbs.
- **Mode tables** per stack, and `DO_SET_MODE` custom mode values.
- **Parameter int/float union** on PX4 specifically.
- **Mission, fence, and rally** per firmware, request-format handling, and a malformed upload
  failing rather than degrading into a clear.
- **Multi-vehicle handling and swarm pacing** across five instances, including a member expiring
  mid-fan-out.
- **Signing against a stack that actually verifies.**

Anything firmware-gated runs on both stacks. A test that passes on ArduPilot only is not
evidence.

Lint is not a test. Green lint means no rule fired, not that anything works, so work is never
reported verified on a lint pass.

### Required lints

The gate is deliberately focused: high-signal correctness, Node.js compatibility/dependency
checks, and Promise API misuse only — no formatting, style, complexity, SonarJS, or JSDoc rules.
Rules here have to stay cheap to keep green, or the gate becomes something people work around
instead of something that catches defects.

| Rule set | Setting | Why |
|---|---|---|
| `@eslint/js` recommended | error | The maintained ESLint correctness baseline catches undefined names, unreachable code, dead bindings, precision loss, discarded error causes, and similar defects without imposing a house style. MAVLink's intentional NUL-stripping regexes exempt `no-control-regex`; empty `catch` blocks are allowed where absence is the fallback contract. |
| `eslint-plugin-n` dependency checks | error | `no-deprecated-api`, `no-extraneous-require`, and `no-missing-require` catch Node.js/package mistakes. The optional `sockopt` module and `node-mavlink`-provided `mavlink-mappings` are explicit resolution exceptions. |
| `eslint-plugin-n` compatibility checks | error | `no-unsupported-features/es-builtins`, `no-unsupported-features/es-syntax`, and `no-unsupported-features/node-builtins` enforce the package's Node `>=20` floor, set in `eslint.config.mjs`'s `settings.node.version` (the plugin does not read `engines` here — both must move together). The builtins check allows experimental APIs. `node:test` is stable on this floor (since Node 20.0.0), so the Node-18-era `ignores` for `test`/`test.before`/`test.after` are gone. `fetch` is not — it stays marked experimental until Node 21, and `allowExperimental` is what keeps `lib/metadata/xml-catalog.js` and `lib/param/defs.js` passing. Newer modules such as `node:sqlite` still fail. |
| `eslint-plugin-promise` API checks | error | `no-new-statics`, `no-return-in-finally`, `no-return-wrap`, and `valid-params` catch concrete Promise API/control-flow mistakes without imposing chaining style or rejecting Node-RED's callback boundaries. |
| `no-bitwise` | error, **codec directory only** | The field codec builds masks arithmetically (§5). Banning the operators makes that a build failure rather than a review comment, in the bug class that historically cost the most rework. Runtime code elsewhere is unaffected. |

`no-unused-vars` needs four options, each for a reason:

- `caughtErrors: 'all'` — an unused catch binding is a swallowed error wearing a name.
- `caughtErrorsIgnorePattern: '^_'` — `_err` is the explicit escape for a deliberately ignored
  fallback error.
- `ignoreRestSiblings: true` — rest-destructuring past keys deliberately omits them; those
  siblings are the mechanism, not dead code.
- `varsIgnorePattern: '^_'` and `argsIgnorePattern: '^_'` — an underscore prefix is the escape
  hatch for a genuinely unused parameter, so the rule never needs a disable comment.

Set `reportUnusedDisableDirectives: 'error'`. A disable comment for a rule that no longer fires
is itself stale, and stale suppressions are how a gate quietly stops gating.

**Scope: `lib/`, `nodes/`, `scripts/`, `test/`, `integration/`, the lint config, and editor
JavaScript inside `nodes/**/*.html`.** `eslint-plugin-html` extracts JavaScript from Node-RED's
`<script type="text/javascript">` blocks; `globals` supplies the standard Node and browser
environments, with `RED`, `$`, and `jQuery` declared read-only. Editor-versus-runtime drift tests
still cover what JavaScript lint cannot: control ids, templates, admin endpoints, and §6 rendering
contracts.

`npm run test:lint-config` probes both integration JavaScript and inline editor JavaScript with a
deliberate undefined name. It prevents a future config edit from silently dropping either scope.
CI also runs the exact-version official Node-RED package scorecard
(`npm run validate:node-red`) once on Node 22; it complements lint by inspecting package metadata
and declared node files. The scorecard's recommendations are advisory warnings unless the tool
returns a failing exit code. It runs as an isolated `npm exec` tool rather than a project
dependency because its legacy transitive graph has known high/critical audit findings; the
tradeoff is a live registry download during this CI step.

## 14. Ground truth

Each entry below was got wrong first and measured second. They are recorded because the wrong
belief is the *plausible* one — a builder arrives already holding it, so stating the fact alone
does not dislodge it. Every entry names the belief, the fact, and how to re-check in one command.

**Verify before asserting.** These checks cost seconds. Anything in this document that can be
confirmed against an installed package, upstream XML, or the MAVLink specification should be,
rather than recalled.

**Lessons update this document in the same change.** When a build attempt, measurement, or
working reference displaces a belief written here, rewrite the affected section and add a
§14 entry in that PR — do not leave the correction as chat memory or a code comment. The
next agent reads only this file.

**Pull requests stay at or under 50 files.** Larger layers split by module boundary into
sequential PRs. Count: `git diff --name-only <base>...HEAD | wc -l`.

---

**Takeoff completion compares climb height, and the takeoff param's datum is frame-dependent.**
*Wrong belief:* the `NAV_TAKEOFF` param is always a relative altitude, so completion can compare
it directly to `GLOBAL_POSITION_INT.relative_alt` regardless of frame.
*Fact:* the param carries whatever datum the command's `MAV_FRAME` names. In an absolute frame
(`GLOBAL` 0 / `GLOBAL_INT` 5) it is an AMSL target; comparing it to `relative_alt` never
satisfies at a non-zero home elevation and times out a successful takeoff. Completion converts
to a climb target — relative frames and `COMMAND_LONG` use the param as-is, absolute frames use
`param − home` where `home = alt − relative_alt`. Only `COMMAND_INT` carries a frame on the
wire, so the command node passes the frame to completion only when the effective carrier (after
any INT→LONG swap) is INT. This branch is reasoned from frame semantics and unit-tested against
synthetic peer positions; it is not yet SITL-measured.
*Check:* `node --test test/command/completion.test.js`

**Inline Node-RED editor JavaScript is useful lint scope even though HTML contract tests remain
necessary.**
*Wrong belief:* every editor convention is author-local, so linting `nodes/*.html` adds little
beyond the existing editor/runtime drift tests.
*Fact:* `eslint-plugin-html` extracts ordinary JavaScript from Node-RED editor
`<script type="text/javascript">` blocks and catches author-independent correctness defects such
as undefined names and dead bindings. Drift tests remain responsible for markup and
editor/runtime contract alignment.
*Check:* `npm run test:lint-config`

**Locking the legacy Node-RED scorecard into the project is not a free hermeticity win.**
*Wrong belief:* adding `node-red-dev@0.1.6` to `devDependencies` is strictly better than invoking
that exact tool version outside the project dependency graph.
*Fact:* the exact dev dependency adds hundreds of legacy packages and currently introduces
high/critical audit findings into this repository's lockfile. CI invokes the exact scorecard
version in an isolated `npm exec` environment instead. This deliberately accepts registry
availability and transitive-resolution risk without making the legacy toolchain part of normal
installs.
*Check:* `scorecard_tmp="$(mktemp -d)" && npm install --prefix "$scorecard_tmp" --package-lock-only --ignore-scripts --save-dev --save-exact node-red-dev@0.1.6 && npm audit --prefix "$scorecard_tmp" --audit-level=high`

**Dialect authority is the seed blob, not `mavlink-mappings` and not a path upload.**
*Wrong belief:* §4 still requires a Vehicle-editor custom XML path/upload, or loading dialects
from the `mavlink-mappings` npm registry / vendored `dialects/*.xml`.
*Fact:* shipped dialects come from `seed/mavlink-YYYY-MM-DD-<sha>.seed.gz` (pointer in
`seed/active.json`). The editor is dialect + version (Seed or a catalog date) only. Catalog
refresh overlays newer official XML under the Node-RED userDir. Legacy `customDialectPath`
is a migration escape, not a supported add-dialect path. Private-dialect library ingestion
is deferred (§4, §12 remaining table).
*Check:* `node -e "const {knownDialects,seedStamp}=require('./lib/metadata/bundled'); console.log(seedStamp(), knownDialects().slice(0,3))"`

**Message-field `enum=` comes from the compiled seed/catalog XML, not `.d.ts` recovery.**
*Wrong belief:* because an old path recovered field→enum links from `mavlink-mappings` `.d.ts`,
that pipeline is still required.
*Fact:* the seed (and catalog compiles) carry `enum=` from upstream XML into
{@link DialectBundle}. No `.d.ts` scrape for the dialect library.

**Command-param `enum=` is in the seed — no `hints.js` overlay.**
*Wrong belief:* a hand-maintained `lib/metadata/hints.js` table is still required to recover
`<param enum=`> links the registry dropped, or the editor must offer a custom XML upload.
*Fact:* the XML compiler writes those links into `commands[*].params[*].enum` at seed
generate / catalog compile time. A missing `enum=` still renders a number field — fix the
seed/XML, do not resurrect a parallel hint table.
*Check:* `node --test test/metadata/commands-list.test.js` (seed Arm → `MAV_BOOL`).

**Seed bundles already carry the include chain.**
*Wrong belief:* runtime must merge `mavlink-mappings` modules (`minimal` → `standard` →
`common`, …) or force MSC under every dialect.
*Fact:* `scripts/generate-seed.js` walks `<include>` per selectable root into
`bundle.files`; wire registries follow that list and start empty otherwise. Unknown dialect
fails loud — never silent-fallback to `common`.
*Check:* `node --test test/connection/wire-registry.test.js`

**Params without `enum=` are scalars, not gaps.**
*Wrong belief:* 85 of 947 is poor coverage.
*Fact:* the rest are latitude, yaw, altitude, accept radius. `enum=` is the marker for
*categorical*; its absence means render a number field. Coverage is complete, not thin.

**`Empty` and `Reserved` as description text are the legacy `reserved="true"`.**
*Wrong belief:* unlabelled params need a fallback numbered grid.
*Fact:* 279 of 420 unlabelled params in `common.xml` carry `Empty`, `Empty.` or `Reserved` as
body text. Treat them as reserved and no numbered field survives anywhere.
*Check:* the four-case rule in §6.

**One-arg editor validators treat an error string as valid.**
*Wrong belief:* `validate: function (v) { return 'out of range'; }` reds the field — a string is
falsy enough to mean invalid.
*Fact:* Node-RED only treats a returned string (or array) as an invalid *reason* when the
validator's arity is 2 — `function (v, opt)`. A one-argument validator coerces the return with
`!!`, so any non-empty string is truthy and the field passes. `RED.mavlink.validateUint8` and
every custom validator that returns a reason string must declare `(v, opt)`. (Measured on the
editor-client in Node-RED 4/5; same rule since 3.x.)
*Check:* `rg -n "validateUint8|function \(v, _?opt\)" nodes/mavlink-local-identity.html`

**`oneditsave` runs before Node-RED's generic form-to-node copy.**
*Wrong belief:* assigning `this.someProperty` inside `oneditsave` overrides the value in its
`node-config-input-someProperty` editor control.
*Fact:* Node-RED invokes the node definition's `oneditsave`, then copies each editor control
onto the node. A stale hidden control therefore overwrites an object-only assignment. When a
role reshapes saved configuration, clear or rewrite the actual editor control in `oneditsave`;
the normal copy then persists that value. A single-select also needs an explicit empty option:
setting a value with no matching option makes jQuery return `null`, which Node-RED skips rather
than saving.
*Check:* `node --test test/nodes/local-identity-html.test.js` — the Companion save regression
executes the hook followed by Node-RED's form-copy order.

**`Buffer` already range-checks integers.**
*Wrong belief:* an out-of-range integer silently wraps — 300 into a `uint8` becomes 44.
*Fact:* `writeUInt8(300)`, `writeUInt8(-1)`, `writeUInt32LE(1 << 31)` and a Number passed to
`writeBigUInt64LE` all throw `ERR_OUT_OF_RANGE`. `node-mavlink`'s serializers are one-line
pass-throughs, so this is its behaviour too. Do not re-implement it.
*The genuinely silent cases:* `writeUInt8(undefined)` and `writeUInt8(null)` write `0`;
`writeFloatLE('abc')` writes NaN. Those are what §5 exists for.

**Packet sequence numbers cannot deduplicate across links.**
*Wrong belief:* a vehicle on two links can be told from two vehicles sharing a sysid by comparing
sequence numbers.
*Fact:* the MAVLink specification states each channel keeps its own counter, so this is
impossible. Surface the condition, do not resolve it (§8).

**Signing is a v2 feature and transmit is v2-only.**
*Wrong belief:* dropping v1 transmit drops signing.
*Fact:* signing lives in v2, which is what is transmitted. What v1 cannot do is carry a
signature block — so an inbound v1 frame is the same case as an unsigned v2 frame and needs no
separate rule.

**An invalid signature is not unconditionally rejected.**
*Wrong belief:* a forged signature is worse than none, so rejection is not configurable.
*Fact:* the specification directs libraries to allow conditional acceptance of incorrectly
signed packets — for recovering a vehicle with a corrupted key — with a conspicuous untrusted
indication. Off by default, never advancing the timestamp store (§7).

**`node-mavlink` and `mavlink-mappings` are already the ArduPilot line.**
*Wrong belief:* using ArduPilot's forks requires switching packages.
*Fact:* `node-mavlink@2.3.0` declares `github.com/ArduPilot/node-mavlink` as its repository, and
`ArduPilot/node-mavlink-mappings` publishes under the name `mavlink-mappings` at the version npm
serves. There is no `node-mavlink-mappings` package.
*Check:* `npm view node-mavlink repository.url`

**Custom dialect messages have no `node-mavlink` wire classes — synthesize them.**
*Wrong belief:* once a custom XML compiles to a bundle (§4), `node-mavlink` can frame its
messages; only the metadata was missing.
*Fact:* `node-mavlink` serializes through generated `MavLinkData` subclasses and its packet
splitter validates CRCs against `mavlink-mappings`' `MSG_ID_MAGIC_NUMBER` table — a custom
message has neither, so serialize throws "no wire class" and inbound frames are dropped at the
CRC gate. Both are recoverable at runtime: the compiled bundle carries wire types, array
lengths, and extension flags in declaration order, which is everything the generator itself
derives layout from (stable size-descending sort, extensions appended, x25 CRC_EXTRA), and the
splitter accepts a `{ magicNumbers }` override. `lib/connection/wire-classes.js` synthesizes the
classes; correctness is pinned by regenerating every bundled message and requiring identical
layout to the generated classes. A custom dialect that *includes* a bundled message (same name
and msgid, matching CRC_EXTRA and payload length) keeps the generated class; any other
collision — name-only, id-only, or same identity with a redefined layout — throws at wire
construction rather than encoding custom fields under a bundled schema. `node-mavlink` also
exports `registerCustomMessageMagicNumber(msgid, magic)`, but it mutates the process-global CRC
table (every connection inherits it, and it throws on re-registration at redeploy) — the
per-splitter override is the same feature scoped to one connection. There is no class registry
to register into: the msgid→class lookup is the caller's job in `node-mavlink`, even for
bundled dialects.
*Check:* `node --test test/connection/wire-classes.test.js`

**Wire registries start empty and follow the dialect include chain.**
*Wrong belief:* every Connection preloads `minimal`/`standard`/`common`/`ardupilotmega` so any
message in those modules encodes, regardless of the bound Vehicle Profile's dialect.
*Fact:* `createWire` builds one msgid→class map per Connection from `bundle.files` (the same
include order §4 already assembled), then synthesizes anything else in the bundle. Pick
`icarous` and the catalog and wire carry only icarous; bind another Connection to
`ardupilotmega` beside it and both registries coexist. A custom dialect with no `<include>`
does not inherit HEARTBEAT from a hidden preload.
*Check:* `node --test test/connection/wire-registry.test.js`

**Stream decoders are per endpoint, not per Connection.**
*Wrong belief:* one `MavLinkPacketSplitter` on the Connection can safely decode every TCP
client and UDP rinfo because MAVLink carries sysid/compid in each frame.
*Fact:* framing state is a byte stream before sysid is known. A partial packet from peer A
left in a shared splitter contaminates peer B. `createWire` keeps one serialize registry and
a decoder map keyed by `address:port` (capped, default 100; never-validated junk first,
then empty-buffer validated, then Map-order LRU — mid-frame peers kept, including a
first frame that has not validated yet). TCP clears via `endpoint-gone`; UDP also
age-evicts idle pipelines on the peer-table expire interval (TCP/serial do not). Cap
pressure that must drop a mid-frame buffer is the residual after both preference tiers —
accepted only when more than `maxDecoders` distinct endpoints each hold incomplete framing
state; normal fleets stay far under the cap.
*Check:* `node --test test/connection/wire-decoders.test.js`

**Node exposes no DSCP setter.**
*Wrong belief:* traffic class is settable on a socket.
*Fact:* `dgram` offers broadcast, TTL, multicast and buffer sizes; `net.Socket` offers timeout,
nodelay and keepalive. Neither reaches `IP_TOS` or `IPV6_TCLASS`. Marking needs a native binding
(§7).

**An enum referenced in one dialect file may be defined in another.**
*Wrong belief:* `common.xml` defines everything `common.xml` references.
*Fact:* `HEARTBEAT` and `MAV_AUTOPILOT` are defined in `minimal.xml`; `common.xml` only
references them. Any lookup that does not resolve the include chain first will miss.

**`ardupilotmega.xml` is identical upstream and in ArduPilot's fork.**
*Wrong belief:* ArduPilot's fork carries messages upstream lacks, so the fetch source matters.
*Fact:* byte-identical at master. Keep the source selectable because it can drift; do not assume
it has.

**Parameter definitions: ArduPilot publishes, PX4 does not.**
*Wrong belief:* both stacks expose parameter metadata at a stable URL.
*Fact:* ArduPilot serves `https://autotest.ardupilot.org/Parameters/<Vehicle>/apm.pdef.json`.
PX4 has no equivalent, so the editor supplies a URL and nothing is baked in to rot (§4).

**Grep alternation.** `grep -E` uses `|` for alternation; `\|` matches a literal pipe. More than
one measurement in this document was initially wrong because of that, including a count that
measured the regex rather than the code.

**The mission validator reserves families; it does not allowlist commands (issue #90).**
*Wrong belief (held, and shipped, until #90):* a mission item must fall inside a NAV + DO/CONDITION
numeric window (16–95, 112–250); anything outside is rejected before upload.
*Fact:* that window silently rejected legitimate items. PX4's mission parser
(`mavlink_mission.cpp`, `parse_mavlink_mission_item`) accepts `SET_CAMERA_MODE` (530),
`IMAGE_START_CAPTURE`/`STOP` (2000/2001), `VIDEO_START_CAPTURE`/`STOP` (2500/2501), and
`DO_VTOL_TRANSITION` (3000) — all outside the window (verified: `DO_VTOL_TRANSITION` falls through
to `nav_cmd` assignment, the `default` returns `MAV_MISSION_UNSUPPORTED`). ArduPilot's Copter
mission-command list accepts a *different* set (the 176–250 `DO_*` camera commands, not the 2000s).
The two firmwares disagree, the dialect XML has no "mission-capable" attribute to derive it from
(a `MAV_CMD` entry carries only `hasLocation`/`isDestination`), and the reference clients at this
layer do not guess: pymavlink `MAVWPLoader` and MAVSDK `MissionRaw` pass any command through, and
QGroundControl treats the vehicle's `MISSION_ACK` as the authority on upload. So the validator now
reserves only the fence (5000–5004) and rally (5100) families — the one rule that stops the three
mission types corrupting each other's buffers — and defers command support to the firmware, which
answers `MAV_MISSION_UNSUPPORTED` on output 1 for anything it cannot run.
*Check:* `node --test test/mission/validate.test.js` (the #90 cases: 530/2000/3000 upload as mission
items; 5001/5100 do not); PX4 source `parse_mavlink_mission_item`; the four reference clients above.

**Missing Vehicle Profile must not invent a dialect catalog.**
*Wrong belief:* `GET /mavlink/command/commands?vehicle=<id>` (or `/mavlink/enums` with no
query) can fall through to `ardupilotmega` when `RED.nodes.getNode(id)` misses or the editor
has not chosen a dialect yet.
*Fact:* the editor caches under `vehicle:<id>` / `dialect:<name>`. A silent default would pin
the wrong MAV_CMD/enum list to that key. A missing profile returns 404 unless the request also
names an allow-listed bundled `?dialect=`; `custom` without a live profile is never served.
An empty catalog query (no `vehicle`, no `dialect`) returns 400 — not a default dialect.
*Check:* `node --test test/command/commands-route.test.js test/vehicle/enums-route.test.js`

**Config-node refs use Node-RED's select + edit/add, never free-form ids.**
*Wrong belief:* a plain `<input>` with `defaults.foo.type = 'mavlink-vehicle'` is enough, or a
hand-built `<select>` of `eachConfig` is an acceptable fallback.
*Fact:* Node-RED replaces the input with a `<select>` **and** pencil/plus buttons only when
`RED.nodes.getType(type)` is a registered `category: 'config'` type at dialog prepare time. If
`mavlink-vehicle` failed to load (e.g. missing `mavlink-mappings`), the field stays free-form.
A buttonless `<select>` is not the standard control. Vehicle/command modules must still
`registerType` when deps are missing so pickers appear; editors call
`RED.editor.prepareConfigNodeSelect` via `RED.mavlink.ensureConfigNodePicker` as a safety net.
*Working reference:* Node-RED **5.0.1** / `@node-red/editor-client@5.0.1`
`prepareConfigNodeSelect` in `public/red/red.js` (builds `#…-btn-{property}-edit` pencil and
`#…-btn-{property}-add` plus). Measured against that build; re-check the same symbol after
editor-client upgrades.
*Check:* open Connection → Vehicle shows a dropdown with pencil and + ; 
`node --test test/vehicle/register-without-mappings.test.js` (mappings stubbed — type still
registers).

**Heartbeat cadence lives on Local Identity, not Connection.**
*Wrong belief:* Connection owns the HEARTBEAT interval field (and UDP `SO_BROADCAST` is how
`target_system = 0` is sent).
*Fact:* MAVLink does not mandate a HEARTBEAT rate; ~1 Hz is the RF convention. Local Identity
owns content and `heartbeatIntervalMs` (default 1000). Connection emits on each bound identity
using that interval and does not surface HB controls. Peer-table stale/expire stay on Connection
(inbound freshness). Outbound addressing uses the peer-table primary endpoint (optional Remote
fallback); `target_system = 0` is a normal message field with no Connection broadcast flag.
Legacy flows that still store Connection `heartbeatInterval` keep that cadence until the
identity flow JSON includes `heartbeatIntervalMs` (or the Connection is re-saved and the
legacy key drops).
*Check:* `node --test test/connection/heartbeat.test.js test/identity/` ;
Local Identity editor shows HB Interval; Connection editor has no Heartbeat/Broadcast rows.

**Bind-mounted source is not an installed package.**
*Wrong belief:* `npm install /module` from the Node-RED user directory (or listing
`mavlink-mappings` in `package.json`) is enough for a `/module` bind mount to load.
*Fact:* Node resolves `require('mavlink-mappings')` from the file that loads
(`…/lib/metadata/bundled.js`), walking `node_modules` upward from that real path. A bare mount
has no `node_modules`. Worse, `npm install /path` **symlinks** the package and npm's local-path
rule skips installing that package's dependencies — so `/data/node_modules/@cmc0619/node-red-contrib-mavlink`
→ `/module` still cannot see `mavlink-mappings`. Fix with `npm install --omit=dev` **on the
mount**, or install a real copy into the user directory (`npm install --install-links /path` or
a packed `.tgz` / git URL).
*Check:* `npm install /tmp/bare-checkout` from a clean userDir — `ls node_modules` has the
symlink and no `mavlink-mappings`; then `npm install --install-links /tmp/bare-checkout` and
`node -e "require('mavlink-mappings')"`.

**Component IDs are the `MAV_COMPONENT` enum table, not `MAV_COMP_ID`.**
*Wrong belief:* CompID dropdowns load enum table `MAV_COMP_ID` (because entries are named
`MAV_COMP_ID_AUTOPILOT1`, …).
*Fact:* Upstream XML / `mavlink-mappings` expose the table as `MAV_COMPONENT` (`MavComponent`).
Entry *names* keep the historical `MAV_COMP_ID_*` prefix. Asking the catalog for `MAV_COMP_ID`
returns an empty list for every dialect, so the editor falls back to `#1 (not in dialect)`.
Bundled reconstruction must re-prefix members with `MAV_COMP_ID_`, not `MAV_COMPONENT_`.
*Check:* `node -e "const {listEnumsCatalog}=require('./lib/metadata'); console.log(listEnumsCatalog('ardupilotmega',['MAV_COMPONENT']).enums.MAV_COMPONENT.find(e=>e.value===1))"`
— expect `{ name: 'MAV_COMP_ID_AUTOPILOT1', value: 1, label: 'MAV_COMP_ID_AUTOPILOT1 (1)', … }`.

**Empty CompID `<select>` fails validation before async enum fill — sticky red ring.**
*Wrong belief:* A red ring on Source CompID means the saved value is wrong, or the truncated
label `MAV_COMP_ID_MISSIONPLANNER (190)` is a different (invalid) value than numeric `190`.
*Fact:* The control stores the numeric id; the label is display-only. The template ships an
empty `<select>`. Node-RED runs property validators immediately after `oneditprepare`, while
`/mavlink/enums` is still in flight, so `mavIdentityIdValidator` sees blank and returns
`required for this role` → `input-error`. A later `fillEnumSelect` that sets `.val(190)` without
`trigger('change')` never clears that class. SysID is a number `<input>` and is unaffected.
*Check:* Local Identity seeds CompID synchronously, then `fillEnumSelect` ends with
`trigger('change')`; `node --test test/nodes/local-identity-html.test.js`.

**UDP, TCP, and serial ship on one Connection contract.**
*Wrong belief:* §12 meant UDP first, with TCP and serial as later follow-ups that can diverge.
*Fact:* All three share the driver-side shallow-write / drain contract (§7). Serial is an
optional `serialport` dependency lazy-loaded only when selected; UDP/TCP installs must work
without it. Deferring a transport after Connection lands creates a second integration pass
for peer-table endpoints and quiet-send codes — avoid that split.
*Check:* `node --test test/connection/transport-*.test.js`; Connection editor lists UDP/TCP/Serial
with no “(not yet)”.

**Move editor fields are mode-selected, not dual-labelled.**
*Wrong belief:* Local and global Move fields can share rows labelled “North / Lat”.
*Fact:* §6 destroys irrelevant fields on selection. Dual labels leave the wrong coordinate
system visible. Per-field rows + `refreshVisibility()` on mode/delivery match Payload's
topic/verb pattern.
*Check:* `node --test test/nodes/move-html.test.js` — distinct `row-move-*` ids, no
`North / Lat`.

**Editor catalog fetches must honour `httpAdminRoot`.**
*Wrong belief:* absolute `$.getJSON('/mavlink/…')` is fine because the admin API is always at `/`.
*Fact:* Node-RED can mount the editor under `httpAdminRoot` (e.g. `/red`); bare `/mavlink/…`
then 404s. Enums already used `RED.mavlink.adminApiUrl`; Command/Build/In/Swarm/Param/Vehicle
must too. Server route registration stays `/mavlink/…` — only the browser URL is prefixed.
*Check:* `node --test test/nodes/local-identity-html.test.js test/nodes/command-html.test.js
test/nodes/param-html.test.js` — `adminApiUrl('/mavlink/enums')` under `/red` →
`/red/mavlink/enums`; HTML drift tests forbid bare `'/mavlink/` in `$.getJSON`/`$.ajax`.

**SITL telemetry targets the Node-RED bind port.**
*Wrong belief:* point the vehicle “out” at `14551` because Connection is configured
`bindPort 14550` / `remotePort 14551`.
*Fact:* vehicles must send telemetry **to** `bindPort` (`14550` AP / `14560` PX4). The lab
ArduPilot entrypoint uses the official prebuilt binary with
`--serial0 udpclient:<gateway>:14550` (no MAVProxy); PX4 mavlink uses `-t <gateway> -o 14560`.
After HEARTBEAT, Connection replies via the peer-table source endpoint. `remotePort` is only
the pre-peer send fallback — examples keep `14551`/`14561` for that, not because the vehicle
listens there.
*Check:* `sitl/scripts/entrypoint-ap.sh`, `examples/sitl/`, `sitl/README.md`.

**SITL suite results belong in GitHub Issues, not result-only PRs.**
*Wrong belief:* each live suite run should update repo-root `testing.md` and commit
`sitl/example-suite-results.json` so history lives in git.
*Fact:* those files are large, change every run, and trigger review bots without changing
product code. Each suite run closes the previous open GitHub Issue labeled `sitl-results`,
publishes the new curated PASS/PARTIAL/FAIL/SKIP table in a new `sitl-results` issue, and
does not open a results-only PR. Harness JSON defaults to `/tmp/`. In-tree `testing.md` is
only a pointer to that workflow.
*Check:* `sitl/AGENTS.md`, `testing.md`, `sitl/.gitignore`.

**ArduCopter takeoff examples set GUIDED before arm.**
*Wrong belief:* arm → GUIDED → takeoff is always safe on SITL, and a fire-and-forget
harness `SET_MODE GUIDED` before deploy is enough.
*Fact:* after a cold docker restart, armed `STABILIZE→GUIDED` often returns
`MAV_RESULT_DENIED` (resultCode 4) until GPS/EKF is ready, while GUIDED while
disarmed succeeds within seconds. Examples 01/02 chain GUIDED → arm → takeoff.
Harness prep `ap-guided-1` polls until HEARTBEAT `custom_mode === 4` (learned peer
endpoint required — pre-peer fallback sends never arrive) **and** a probe arm
succeeds (cold boot STATUSTEXT: `Need Position Estimate` / gyros inconsistent
for ~30–40 s), then force-disarms so the example’s arm step still runs. The prep
runner must invoke `node -e` via argv (not `bash -c` + `JSON.stringify`): bash
double-quotes leave literal `\\n`, the eval SyntaxError’d, and the old harness
ignored the exit code so GUIDED prep never ran. Measured against official
prebuilt
`firmware.ardupilot.org/Copter/stable-4.7.0/SITL_x86_64_linux_gnu/arducopter`
(`ARDUPILOT_REF=Copter-4.7.0` in `sitl/Dockerfile.ardupilot`).
*Check:* `examples/sitl/01-completion-takeoff.json`, `examples/sitl/02-completion-timeout.json`,
`sitl/run-example-suite.js`.

**SITL suite must docker-restart the vehicle fleet between examples.**
*Wrong belief:* post-example force-disarm (AP `COMPONENT_ARM_DISARM` with magic
`21196`, PX4 `commander disarm -f`) is enough isolation for the next takeoff /
arm example.
*Fact:* force-disarm leaves the SITL vehicle at the previous AGL (measured ~18 m
after example 01). ArduCopter then accepts arm + GUIDED but returns
`MAV_RESULT_DENIED` (resultCode 4) on `MAV_CMD_NAV_TAKEOFF` because the vehicle
is not on the ground. The harness `docker restart`s AP 1–5, PX4 11–15, and
companions 20/21 before each non-SKIP example (not `nrc-nodered`), waits for
GPS/EKF settle, re-applies PX4 lab helpers, and confirms GUIDED on AP-1 when the
example prep asks for it. That is the altitude reset; force-disarm cleanup was
removed as ineffective for this path.
*Check:* `sitl/run-example-suite.js` (`restartVehicleFleet`), `sitl/AGENTS.md`.

**Param set echo-confirm must use a live param id and the vehicle’s type.**
*Wrong belief:* example 13 can keep `ARMING_CHECK` as `MAV_PARAM_TYPE_REAL32` forever.
*Fact:* Copter-4.7.0 SITL (`stable-4.7.0` prebuilt above) answers `PARAM_ERROR` for
`ARMING_CHECK` (removed/renamed; the live bitmask is `ARMING_OPTIONS`). Integer params must
use `MAV_PARAM_TYPE_INT32` — a REAL32-typed set writes float bits and echo-confirm times
out. The suite spaces injects so `request-list` does not flood during the set wait.
*Check:* `examples/sitl/13-param-defs-live.json`, `lib/param/index.js` (`matchesParamEcho`).

**PX4 DO_SET_MODE on this SIH wants main_mode in param2, not the HEARTBEAT bitfield.**
*Wrong belief:* send `custom_mode=196608` (POSCTL packed) because that is what HEARTBEAT
reports and what many QGC builds send.
*Fact:* against the lab image
`px4io/px4-sitl@sha256:bab4270c4849b7027df4bd760c79d743d738c81d7830dde14c4cc5714f781216`,
`MAV_CMD_DO_SET_MODE` with param2=`196608` is `TEMPORARILY_REJECTED`; param2=`3` (PX4
main_mode POSCTL) is `ACCEPTED` and HEARTBEAT then reports `196608`. Completion-tier mode
match compares param2 to peer `flightMode`, so delivery=`complete` cannot succeed across
that encoding split — example 04 uses delivery=`confirm` for the PX4 leg. Re-measure if the
Compose digest changes.
*Check:* `examples/sitl/04-mode-tables.json`, `sitl/docker-compose.yml`.

**ArduPilot lab image downloads the official prebuilt SITL binary — it does not compile.**
*Wrong belief:* `sitl/Dockerfile.ardupilot` must `git clone` + `waf copter` (README once said
the AP image “compiles SITL”), so first bring-up is a long source build.
*Fact:* ArduPilot publishes a statically linked SITL binary at
`firmware.ardupilot.org/Copter/stable-4.7.0/SITL_x86_64_linux_gnu/arducopter` (~7 MB) for the
same Copter-4.7.0 line this lab pins. The Dockerfile is `FROM --platform=linux/amd64` (the
artifact is x86_64-only) and curls that binary plus
`Tools/autotest/default_params/copter.parm` from the matching git tag; the entrypoint passes
`--defaults copter.parm,ap-logging.parm`. Without the autotest defaults, ARM returns
`MAV_RESULT_DENIED` (resultCode 4) — `sim_vehicle` used to load them implicitly. Image build
is under a minute. More authoritative than a third-party image and far faster than compiling
in nested Docker. PX4 already used a prebuilt image; AP now matches that posture.
*Check:* `sitl/Dockerfile.ardupilot`, `node --test test/sitl/entrypoint-ap.test.js`.

**Vehicle Profile target defaults only reach the Connection runtime, not palette nodes.**
*Wrong belief:* setting `defaultTargetSystem = 42` in a Vehicle Profile propagates to every
palette node that addresses a target; nodes without an explicit config default to 1.
*Fact:* target resolution follows the §6 role × tier matrix (payload.target → companion
derivation → node config → profile default), implemented once in `lib/addressing`. The
Connection exposes its bound profile as a frozen public `node.vehicle` snapshot. Leaving the
editor's sysid/compid fields blank means "inherit"; saving an explicit 1 means exactly 1 — no
migration of existing flows. Command no longer reads `connection._vehicle`.
*Check:* `node --test test/addressing/resolve.test.js` plus the per-node suites — look for
"inherits Vehicle Profile target" tests.

**Build catalogs come from an explicit Dialect (or Vehicle Profile escape), not a silent default.**
*Wrong belief:* Build tier shows only a Vehicle Profile picker; an empty profile (or missing
catalog target) may fall through to `ardupilotmega`; the Build node is a special-case dialect
picker while senders always bind a profile; Param/Mission never show Firmware because it is
always inherited.
*Fact:* §6 Build column is Dialect (bundled list + `from Vehicle Profile…`) for Build, Command,
Move, Param, Payload, Mission, and Swarm-when-catalog-without-connection. Vehicle Profile is
visible only for that escape; empty dialect or empty escape-vehicle is editor-invalid — no
auto-pick, no silent `ardupilotmega`, and no inventing `__vehicle` from a leftover vehicle id
(pre-1.0: no flow migration). Param/Mission Build require Firmware when not using a profile
(Vehicle Profile XOR dialect+firmware). Wire tiers still hide Dialect/Vehicle/Firmware and use
the Connection's profile. Companion send-as and hidden-is-not-honored are unchanged. Binary
`FALSE=0`/`TRUE=1` enums render true/false only when both entries carry those wire values
(bare name strings are not synthesized to 0/1); other bitmasks stay multi-select. ArduPilot
parameter definition URLs stay family-keyed (Vehicle Profile); dialect-only Param Build does
not invent a family from a MAVLink dialect name.
*Check:* editor HTML suites for dialect/`__vehicle`/firmware visibility and invalid empty;
`node --test test/addressing/resolve.test.js` plus per-node suites — "companion", "role × tier",
"build+list", no silent dialect default. Spec record:
`docs/superpowers/specs/2026-07-29-build-tier-dialect-picker-design.md`.

**Status records are not stamped, and action nodes do not refuse them on input.**
*Wrong belief:* Every output-1 record needs `__mavlinkStatusRecord__` (or `_mavlinkStatus` in
`msg.payload`) so the next action node can detect a miswire and refuse to run — "both ports
look identical, so engineer against the mistake."
*Fact:* Silence on output 0 already stops the chain on failure. A stamp/refusal path is
guardrail for bad wiring, not protocol. Status records are plain objects on output 1 (root
fields such as `result` / `detail`). The only suppress sentinel is `msg.payload === false`.
Catch uses `done(err)` when available — not `node.error` then bare `done()`.
Palette category is lowercase `'mavlink'` for every palette node; State declares `outputs: 2`.
*Check:* `rg -n '__mavlinkStatusRecord__|_mavlinkStatus|refuseIfStatus|isStatusRecord' lib nodes`
returns nothing; `node --test test/delivery/delivery.test.js test/command/node.test.js
test/move/node.test.js test/payload/node.test.js test/state/node.test.js`.

**Input-handler Catch is `done(err)`, not `node.error` + bare `done()`.**
*Wrong belief:* Calling `node.error(err, msg)` then `done()` (no argument) is the safe way to
both notify Catch and finish the message.
*Fact:* `done(err)` is the single Catch path. `node.error` then bare `done()` pairs an error
report with a successful finish. Call `done(err)` directly — the runtime always supplies `done`.
A throw that escapes the handler is contained by Node-RED (§2) but is not the preferred path —
catch and `done(err)`.
*Check:* `node --test test/delivery/catch-path-scan.test.js` (source scan of `nodes/mavlink-*.js`);
`node --test test/delivery/delivery.test.js test/swarm/node.test.js`.

**Param encoding follows override → capabilities → known firmware, not invented ArduPilot.**
*Wrong belief:* `firmware === 'px4'` is the only signal for bytewise int/float union encoding;
peer `AUTOPILOT_VERSION.capabilities` is stored for display and unused at send time; and when
firmware is also absent the encoder may assume ArduPilot/C-cast.
*Fact:* Spec bits are `MAV_PROTOCOL_CAPABILITY_PARAM_ENCODE_BYTEWISE` (16) and
`…_PARAM_ENCODE_C_CAST` (131072). Resolution is explicit `msg.payload.paramEncoding` → those
capability bits → named firmware (PX4 → bytewise, else C-cast). A present-but-invalid override
rejects rather than falling through. An empty ladder throws. Firmware for Param/Mission is
path-split, not a single `firstDefined` that can prefer a hidden profile: wire tiers and
Build-via-`__vehicle` use `firstDefined(payload.firmware, profile.firmware)`; Build with a
concrete dialect uses `firstDefined(payload.firmware, config.firmware)` and must not read
`profile.firmware` (hidden is not honored). Do not invent `'ardupilot'`. ArduPilot often omits
the C_CAST bit, so the named-firmware step remains required when capabilities are absent.
*Check:* `node --test test/param/param.test.js test/addressing/resolve.test.js` — look for
`resolveParamEncoding` / unresolved / firstDefined firmware tests.

**Target resolution is once; builders do not re-default; no hardcoded final `1`.**
*Wrong belief:* Move/Param/Payload need local (or shared) `normalizeTarget`; runtime must
re-parse uint8 ids; and when every field is blank `resolveActionTarget` invents `{1,1}`.
*Fact:* Matrix is payload → companion derivation → config → profile. Profile editor
defaults cover the common `1`. Builders use `input.target` directly. Ranges are
`RED.mavlink.validateUint8` in the editor. Flow `msg` is programmer-trusted.
*Check:* `node --test test/addressing/resolve.test.js test/move/move.test.js
test/param/param.test.js`; no `normalizeTarget` / `parseUint8` under `lib/` or `nodes/`.

**Unresolved target → broken encode beats inventing drone 1.**
*Wrong belief:* When Build leaves Vehicle Profile and target fields blank, the resolver (or a
downstream `numberOr(..., 1)`) must invent `{sysid: 1, compid: 1}` so a message always
"works"; emitting `NaN` (or letting the uint8 codec reject a non-finite id) is a regression.
*Fact:* Inventing `{1,1}` can arm/move the wrong airframe on a busy link. An empty ladder
yielding non-finite ids fails at encode (`lib/codec/numeric` rejects non-finite integers) or
leaves an unusable Build object — safer than a silent command to system 1. On Build with a
concrete dialect there is no profile inherit rung at all — targets must be stamped or stay
unresolved. Companion compid `1` and swarm broadcast `{sysid: 0, compid: 1}` remain
matrix/spec addresses, not null-guards. Do not reintroduce target→`1` fallbacks in builders or
stream-stop helpers.
*Check:* `rg -n 'numberOr\\([^,]+,\\s*1\\)|firstDefined\\([^)]*,\\s*1\\)' lib nodes` — only
companion derivation in `lib/addressing/resolve.js` should remain; `node --test
test/addressing/resolve.test.js test/move/move.test.js`.

**PX4 example GCS bind is 14560, not 14555.**
*Wrong belief:* dual-stack examples used bind `14555` as a neutral gap port between ArduPilot
instance 0 (`14550/14551`) and instance 1 (`14560`).
*Fact:* ArduPilot `-I N` defaults occupy `14550 + 10×N`, so `14555` sits inside that band and
confuses operators. Lab and examples use PX4 GCS **14560→14561**, companions **14540/14542**.
Operator guide: [`sitl/README.md`](sitl/README.md).
*Check:* `rg '14555' examples` is empty; `examples/sitl/10-dual-stack-ten.json` bindPort 14560.

**Shared editor helpers are one resource file, and the Build-tier picker glue is one shared API.**
*Wrong belief:* every node's `.html` must inline its own copy of `RED.mavlink.*` helpers (enum
fills, dialect select, `currentCatalogQuery`, `validateUint8`, …), its own `resolveCatalogTarget`
+ dialect/vehicle/firmware `defaults.validate` blocks, its own `reloadTargetCompId` thin wrapper
over `reloadCompIdSelect`, its own resolve→cache→getJSON→seq-guard catalog loader skeleton,
its own `PAYLOAD_VERBS` + `refreshVerbOptions`, its own bitmaskTitle/booleanEntryLabel/
selectedBitmaskValues trio, its own select title-sync / `#N (not in dialect)` sentinel, its own
`refreshIdentitySelect` wrapper, its own `BAND_OPTIONS` table, its own `NAME (value)` label
concat, its own companion target-hiding `if (!isBuild) { identityRole… }` block, and its own
Build-tier dialect/vehicle/firmware/connection row toggles, because Node-RED loads external
`<script src>` asynchronously so helpers might be undefined when a later node's
`registerType` parses — or because each dialog's coalesce/`onKey` / Payload-compid
exception and remaining role/mode rows make the shared implementations "not quite the same."
*Fact:* The helpers live once in [`resources/mavlink-editor.js`](resources/mavlink-editor.js),
served at `resources/@cmc0619/node-red-contrib-mavlink/mavlink-editor.js` and loaded by a relative
`<script src>` at the top of `mavlink-local-identity.html` (listed first in `package.json`
`node-red.nodes` so its resource tag leads the module). Node-RED's `appendConfig` defers every inline node
`<script>` until each module's relative-`src` scripts have fired `onload`, so `RED.mavlink.*` is
defined before any `registerType` runs — no async race. The catalog source matrix is one function,
`RED.mavlink.resolveCatalogTarget({ isBuild? })` (Build → Dialect/`__vehicle`; wire → connection
profile; empty → `{key:'empty', query:null}`, never `ardupilotmega`); the catalog fetch skeleton
is `RED.mavlink.loadCatalog(endpoint, cache, cb, opts)` (caller-owned `{byKey, seq}` bag for
the helper; optional `inflight` enables same-key waiter coalesce for Command Advanced —
Greptile #36). Nodes paint from the catalog the loader hands the callback (or a
`_current*Catalog` handle set from that callback) — not from a sticky “last key” into
`byKey`. Target CompID
reload is `RED.mavlink.reloadTargetCompId(node, { field? })` (default `targetComponent`; Command
passes `field:'targetCompid'`); identity refresh is `RED.mavlink.refreshIdentitySelect(node,
{ rolesAllowed? })` (Swarm passes `['gcs','custom']`); catalog-backed selects share
`fillEnumSelect` plus `bindSelectTitleSync` / `ensureSavedEnumOption` (one `#N (not in dialect)`
wording — Build's old `(missing)` is gone) and `enumOptionLabel` for the §6 `NAME (value)` format
(browser mirror of `lib/metadata/commands-list.js`); queue-band pickers share
`BAND_OPTIONS` / `fillBandSelect` (Build + Out); companion target-row visibility is
`applyCompanionTargetVisibility({ isBuild, identityId, hideCompidWhenCompanion?, …Rows })`
(Command / Mission / Param / Move; Payload passes `hideCompidWhenCompanion:false`); the payload
verb catalog is `RED.mavlink.PAYLOAD_VERBS` + `RED.mavlink.refreshVerbOptions({ saved? })`
(mirrors `lib/payload`, used by Payload and Swarm); bitmask selects share `bitmaskTitle` /
`booleanEntryLabel` / `selectedBitmaskValues` (Command + Build); the Build-tier default
descriptors are `RED.mavlink.buildTierDialectDefaults({ modeField, withFirmware })`
(`modeField:'tier'` for Build, `withFirmware:true` for Param/Mission); the Build-tier row
visibility matrix is `RED.mavlink.applyBuildTierRowVisibility({ isBuild, dialect, dialectRow,
vehicleRow, firmwareRow?, connectionRow })` (dialect on Build; vehicle on Build+`__vehicle`;
firmware on Build+concrete dialect; connection on wire). Each palette node merges the defaults
into `defaults` with `Object.assign`, calls the shared resolver, visibility helper, and catalog/reload
helpers — node-owned rows (identity, timeout, mode fields, verb fields, …) stay local. Swarm
passes its narrower Build+list case as the `isBuild` override to both the resolver and the
visibility helper. `resources` is in `package.json` `files`, and `resources/**/*.js` lints as a
browser script.
*Check:* `node --test test/nodes/mavlink-editor-resource.test.js`; `rg -n 'function resolveCatalogTarget'
nodes` returns nothing; `rg -n 'function reloadTargetCompId|function refreshIdentitySelect|function refreshVerbOptions|PAYLOAD_VERBS\s*=|BAND_OPTIONS\s*=|function bitmaskTitle|function sync(Msg|Cmd|Advanced|Type|Message)Title|\(missing\)|name \+ . \(.' nodes` returns nothing;
`rg -n 'loadCatalog|bindSelectTitleSync|refreshIdentitySelect|fillBandSelect|applyCompanionTargetVisibility|enumOptionLabel' nodes/mavlink-*.html`;
`rg -n 'applyBuildTierRowVisibility' nodes/mavlink-*.html` hits every Build-capable palette node;
`rg -n 'buildTierDialectDefaults' nodes/mavlink-*.html`.

**Build-tier enum catalogs must see the saved dialect before `/mavlink/dialects` returns.**
*Wrong belief:* calling `loadEnumsCatalog` at the start of `oneditprepare` is fine because the
node already has `node.dialect` (e.g. PX4's `development`); the select will catch up.
*Fact:* `currentCatalogQuery` / `resolveCatalogTarget` read `#node-input-dialect`'s live value.
An empty select on Build yields `{ }` → local empty enums → Target compid shows
`#190 (not in dialect)` even though the dialect exists in the seed. `populateDialectSelect`
pins the saved dialect onto the select **synchronously** before the dialects GET; builders
call `RED.mavlink.reloadCompIdSelect` after that pin and whenever the catalog source moves
(dialect, delivery tier, connection, or Build `__vehicle` profile). That helper sequences
overlapping `/mavlink/enums` responses and preserves an explicit blank ("(profile default)")
instead of resurrecting `node.targetComponent` via `||`. Do not pass a leftover Build
`node.dialect` as `opts.dialect` on wire tiers — that invents a catalog source the Connection
profile did not supply. `development` is the real PX4 dialect name (`FIRMWARE_DIALECT.px4`),
not a load failure.
*Check:* `node --test test/nodes/local-identity-html.test.js` (pin + reloadCompIdSelect);
open Param Build with dialect `development` — compid list includes `MAV_COMP_ID_MISSIONPLANNER`.

**Mission confirm without a Connection fails loud — it does not invent a Build plan.**
*Wrong belief:* `delivery === 'build' || !connNode` is a friendly preview when Confirm is
selected but no Connection is bound; syncing `isBuild` with that soft fallback is enough.
*Fact:* §9 / Command already treat a chosen wire tier with no Connection as misconfigured
(`invalid config`, status failed, no output-0 success). Mission matched that. §9's "falling
back to Build where no connection is set" is the **editor default-tier** preselection, not a
runtime invent. Restoring `config.delivery || 'build'` on Move (or any sender with an editor
default) is declined — greenfield, config-trust (AGENTS.md); no published pre-1.0 flow lacks
the field.
*Check:* `node --test test/mission/node.test.js`; Command's matching test in
`test/command/node.test.js`.

**A `PARAM_VALUE` echo is decoded by the vehicle's own `param_type` — the request's type only
encodes the outbound set.**
*Wrong belief:* the node knows the parameter's type because the operator configured it, so
`request.paramType || fields.param_type` is a sensible precedence for reading the echo.
*Fact:* `param_value` is encoded per the `param_type` carried in the same frame, so that field is
the only correct decode key. Measured live against ArduPilot (SITL example 13): a flow configured
`MAV_PARAM_TYPE_REAL32` set `ARMING_CHECK`, an integer parameter. The vehicle applied the set and
echoed bytewise with its own type (`INT16`); decoding those bits as `REAL32` yields the denormal
`1.401298464324817e-45` against an expected `1`, and the confirm tier reported `echo timeout` for
a set that had succeeded. Any integer parameter set through a `REAL32`-configured node on a
bytewise vehicle failed the same way. Tolerance follows the wire too: a float32-quantized echo
(`REAL32`, or anything c-cast) needs float32-precision comparison, while a bytewise integer echo
must compare exactly — past 2^24 consecutive integers collide under `Math.fround`, and a
tolerance there confirms a value the vehicle never stored.
*Check:* `node --test test/param/param.test.js`

**The raw codec does no unit conversion — degE7 scaling belongs only to the typed surfaces.**
This entry replaces one that argued the opposite ("degE7 encode must be value-blind: degrees
always scale ×1e7"), which shipped, broke `mavlink-in → mavlink-build`, and was reverted. Both
that entry and the older integer-pass-through hybrid it attacked were wrong, in mirror-image
ways, and the wrongness was the same each time: reasoning from half the picture.
*Wrong belief (round 1):* an integer given to a degE7 field is an already-scaled wire value, a
decimal is degrees — dispatch on integrality. (Silently mis-scaled decimals under the raw
doctrine, and made `lat: -35` mean −0.0000035° under the degrees doctrine — coherent under
neither.)
*Wrong belief (round 2):* since every mature encoder scales degrees unconditionally, the codec
should too. The citations (MAVSDK `action_impl.cpp`, QGC `MavCommandQueue.cc`, pymavlink call
sites, ArduPilot's LONG→INT converter) were all real — and all from **typed operator surfaces**,
the wrong comparison class for a raw builder.
*Fact:* every reference **raw** message layer is unit-blind — pymavlink's generated `*_send`
functions (no unit math in `mavgen_python.py`), node-mavlink's message classes (zero scaling in
`lib/`), MAVSDK's `mavlink_passthrough` (raw `mavlink_message_t`). Scaling lives one layer up,
exactly where #61/#52 put ours (command/swarm/payload/mission builders, ×1e7/×1e4 measured
against SITL). Locally decisive: `mavlink-in` emits raw wire fields (`extractFields` copies off
the node-mavlink instance, no codec decode), so a scaling Build cannot consume mavlink-in's own
output — the always-scale version rejected `lat: 473977420` from a received GLOBAL_POSITION_INT
as "does not fit int32". The codec's decode half (`decodeMessage`/`decodeField`) has **zero
production callers**; only its encode half is live, in mavlink-build.
*Check:* `node --test lib/codec/test/field.test.js` — pins raw pass-through both directions,
sentinel (`INT32_MAX`/`INT32_MIN`) transparency, and the degrees-looking-decimal error that
names the unit and the ×1e7 fix.

**An early error MISSION_ACK is the rejection, not a stale leftover.**
*Wrong belief:* a `MISSION_ACK` error arriving before all items were requested is safest ignored
as a stale ack from a prior transfer; only a post-delivery ack is this transfer's answer.
*Fact:* ArduPilot's `MissionItemProtocol.cpp` answers an oversized count with `NO_SPACE`, an
allocation failure with `ERROR`, and a competing GCS with `DENIED` — all directly after
`MISSION_COUNT`, before requesting a single item; that ack is the vehicle's only channel for the
rejection. MAVSDK's `process_mission_ack` has no phase gate (pinned by
`UploadMissionNackAreHandled`), and QGC's `PlanManager.cc` comments "We can get a MISSION_ACK
with an error at any time". Gating errors on delivery progress turns the most common rejection
into a full retry stall with the reason code discarded. Stale-ack protection lives in the
`mission_type` filter and subscription lifetime — the two mechanisms the ecosystem actually
deploys. The one code worth exempting is `INVALID_SEQUENCE` (ArduPilot mid-transfer noise on
lossy links, non-terminal on the vehicle side; QGC carries the same exemption), and a premature
`ACCEPTED` is a protocol *failure* everywhere (MAVSDK `ProtocolError`, QGC `VehicleAckError`) —
never a success, never ignored.
*Measured, not only read:* against ArduPilot 4.7.0 SITL, a `MISSION_COUNT` of 60000 was answered
with `MISSION_ACK type=4` (`NO_SPACE`) in **7 ms**, before a single `MISSION_REQUEST`. The control
— a valid count of 2 — produced `MISSION_REQUEST seq=0` in 2 ms, resent at ~1 s intervals, and
after 8 s of silence from the GCS the vehicle abandoned the transfer with `type=15`
(`OPERATION_CANCELLED`), matching `upload_timeout_ms = 8000`. Under the old phase gate the
`NO_SPACE` was dropped and the transfer stalled through the full count-retry ceiling before
failing with the vehicle's reason discarded.
*Check:* `node --test test/mission/upload.test.js`

**COMMAND_INT x/y has no *cross-fleet* keep-current sentinel — PX4 honors one, ArduPilot NAKs it.**
*Wrong belief (round 1):* per common.xml, NaN lat/lon should encode as `INT32_MAX` ("keep
current") in COMMAND_INT. *(Round 2, over-corrected: "no reference implements the sentinel at
all" — too strong, see below.)*
*Fact:* split by autopilot. **PX4's** receiver honors the paired form: `x == INT32_MAX && y ==
INT32_MAX` decodes to NaN/NaN ("ignore") — the first branch of its COMMAND_INT handler in
`mavlink_receiver.cpp`. **ArduPilot's** `location_from_command_t` runs `check_latlng` with no
sentinel branch — `INT32_MAX` reads as 214.7°, out of range, command NAK'd. MAVSDK cannot even
express unset x/y (bare `int32_t`, defaults 0) and QGC's equivalent path is latent UB
(`NaN * 1e7 → int32`). So the sentinel works on exactly half the fleet, only in the
both-fields-together form, and the cross-fleet way to say "keep current position" remains
COMMAND_LONG with NaN param5/6 — which is what the build-time rejection tells the operator.
*Check:* `node --test test/command/carrier.test.js test/command/carrier-resend.test.js`; PX4
branch: `src/modules/mavlink/mavlink_receiver.cpp`, COMMAND_INT handler, first condition.

**Local-frame COMMAND_INT x/y really is metres × 1e4 — PX4 implements it; ArduPilot refuses the
frame rather than reading it raw.**
*Wrong belief:* the common.xml `×1e4` local rule is dead documentation that nothing decodes, so
raw rounded metres is the interoperable choice. (Asserted here from source archaeology across
pymavlink/MAVSDK/QGC/ArduPilot — a survey that never covered PX4's decoder, which was the
deciding case. Recorded as a caution: absence of evidence in four codebases was treated as
evidence of absence, and one measurement overturned it.)
*Fact:* measured against both autopilots with one `COMMAND_INT`, identical `x`/`y`, only the
frame varied. **PX4** (`px4io/px4-sitl`, the digest pinned in `sitl/docker-compose.yml`) applies
the frame-dependent divisor exactly as specified — `MAV_FRAME_LOCAL_NED` `x=1234567` decodes to
`param5 = 123.4567` (÷1e4) while `MAV_FRAME_GLOBAL_INT` decodes the same input to `0.123457`
(÷1e7), both ACCEPTED, read back from PX4's own `vehicle_command` uORB topic. **ArduPilot
4.7.0** (official prebuilt `firmware.ardupilot.org/Copter/stable-4.7.0/SITL_x86_64_linux_gnu`)
does not scale local frames at all — it **denies** them for location-bearing commands, because
`mavlink_coordinate_frame_to_location_alt_frame` maps only the GLOBAL variants so
`location_from_command_t` returns false: `DO_SET_HOME` with `GLOBAL_INT` is ACCEPTED and sets
`HOME_POSITION` to the verbatim degE7 value, while the identical command with `LOCAL_NED` returns
`MAV_RESULT_DENIED` and leaves home unchanged.
Therefore scaling ×1e4 is strictly correct, not a trade-off: it fixes a real 1e4 error on PX4
(a local reposition to `x = 50` m currently arrives as 5 mm) and cannot regress ArduPilot, which
rejects the frame regardless of the value. There is no raw-metres consumer to preserve
compatibility with.
*Full frame matrix, later measured one frame at a time (same `x=1234567`, PX4, all ACCEPTED):*
÷1e4 (metres) — LOCAL_NED (1), LOCAL_ENU (4), LOCAL_OFFSET_NED (7), BODY_NED (8),
BODY_OFFSET_NED (9), BODY_FRD (12), LOCAL_FRD (20), LOCAL_FLU (21); ÷1e7 — GLOBAL_INT (5),
MISSION (2), and RESERVED_13 (13, via the fallthrough). Every `LOCAL_FRAMES` member is therefore
measured, none inferred, and the set is member-for-member identical to PX4's
`mavlink_receiver.cpp` COMMAND_INT chain — the only decoder implementing the rule. The
classification is code, not data, in every implementation (PX4 if-chain, ArduPilot switch, QGC
equality): MAVLink's XML carries no is-local attribute, so a static named table is the ecosystem
form, values frozen by MAVLink's no-renumbering rule (13's tombstone is the in-data proof).
Frame 13 stays *unclassified* here — metres pass through unscaled — deliberately not matching
PX4's ÷1e7 fallthrough, because either treatment invents semantics for a slot upstream deleted;
passthrough is the do-nothing default.
*Check (PX4):* `cd sitl && docker compose --profile sitl up -d px4-11`, send a local-frame
COMMAND_INT, then `docker exec nrc-px4-11 sh -lc 'cd /opt/px4 && ./bin/px4-listener
vehicle_command 1'`. Send **before** reading — `px4-listener` prints uORB's retained value on
start, so a listener launched first reports the previous command.
*Check (ArduPilot):* run the prebuilt SITL binary with
`--serial0 udpclient:127.0.0.1:14550`, send `DO_SET_HOME` as COMMAND_INT under each frame, and
read `HOME_POSITION` back.

**node-mavlink's `sign()` cannot carry the runtime's signing timestamp, and does not mark the
frame as signed.**
*Wrong belief:* `MavLinkProtocolV2#sign(frame, linkId, key, timestamp)` is the supported channel
for the runtime's per-stream signing timestamp — pass SigningState's precomputed value through
its `timestamp` parameter.
*Fact:* read from the dependency's source (`node-mavlink` `lib/mavlink.ts`): that parameter is a
**Unix-milliseconds clock reading**, converted internally via
`(timestamp − SIGNATURE_START_TIME) × 100` — so passing the runtime's already-converted 48-bit
10 µs units double-converts them, and omitting the parameter stamps `Date.now()`, which gives two
frames emitted in the same millisecond identical timestamps that a spec receiver rejects as
REPLAY. `sign()` also never sets the v2 `IFLAG_SIGNED` incompatibility bit, which lives in the
CRC'd header and must be set *before* `serialize()` writes it (node-mavlink's own `sendSigned()`
helper does exactly that; its `sign()` alone does not). Both facts are why `wire.js`'s
`signFrame()` bypasses `sign()`: it writes SigningState's timestamp into the signature block
directly and computes the HMAC once. A future "simplify back to the library call" change breaks
the timestamp path and the signed-header bit together.
*Check:* `node --test test/connection/wire-signing.test.js`

**Build `target_component` is a MAV_COMPONENT pulldown even though the XML has no `enum=`.**
*Wrong belief:* Build's field form only needs `spec.enum` from the message catalog — if the
dialect left `target_component` as a bare `uint8_t`, a number input is correct.
*Fact:* §6 lists target components among the things that are always dropdowns. Upstream leaves
`enum=` off those fields; every other palette node already uses `reloadCompIdSelect`. Build's
dynamic `target_component` field calls that same helper (numeric ids — the wire field has no
enum metadata, so `encodeMessage` cannot resolve `MAV_COMP_ID_*` names). The enum fetch must
also treat `#node-input-tier === 'build'` as Build tier (`currentCatalogQuery`); checking only
`#node-input-delivery` left Build on the wire-tier branch with an empty Connection and an empty
CompID list.
*Check:* `node --test test/nodes/build-html.test.js test/nodes/compid-enum-pulldowns-html.test.js
test/nodes/mavlink-editor-resource.test.js`

**Palette runtime nodes must not re-implement delivery badge / status helpers.**
*Wrong belief:* each action node can keep a local `cap()` / `badge24()` / `statusRecord()` /
`BADGE_MAX = 24` and hand-write `node.status({fill,shape,text})` matching §6 styles.
*Fact:* `lib/delivery` already owns `capBadge`, `makeStatusRecord`, `applyActionStatus`, and
`ACTION_BADGE_STYLES`. Local copies drifted (In double-capped; Vehicle/Connection hand-sliced;
Command used a raw `BAND_CONTROL = 2`). Move setpoint readers and Swarm's param merge belong in
`lib/move` / `lib/command.mergeParams` once.
*Check:* `rg -n 'BADGE_MAX\\s*=\\s*24|function cap\\(|function badge24|BAND_CONTROL\\s*=' nodes`
(expect no matches); `node --test test/move/from-config.test.js test/delivery/delivery.test.js`

**Admin dialect catalogs and role×tier resolution are shared modules, not pasted blocks.**
*Wrong belief:* each node that exposes a `?vehicle=` / `?dialect=` admin dropdown can keep its
own ~50-line route skeleton and its own Build/wire profile+identity resolution, and Command may
name its target fields `targetSysid` / `targetCompid` forever.
*Fact:* `lib/metadata/admin-catalog.registerDialectCatalogRoute` owns the Command/Build/Vehicle
catalog skeleton; `resolveCatalogSource({ soft: true })` covers Payload field-tips notices;
`lib/addressing.resolveDeliveryContext` + `missingConnectionGate` own role×tier + the
send-without-connection deploy badge; `dialectFromConnection` owns the profile `getDialect()`
hop. Command's editor fields are `targetSystem` / `targetComponent` like every other palette
node — pre-1.0 means canonical keys only, not leftover-key readers or editor “migrate” paths.
*Check:* `node --test test/metadata/admin-catalog.test.js test/addressing/delivery-context.test.js
test/command/commands-route.test.js test/nodes/command-html.test.js`; `rg -n 'targetSysid'
nodes/mavlink-command.html lib/addressing/delivery-context.js` (expect no matches).

**Pre-1.0 Command rename does not invent flow compat.**
*Wrong belief:* renaming an editor field requires `oneditprepare` copy + runtime
`firstDefined(..., config.targetSysid)` so old flows keep working.
*Fact:* pre-1.0, rewrite shipped assets when needed; do not say “migrate” and do not keep
dual readers. Editor leftover-key copy/delete and `resolveDeliveryContext` historical
fallbacks were removed. Example JSON updates are a separate afterthought
(`docs/superpowers/plans/2026-08-02-examples-afterthought-STASH.md`), not mixed into the
lib/runtime cleanup.
*Check:* `rg -n 'targetSysid|targetCompid' nodes/mavlink-command.html lib/addressing/delivery-context.js`
(expect no matches); `node --test test/addressing/delivery-context.test.js test/nodes/command-html.test.js`.

**Lib holdouts share one owner per concern.**
*Wrong belief:* peer-table may keep a private `endpointKey`, State may `JSON.stringify` fan-out
copies, fetch may regex `<include>` without stripping comments, queue may paste the best-item
scan twice, carrier may re-find commands by value, catalogs may map enum entries three ways, and
param may hardcode `MAV_PARAM_TYPE` beside codec `PARAM_TYPES`.
*Fact:* `lib/connection/endpoint-key` and `clone.deepCopy` (NaN-safe) are the shared copies;
`xml-catalog.extractIncludes` is the include walker (fetch does not re-export a shim);
`OutboundQueue._bestItem` feeds dequeue/peek; `lib/command/lookup.commandByValue` serves carrier
and payload; `commands-list` owns `nameValueLabel` + safe-integer `mapEnumEntries`; param
`PARAM_TYPE` is derived from codec `PARAM_TYPES` (numeric resolver stays in param — different
return shape than codec’s info+`fail()`). Declined as non-dupes: `numberOr`/`valueOr`/`keepParam`
family, GLOBAL_FRAMES/DEG_E7 tables, TCP/serial write-drain skeleton.
*Check:* `node --test test/connection/queue.test.js test/state/state.test.js test/command/lookup.test.js
test/metadata/commands-list.test.js test/param/ lib/codec/test/param-union.test.js`;
`rg -n 'function endpointKey|JSON\\.parse\\(JSON\\.stringify|function extractIncludes'
lib/connection/peer-table.js lib/state lib/metadata/fetch.js` (expect no private copies).
