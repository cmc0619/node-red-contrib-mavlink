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
| `mavlink-vehicle` | Who is being addressed, in what dialect? Owns dialect selection — bundled or custom — the XML upload and download, and the catalog picker |
| `mavlink-connection` | How does traffic move, and stay channel-correct? Owns the transport (UDP, TCP, serial), the peer table, its bound Vehicle Profile, the outbound queue and its bands, signing switches and channel state, the default identity plus opt-in additional ones, and the disable switch |

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

**Dependencies.** `node-mavlink` for the wire protocol, `mavlink-mappings` for bundled
definitions, an XML parser, and `serialport` as an **optional** dependency lazy-loaded only
when a serial connection is used. UDP and TCP installs must load and pass tests without it;
selecting serial when it is absent gives a clear error, not a native module stack trace.

Both npm packages are already the ArduPilot line — install nothing else (§14).


## 4. Metadata — registry for bundled, XML for custom

**Do not vendor dialect XML.** Bundled dialects come from the `mavlink-mappings` package
(the ArduPilot line on npm). That package is the registry: message classes, `REGISTRY`,
enums, and CRC-extra tables. One loader merges modules in include order into a dialect
**bundle** — the same shape custom dialects produce after compile — so everything
downstream is identical code and custom dialects are not second-class.

**Bundled.** Ten dialects: common, minimal, standard, ardupilotmega, asluav, development,
icarous, storm32, uavionix, ualberta. Load them from `mavlink-mappings`; never ship copies
of their XML. Cache the assembled bundle per dialect name — bundles are immutable once
built, and a profile loads its dialect on every deploy.

**What the registry drops, and how to recover it.** The compiled JS keeps wire types and
drops the field→enum association (`enum=` on `<field>`). The package's shipped `.d.ts`
files retain it as property types (`type: MavType`) and carry message/field/enum/command
descriptions as JSDoc. Parse those declarations offline — no XML fetch — to recover enum
dropdowns and editor help for bundled dialects. Measured: that recovers message-field enums
and labeled command-param help; it does **not** recover param-level `enum=` links (e.g.
`MAV_CMD_DO_CHANGE_SPEED` param 1 → `SPEED_TYPE`). Those are a small, explicit control-hint
table for the cases the UI needs, not a reason to vendor XML.

**Custom.** Upload the full include chain. No resolution against bundled definitions — the
user provides every file the graph references. Compile from XML, resolve includes in
dependency order, reconcile, display. Same bundle shape as a registry load. Compile once at
upload; it is not a per-deploy cost.

**Remote fetch.** Pulling current official XML from GitHub is supported for *custom*
profiles and for comparing a downloaded snapshot against the installed registry dialect —
not as a substitute for the bundled path. Configuration happens on a bench with internet.
Make the source selectable — `mavlink/mavlink` or `ArduPilot/mavlink` — though as of now
they are byte-identical for `ardupilotmega.xml`, so neither is privileged. Pin the ref to a
commit before downloading, record that commit, and follow includes at download time so a
snapshot is self-contained.

Fail loud on custom compile: missing include, cyclic include, msgid collision between two
files defining different messages. Redefinition of the same message is an override, resolved
by include order, and shown as a diff against the same-named bundled dialect.

Never assume a dialect includes `common.xml`. Some define their own base set.

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
  passes through untouched; an absent field is left absent rather than zero-filled.
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
are limited to units and range. The dialog stays compact.

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
validity badges, availability — recomputes on every redeploy, not only first load.

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

- Passphrases live in Node-RED encrypted credentials only. Never in exported flow JSON, never
  in logs, never echoed back to the editor.
- Sign-outbound enabled without a passphrase **fails the connection closed**. It does not
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
to another on failure — the spec's own recommendation — rather than alternating between them.

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

Failures also call `node.error()` so Catch nodes keep working. That is independent of the ports.

Mission and Param conform: their progress updates are status records, not a separate port.

### What triggers an action node

A node fires on message arrival, as everything in Node-RED does. Requiring a specific trigger
value would break the commonest flow there is — an inject node wired straight to a Command node,
whose default payload is a timestamp. Two exceptions, both narrow:

- **`msg.payload === false` suppresses.** The node does nothing and emits nothing, which gives a
  `switch` upstream an explicit way to hold a chain without inventing a convention.
- **A status record is refused.** Every record leaving output 1 carries a marker; an action node
  receiving one emits a status record naming the miswire and does not act. Both ports look
  identical on the canvas, so wiring status into the next action node is the mistake worth
  engineering against — it would otherwise advance the chain on failures.

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
| `NAV_TAKEOFF` | relative altitude reaches the commanded altitude, within tolerance |
| `NAV_LAND`, `NAV_RETURN_TO_LAUNCH` | landed state reports on-ground |
| `DO_SET_MODE` | active mode matches the requested mode |

The node already holds the param, so it already holds the threshold. Commands with no
meaningful completion state do not offer the tier — the dropdown stops at confirm.

Every completion wait carries a timeout. A vehicle that accepts a takeoff and never climbs must
not hang the flow — the wait ends, Continue does not fire, and the status record names the
timeout.

With this, the chain is `Arm → Takeoff → Move`, three nodes, each set to await completion.

### Coordinate frames

Three rules, each of which encodes a wrong message if missed:

- **Wire lat/lon are `degE7` integers** — degrees × 10⁷ in an `int32`, not floats. The metadata
  declares it; the conversion is the codec's (§5). A raw float in that field is off by seven
  orders of magnitude.
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
answering about a different type is a mismatch, not a mission.

**Upload.** `MISSION_COUNT` → the vehicle requests items by sequence → send each → `MISSION_ACK`.
**The vehicle chooses the order**, and it may re-request an item it already received; answer
whatever it asks for rather than assuming a walk from zero. Answer each request in the item
format it asked for — a `MISSION_REQUEST_INT` is not satisfied by a `MISSION_ITEM`.

**Clear.** `MISSION_CLEAR_ALL` → `MISSION_ACK`. This one is destructive and gets a confirmation
gate.

Rules across all three:

- **A failed upload fails.** It must never degrade into a clear. A vehicle left with a partial
  mission is recoverable; one silently emptied is not.
- **Retry per item, with a ceiling**, then abort the whole transfer with the sequence number
  that stalled. A transfer that hangs forever is worse than one that fails.
- **Item validation is per type.** Mission items accept `MAV_CMD_NAV_*` navigation commands
  plus the `CONDITION_*` / `DO_*` commands that real plans embed (`DO_JUMP`,
  `CONDITION_DELAY`, …) while rejecting fence and rally command ids; fence items are only
  `MAV_CMD_NAV_FENCE_*`; rally is only `MAV_CMD_NAV_RALLY_POINT`. Three validators, not one
  with a flag.
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
- **Parameter types** — PX4 uses an int/float union in the parameter slot. Reinterpret the bit
  pattern; do not cast numerically, or the parameter is corrupted on the vehicle.
- **Command support** — not every `MAV_CMD` is implemented by both stacks.

Custom means: use the compiled dialect, offer no firmware-specific behavior, and do not pretend
to know the mode table.

## 12. Build order

1. **Metadata pipeline.** Registry load from `mavlink-mappings` (bundled), `.d.ts` metadata
   recovery, custom XML compile with include resolution, the shared bundle shape. Nothing else
   is buildable until enumeration works.
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
| **Custom dialect upload in the Vehicle editor** | open | Compile/fetch exist; the UI still says upload is not implemented. In progress on branch. |
| **Command node `COMMAND_INT`** | open | Presets/advanced send `COMMAND_LONG`; `COMMAND_INT_ONLY` fails with “not yet supported”. Build can emit INT. In progress on branch. |
| **DSCP socket marking** | open | Band→DSCP constants exist; no native `setsockopt` optional dep yet (§7). Queue behaviour does not depend on marks. In progress on branch. |
| **Param definition catalog** | **done** | `lib/param/defs.js` fetches `apm.pdef.json` from ArduPilot autotest or a custom URL; memory + disk cache; `GET /mavlink/param/defs?vehicle=` admin route; Param id becomes searchable datalist with description/unit/range; enum params show value datalist for Set. |
| **Full command-param `enum=` recovery** | **done** | All 85 common.xml `enum=` links recovered into `lib/metadata/hints.js` (commit 7a94795). |
| **Move editor §6 reshape** | open | Runtime OK; dialog still crams local/global fields on shared rows. |
| **Payload verb field completeness** | **done** | All runtime fields now wired into the editor: `streamId`, `statusFrequency`, `cameraId`, `sequence`, `shutter`, `trigger`, `stabilizeRoll/Pitch/Yaw`, `lat/lon/alt`, `flags`, `gimbalDeviceId`; visibility gated per topic/verb. |
| **`httpAdminRoot` on non-enum admin routes** | open | Enums use `adminApiUrl`; messages/commands/presets still absolute `/mavlink/…`. |
| **SITL example flows** | **done** | Examples 06–09: completion-tier takeoff chain, ArduPilot 5-vehicle sequential swarm, param read/set with defs notes, command+mission basics. |
| **SITL-backed tests (§13)** | open | Fixture suite only in CI; firmware behaviour needs the five+five rig. |
| **Cross-connection swarm** | out of scope | Explicitly out of scope this pass (§10). |

## 13. Testing and SITL

**The rig.** Five ArduPilot and five PX4 SITL instances at unique system IDs — ArduPilot 1–5,
PX4 11–15. The gap is deliberate: a mistyped sysid lands nowhere rather than on the wrong stack.
The two stacks sit on separate connections with one profile each, which is the arrangement the
design expects rather than a testing convenience. Five vehicles per connection is what exercises
the peer table, queue pacing, and swarm fan-out. Examples use one instance or five.

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

The gate is deliberately small: high-signal correctness rules only, no formatting, no style
churn. Rules here have to stay cheap to keep green, or the gate becomes something people work
around instead of something that catches defects. Every rule below earned its place by shipping
a bug without it.

| Rule | Setting | Why |
|---|---|---|
| `no-undef` | error | A deleted declaration or a missing `require` otherwise lints clean and fails only at runtime, on whichever rarely-exercised branch touches it first. This is the rule most worth having. |
| `no-unused-vars` | error | Catches dead imports and abandoned bindings — the residue of a refactor that half-happened. |
| `no-unreachable` | error | Code after a `return` or `throw` is either a mistake or a lie about control flow. |
| `no-bitwise` | error, **codec directory only** | The field codec builds masks arithmetically (§5). Banning the operators makes that a build failure rather than a review comment, in the bug class that historically cost the most rework. Runtime code elsewhere is unaffected. |

`no-unused-vars` needs four options, each for a reason:

- `caughtErrors: 'all'` — an unused catch binding is a swallowed error wearing a name.
- `ignoreRestSiblings: true` — rest-destructuring past keys deliberately omits them; those
  siblings are the mechanism, not dead code.
- `varsIgnorePattern: '^_'` and `argsIgnorePattern: '^_'` — an underscore prefix is the escape
  hatch for a genuinely unused parameter, so the rule never needs a disable comment.

Set `reportUnusedDisableDirectives: 'error'`. A disable comment for a rule that no longer fires
is itself stale, and stale suppressions are how a gate quietly stops gating.

**Scope: `lib/`, `nodes/`, `test/`, and the lint config itself.** Editor HTML inline scripts stay
out — linting them needs an HTML processor plugin, and their real exposure is a control the
runtime reads that the template never renders, which no linter can see. Editor-versus-runtime
drift tests cover that instead: source-level asserts that the template binds the right control
ids, loads the right admin endpoints, and contains the §6 rendering branches. Those are the
fixture form for editor HTML until a Node-RED editor harness exists; full jsdom simulation of
delayed AJAX / typedInput attach is not on the §13 pain-point list.

**Declare Node globals explicitly rather than importing the `globals` package.** The list is
short, it documents exactly what this codebase reaches for outside its own modules, and the gate
stays dependency-free. All `readonly` except `module` and `exports`.

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

**Command-param enum hints stay a small table until a complete recovery exists.** The 85
`<param enum=`> links in upstream XML are real, but regenerating all of them into the
bundled path without vendoring XML is a separate deliverable. Omitting a hint renders a
number field (wrong for that param) — prefer adding the one you need over inventing a
second metadata pipeline. Do not treat "fill all 85 by hand in one PR" as the bar.

---

**Bundled dialects are the npm registry, not vendored XML.**
*Wrong belief:* §4 requires shipping copies of the ten dialect XML files under `dialects/`.
*Fact:* `mavlink-mappings` already ships the compiled registry (`REGISTRY`, enums, CRC-extra).
Vendoring XML duplicates what `npm install` provides, drifts from the locked package version,
and was the wrong first move. Custom dialects still compile from user-supplied XML; remote
fetch is for custom/compare, not for the bundled path.
*Check:* `npm pack mavlink-mappings --dry-run` — JS and `.d.ts` only; no `*.xml`.

**Message-field `enum=` is recoverable from the shipped `.d.ts`.**
*Wrong belief:* because the compiled JS drops field→enum links, bundled dropdowns need XML.
*Fact:* generated declarations type enum-backed fields with the enum class (`type: MavType`)
while plain fields use wire aliases (`customMode: uint32_t`). Parsing those property types
offline recovers the association. Proven in `node-red-contrib-mavlink-ai`
(`lib/dialects/field-enums.js`, `message-metadata.js`).
*Check:* `node -e "const fs=require('fs'),p=require('path'),d=p.dirname(require.resolve('mavlink-mappings')); console.log(fs.readFileSync(p.join(d,'lib/minimal.d.ts'),'utf8').match(/type: MavType/)!=null)"`

**Command-param `enum=` is in the XML, not in the registry package.**
*Wrong belief:* either every command-param dropdown must be hand-maintained, or the bundled
path must compile from vendored XML.
*Fact:* `<param enum="…">` exists in the XML (85 in `common.xml`), and the generated
`mavlink-mappings` `.d.ts` keeps the label/description but drops that enum link. Message-field
enums *are* recoverable from `.d.ts` property types. Command-param enums that the UI needs are
a small explicit control-hint table on top of the registry — not a reason to ship dialect XML.
*Check:* parse a bundled `.d.ts` for `MavCmd` / command class accessors; confirm param `enum=`
is absent there and present in upstream XML.

**Registry modules still need an include merge.**
*Wrong belief:* `require('mavlink-mappings').common` is a complete dialect.
*Fact:* the package keeps each XML file's own messages/enums in a separate module. Loading
`common` must merge `minimal` → `standard` → `common` (and likewise for every other dialect).
Unknown dialect fails loud — never silent-fallback to `common`.
*Check:* `node -e "const m=require('mavlink-mappings'); console.log(!!m.common.REGISTRY[0], Object.keys(m.minimal.REGISTRY||{}).slice(0,3))"`

**Params without `enum=` are scalars, not gaps.**
*Wrong belief:* 85 of 947 is poor coverage.
*Fact:* the rest are latitude, yaw, altitude, accept radius. `enum=` is the marker for
*categorical*; its absence means render a number field. Coverage is complete, not thin.

**`Empty` and `Reserved` as description text are the legacy `reserved="true"`.**
*Wrong belief:* unlabelled params need a fallback numbered grid.
*Fact:* 279 of 420 unlabelled params in `common.xml` carry `Empty`, `Empty.` or `Reserved` as
body text. Treat them as reserved and no numbered field survives anywhere.
*Check:* the four-case rule in §6.

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

**Mission-item validation is not NAV-only.**
*Wrong belief:* §9's shorthand "Mission items are `MAV_CMD_NAV_*`" means the mission validator
rejects every non-NAV command.
*Fact:* uploaded missions routinely contain `MAV_CMD_DO_*` and `MAV_CMD_CONDITION_*` (e.g.
`DO_JUMP`, `CONDITION_DELAY`) alongside navigation. The mission validator's real job is to
reject *fence* and *rally* command ids (and other out-of-family ids), not to strip DO/CONDITION
items. Fence and rally validators stay strict to their families.
*Check:* inspect any ArduPilot `.waypoints` / QGC plan with a jump or delay, or
`rg "DO_JUMP|CONDITION_DELAY" ` against a captured mission download.

**Missing Vehicle Profile must not invent a dialect catalog.**
*Wrong belief:* `GET /mavlink/command/commands?vehicle=<id>` can fall through to
`ardupilotmega` when `RED.nodes.getNode(id)` misses (editor open before Deploy).
*Fact:* the editor caches the response under `vehicle:<id>`. A silent default would pin the
wrong MAV_CMD list to that key. A miss returns 404 unless the request also names an
allow-listed bundled `?dialect=`; `custom` without a live profile is never served.
*Check:* `node --test test/command/commands-route.test.js`

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
rule skips installing that package's dependencies — so `/data/node_modules/node-red-contrib-mavlink`
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

**UDP, TCP, and serial ship on one Connection contract.**
*Wrong belief:* §12 meant UDP first, with TCP and serial as later follow-ups that can diverge.
*Fact:* All three share the driver-side shallow-write / drain contract (§7). Serial is an
optional `serialport` dependency lazy-loaded only when selected; UDP/TCP installs must work
without it. Deferring a transport after Connection lands creates a second integration pass
for peer-table endpoints and quiet-send codes — avoid that split.
*Check:* `node --test test/connection/transport-*.test.js`; Connection editor lists UDP/TCP/Serial
with no “(not yet)”.
