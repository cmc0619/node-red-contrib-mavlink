# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning is [SemVer](https://semver.org/spec/v2.0.0.html). Pre-1.0 means the
config-node shapes and message contracts may still change without a major bump.

## [0.5.1] "Nap of the earth" - 2026-08-25

### Added

- **Go to can aim at a height above the ground under the target.** The Move
  node's goto grows a third altitude reference, *Above terrain*, beside above
  home and MSL — `MAV_FRAME_GLOBAL_TERRAIN_ALT` (10) on the command path, its
  wire twin (11) on the streamed setpoint. We only pack the frame: the vehicle
  resolves the height from its own terrain data, and a vehicle without terrain
  data refuses the command loudly — we do not serve terrain tiles. ArduPilot
  only in practice; the editor withholds the option on a PX4 profile.

### Removed

- **The `msg.confirmed` safety gate.** Flight Termination
  (`DO_FLIGHTTERMINATION`) and broadcast position setpoints used to refuse to
  send unless the message carried `msg.confirmed === true` — or, on Fan-out,
  the node's Confirm checkbox was ticked. The gate, the escape hatch, and the
  checkbox are all gone: wiring the message is the decision, the same rule
  Mission Clear has followed since 0.4.0. **Flight Termination now sends
  whenever it is triggered**, so a flow that leaned on a missing
  `msg.confirmed` to hold it back no longer has that brake — gate it with the
  trigger instead (an inject you press, a `switch` upstream, `payload:false`
  to suppress). The editor Safety notice went with it — the preset name says
  what Flight Termination does — and a broadcast position setpoint is still
  the one that converges a fleet on one coordinate. `msg.confirmed` is now inert on every node, and a saved Fan-out
  `confirm` value is ignored.

- **The `profile-mismatch` peer event.** When a vehicle's HEARTBEAT declared a
  different autopilot than the bound Vehicle Profile, the peer table raised an
  advisory event. It changed nothing, corrected nothing, and arrived after the
  profile was already deployed — the operator could not act on it without a
  redeploy they would reach anyway. A saved State node that still lists
  `profile-mismatch` in its Events picks now reds in the editor — reopen it and
  re-pick (pre-1.0: no alias, no migration). Every other peer event, and the
  `autopilot` each component already reports in a snapshot, is unchanged.

### Fixed

- **Multicast loopback is no longer forced off on swarm links.** The UDP
  transport turned loopback off when joining a multicast group, which broke
  the main reason ArduPilot's `mcast:` exists — several tools on one host
  sharing a link: a locally-run SITL and Node-RED could never hear each
  other. The socket now keeps the OS default (on).
- **Our own echoed frames are no longer treated as peer traffic.** With
  loopback on, a swarm link returns every frame this connection transmits.
  Inbound frames stamped with one of the connection's own identities are now
  dropped silently, so the GCS never registers itself as a vehicle and In
  nodes never see their own commands echoed back. A companion sharing our
  system id under a different component id still counts as a real peer.
- **SITL example 22 no longer craters on deploy.** Its two mission nodes
  shipped with no `items` key at all — legal-looking, since blank means "items
  come from the payload" — but an Admin-API deploy keeps an omitted key
  absent, so the node's constructor read `undefined` and threw. The example now
  serializes the editor's own default, and a contract pin requires `items` on
  every shipped mission node so the class cannot regress again.

## [0.5.0] "Drive to final" - 2026-08-22

### Changed

- **Examples 14 / 28 / 29 are one peer-table story.** `examples/14-peer-events.json`
  now fans a State snapshot and a full-event State feed to debug panes *and*
  Dashboard 2.0 tables (optional `@flowfuse/node-red-dashboard`). Former
  `28-peer-table-inspector` and `29-peer-table-dashboard` are deleted; SITL
  numbering is untouched.

### Added

- **Five new payload verbs.** The payload node gains: camera **zoom**
  (`SET_CAMERA_ZOOM`, 531) and **focus** (`SET_CAMERA_FOCUS`, 532) — both were
  declined pre-1.0 and are now first-class, type an enum select defaulting to
  RANGE; a new **relay** topic with **set** (`DO_SET_RELAY`, 181) and
  **repeat** (`DO_REPEAT_RELAY`, 182), mirroring servo's two verbs because a
  relay is a distinct device; and a fourth gimbal-aim path,
  `GIMBAL_MANAGER_SET_ATTITUDE` (282), that adds roll to the pitch/yaw-only
  paths — enter roll/pitch/yaw in degrees and the recipe derives the wire's
  `q` quaternion, the angular-velocity triple NaN-defaulted to the "ignore"
  sentinel (issue-#87 parity). All ride the existing recipe engine: fields,
  labels, units and enums come from the dialect, so the editor form is
  generated, not hand-drawn. See DESIGN.md § "Payload topics".
- **Flight modes have names end-to-end.** One resolution ladder
  (`lib/vehicle/modes.js`), both directions: the vehicle's own
  `AVAILABLE_MODES` table — cached per peer component, requested explicitly
  via the command node's `request_message` preset, never speculatively — is
  the authority; beneath it the shipped hypothesis is the dialect's per-family
  mode enum for ArduPilot and a baked main/sub table for PX4 (measured
  2026-08-18 against PX4 1.18 SIH — the wire renumbered AUTO sub-modes vs the
  historical `px4_custom_mode.h`); an unresolved name is NaN (loud at the wire
  choke, never a silent mode 0) and an unresolved number simply stays a
  number. Outputs: State snapshots gain `modeName` beside `flightMode`, and
  `mode-changed` feed records gain `fromName`/`toName`, each only when the
  ladder resolves. Input: `msg.payload.mode = 'GUIDED'` on a Set Mode command
  resolves into the custom-mode params — decomposed main/sub for PX4, the
  number whole for everyone else — and sets param1's custom-mode-enabled bit;
  explicit numeric payload params keep winning. The editor's Set Mode dialog
  now offers a PX4 dropdown from the same table (drift-tested against the
  lib), saving the decomposed pair the wire wants; ArduPilot's dialog is
  unchanged. SITL example 41 exercises both stacks by name.
- **An unknown message id is a message, not silence.** A msgid that the bound
  dialect does not carry used to vanish inside the frame splitter — the one
  clue that diagnoses a dialect mismatch, dropped before anything could show
  it. It now surfaces as an <code>UNKNOWN_&lt;id&gt;</code> frame carrying the
  raw payload: the peer table counts the sender as alive, and the id is a
  searchable string instead of a wire-capture exercise. In nodes gate it behind
  a **Show unknown ids** checkbox, off by default — a diagnostic is not traffic
  a working flow asked for. The box adds unknowns *alongside* a message-name
  filter rather than being masked by it, since an id you have never seen cannot
  be typed into a whitelist. Unknown frames are structurally framed but
  CRC-unverifiable by construction (the checksum seed lives in the definition
  the dialect lacks) — the In help says so.



- **The peer table announces flight-dynamic transitions.** Six new State feed
  events — `armed-changed`, `mode-changed`, `landed-changed`, `gps-fix-changed`,
  `home-changed`, `sensor-health-changed` — fire when a held value actually
  changes, each carrying sysid/compid and from/to (`sensor-health-changed` adds
  the flipped-bit mask as `changed`; `home-changed` reports canonical
  degrees/metres). First observation is not a transition: nothing fires while
  the table is still filling in, so a feed subscribed to edges stays quiet at
  connect. Landed state comes from `EXTENDED_SYS_STATE`, which the table now
  ingests as its own aged section; the rest are computed from messages it
  already held. Pure observation — events never gate or modify anything — and
  opt-in: the editor's default event selection is unchanged.

- **Connections recover dropped links.** A transport that opened and later
  failed — serial device unplugged, TCP peer restarting, socket error, wedged
  write — redials itself from the bound config on a jittered exponential
  backoff (inside 1 s at first, doubling to a 30 s ceiling, forever; redeploy
  always wins because close cancels the pending attempt). The Connection badge
  shows a yellow `reconnecting` ring while the loop runs; heartbeats stop for
  the outage and resume with the link; and the peer table keeps sweeping so
  "vehicle lost" still fires on a dead link. Recovery resumes *live* traffic
  only: anything queued against the dead link is dropped at the moment the
  link returns, because its sender was already told it failed (ack waiters
  time out in seconds) — a vehicle must not act on an hour-old command whose
  flow reported `timed-out` an hour ago. Deploy-time
  behavior is unchanged: a transport that never once opened stays a loud
  terminal `error` — retrying a config that never worked would bury an editor
  mistake (wrong port, missing device) under an eternally yellow badge.

- **Move's primitive roster: Turn, Speed, and Offset-from-here.** The node's
  charter moved from "`SET_POSITION_TARGET_*`" to *where the vehicle goes and
  how it moves* (`DESIGN.md` §3, §9 "Move primitive roster"), and the roster is
  curated by one rule: a primitive earns its place by being emitted in the wild
  — QGC, MAVSDK, pymavlink — or by being the only way a supported vehicle family
  can do the thing.

  - **Turn** (`MAV_CMD_CONDITION_YAW`) exists because ArduPilot has no other
    working yaw. Both yaw fields Move already carried are measured inert on
    ArduCopter: `DO_REPOSITION`'s heading param is ignored outright, and a
    yaw-only setpoint stream *holds* heading rather than turning (§14 / #179).
    ArduPilot's own test suite yaws in guided through this command. Heading is
    editor-bounded to 0–360 because the vehicle answers `FAILED` outside it;
    direction defaults to the dialect's own "shortest direction"; `relative` is
    a strict boolean opt-in like `changeMode`. PX4 has no handler, so the action
    fails closed there and names the escape that works — Steer's yaw field.
  - **Speed** (`MAV_CMD_DO_CHANGE_SPEED`) is the guided speed change QGC offers
    beside goto. Airspeed / groundspeed / climb / descent from the dialect enum;
    blank speed and throttle send the spec's −1 "no change".
  - **Offset from here** — `MAV_FRAME_LOCAL_OFFSET_NED` (7) returns as Steer's
    third reference. It was swept out by #278 with the deprecated aliases and
    never weighed on its own: common.xml carries no successor for it, while the
    body frames we kept *are* superseded. It is what QGC sends for a guided
    altitude change on ArduPilot, and the **only** local frame ArduPlane accepts
    at all — World and Body do nothing on a fixed wing, silently. A blank axis is
    legal here and nowhere else, because a zero *offset* is no movement.

  Both new actions ride the existing `AckWaiter` and result vocabulary — one
  confirm path for every acked Move command, not one per action.

  - **Attitude** (`SET_ATTITUDE_TARGET`) is MAVSDK's offboard attitude path.
    Roll/pitch/yaw are entered in degrees and the node builds the quaternion —
    the same convert-once-at-encode rule as degE7 and radians. Presence drives
    `ATTITUDE_TARGET_TYPEMASK` exactly as it does on Steer. Its stream ends by
    going quiet, with no braking packet: zero thrust is a descent, not a stop,
    and both stacks watch for setpoint silence themselves (§9 ruling 1).
  - **Manual** (`MANUAL_CONTROL`) is QGroundControl's joystick path, the way
    ArduSub is flown, and one of the two ways an Antenna Tracker can be
    pointed. It is *not* how a Blimp moves, though this entry said so until the
    family read below. Sticks are
    −1..1 and scale to the wire's ±1000 once. Two things differ from every
    other action: it addresses a **system only** (the message has no target
    component, so that row is hidden), and **all four sticks are required** —
    blank is refused rather than centred or sent as the dialect's `INT16_MAX`
    "axis is invalid". Centring was never an option: ArduSub reads the thrust
    axis as 0..1000 with neutral *500*, so an axis helpfully centred at 0 would
    command full reverse thrust. The dialog says so on that axis specifically.

- **The Move dialog follows the vehicle, not just the firmware.** When the bound
  Vehicle Profile names an ArduPilot family, the Action list drops the actions
  that family has no handler for: an Antenna Tracker offers Attitude and Manual,
  a Blimp offers Go to, and **Turn appears only on Copter and Sub** — neither
  ArduPlane nor Rover implements `CONDITION_YAW` anywhere. These are all
  messages a vehicle *accepts* and then ignores, mostly without a NAK, so the
  dialog was the only place the difference could be shown. An `unknown` family,
  no profile, or a PX4 profile gates nothing: hiding requires knowledge, and the
  matrix is ArduPilot's per-vehicle dispatch rather than a fact about airframes.
  Withheld options are **hidden from new nodes and kept on saved ones** (§9
  ruling 6) — a node already holding one keeps it and reds at deploy with the
  reason, instead of being silently rewritten.

- **Steer collapses to one field on a Plane.** ArduPlane's local-setpoint
  handler returns immediately on any frame that is not `LOCAL_OFFSET_NED` and
  then reads only the vertical component, so World and Body are withheld from
  the Reference list and, on *Offset from here*, **Metres up** is the whole
  form — a guided altitude change, which is what QGroundControl offers a fixed
  wing beside goto. The collapse follows the Reference in force rather than the
  family, so a node that kept a saved World (ruling 6) still shows the fields
  that Reference would actually send.

- **Steer's field groups are disclosed by checkboxes** — Position, Velocity,
  Acceleration, Yaw. They reveal rows and **save nothing**: the type_mask still
  derives from which fields carry values, so this is the curated-easy path a
  preset dropdown would serve without re-growing a preset vocabulary. Clearing
  a box clears that group's fields, deliberately — a hidden field that still
  held a value would still be commanded, with nothing on screen to explain it.
  The boxes seed themselves from whichever groups already carry values, so an
  imported flow shows what it sends, and the acceleration triplet left the
  Advanced section to sit with the groups it belongs to.

- **Manual's buttons are ticked, not typed.** The wire field is a bare uint16
  bitmask the dialect never annotated — no enum to compile, only the positional
  rule "the lowest bit corresponds to Button 1" — so the dialog now renders
  sixteen numbered checkboxes over the same hidden config field. This removes
  the raw field's built-in trap: "button 3" is the value 4, and typing 3
  pressed buttons 1 and 2. Nothing else moves — the saved value, its
  validator, and `msg.payload.buttons` are unchanged, all-unchecked still
  saves blank, and the boxes carry numbers rather than names because what a
  button *does* is the vehicle's own configuration (ArduSub's
  `BTNn_FUNCTION`), not protocol. If upstream ever annotates the field, the
  upgrade path is compiled enum names over these generic labels.

- **`mavlink-health`: flow-asserted health with a TTL lease.** A flow can now
  vouch for an identity's health instead of the heartbeat running as a blind
  timer. `msg.payload = {health:'ok', ttl_s}` clears any fault and promises
  healthy for the lease length (the node's default when `ttl_s` is absent);
  renew before it lapses, or the Connection faults the identity on its own and
  reports `lease-expired` on the node's status output — the companion-failsafe
  posture, where a flow that has gone quiet reads as unhealthy rather than
  "still fine". `{health:'fatal'}` faults immediately and cancels the pending
  lease; a later `ok` resumes. A faulted identity's HEARTBEAT stops until the
  fault clears, which is the point: the vehicle's own companion-loss handling
  is the failsafe. The lease lives on the Connection, so redeploying the
  health node never clears a fault it did not own. The identity presets'
  `healthDriven` flag is gone — nothing ever read it, and this node is what it
  was reserved for.

### Fixed

- **Admin-deployed action nodes no longer send from identity `"undefined"`.**
  `resolveDeliveryContext` coerced a missing `identity` with `String()`, which
  is the override id `"undefined"` — Connection.send then threw on
  `identity.sysid` (SITL 40 Set GUIDED). Omitted now means the editor default
  (no override). Example 40 serializes `"identity": ""`.
- **SITL 40 waits 2 s after GUIDED before ARM.** Copter-4.7.0 answers FAILED
  (4) when ARM rides the GUIDED ACK in the same tick; example 20 hid the race
  because prep already sat in GUIDED.

- **A fan-out param set on ArduPilot no longer reports `unconfirmed` for a
  write that worked.** The replicator's echo matcher required the vehicle's
  echoed `param_type` to equal the one we sent. SITL wire capture (2026-08-18,
  Copter-4.7.0, PX4 control) shows ArduPilot ignores the declared type,
  c-casts the value, and echoes its *own* table type — so on any AP integer
  parameter the two never matched and every member reported `unconfirmed` on a
  correct store. The check is now conditioned on the resolved encoding. It
  stays on for bytewise (PX4), where a type mismatch really does mean the
  float's bit pattern was stored as a garbage integer, and it is written as
  "not proven c-cast" so an unresolved encoding keeps the gate rather than
  dropping it.

### Changed

- **ArduPilot has no Type field in the param dialog.** The declared
  `MAV_PARAM_TYPE` is read by nobody on that stack — not ArduPilot's firmware,
  not our encoder, decoder, or either echo matcher — and ArduPilot publishes no
  type for any parameter, so the dropdown asked a question with no discoverable
  right answer. The row is hidden on ArduPilot; the select keeps its saved value
  because the built `PARAM_SET` still needs a resolvable type on the wire. PX4
  is unchanged: it publishes a type for every parameter and states it.

- **A published param type is stated, not offered.** When the definition
  catalog documents a parameter's `MAV_PARAM_TYPE`, the Set dialog used to
  narrow the Type dropdown to that one option — a pulldown with one choice.
  The row now displays the published type as text ("INT32 (6) — published by
  the firmware") and hides the select, which stays in the DOM holding the
  value because it is still the field Node-RED saves. An undocumented
  parameter gets the full dropdown back, exactly as before.

- **The In node's badge names the message, nothing else.** The
  `<count> <MESSAGE>` badge dropped its delivered counter: at seven digits the
  count was 8 of the badge's 24 characters and actively truncated the name —
  the only half that told you anything. With the counter gone, the latched
  trailing write that existed to land the badge on the "true total" had no
  subject, so the whole flush-timer machinery went with it: a write suppressed
  by the four-per-second throttle is now simply dropped, and the badge path
  schedules no timers at all. The throttle itself is unchanged (#219's
  regression pin still holds).

### Fixed

- **Move never fills in a value you did not give it.** Blank fields used to
  resolve to a default: a blank altitude reference became above-home, a blank
  reference became World, a blank frame became `LOCAL_NED`, and a blank number
  took whatever fallback its call site named. Some of those were harmless and
  one was not — `msg.payload.altRef` overrides the editor, the operator's word
  is translated to a `MAV_FRAME` integer before the wire, and a typo'd `'MSL'`
  fell out the *otherwise* side into frame 3. At a site with home 400 m above
  sea level, a commanded 500 m MSL flew at 900 m MSL, with a clean `ACCEPTED`
  ack and nothing in any log to say the datum had been swapped.

  So Move refuses instead. A missing required input or a token outside its enum
  **throws**, naming the field and what was expected. The exception is a field
  whose *dialect* defines an encoding for "no change" — `DO_CHANGE_SPEED`'s −1,
  `CONDITION_YAW`'s 0 rate and shortest-direction, `DO_REPOSITION`'s default
  speed and ignored loiter radius, an empty button mask. Those are the wire's
  own word for "the operator left this alone", so a blank box is transmitted
  rather than filled in, and each is a named constant at its call site instead
  of an argument you have to trace. `time_boot_ms` is unaffected either way: it
  is the sender's own stamp, never operator intent.

  Every field the runtime now requires is required in the dialog too, so this
  is a red box while you configure rather than a failure after you deploy: all
  four Manual sticks, all three Attitude angles when any is filled (they share
  one ignore bit, so there is no encoding for "roll 10, yaw unsaid"), and every
  axis of a Steer group once one of them is filled — velocity and acceleration
  as well as position now, because under the derived type_mask a blank axis is
  a *commanded* zero rather than an absent one.

  One exemption survives, on measurement: on `LOCAL_OFFSET_NED` a blank
  position axis is a zero *offset*, which is no movement, so filling one axis
  stays legal there. That is the shape QGroundControl's guided altitude change
  sends and the only one ArduPlane reads.

- **Two recorded claims about ArduPilot's smaller vehicles were wrong**, and the
  Move roster was phased around one of them. Reading all six vehicles' GCS
  dispatch tables at source before building the family gate settled it (§14
  2026-08-14): `handle_manual_control_axes` is a virtual with an **empty body**
  and Blimp never overrides it, so sticks sent to a Blimp are decoded, counted
  as a ground-station heartbeat, and discarded — what Blimp actually implements
  is `DO_REPOSITION`. And "Blimp and Tracker implement neither setpoint message"
  held only for the two *position* setpoints: an Antenna Tracker handles
  `MANUAL_CONTROL` and `SET_ATTITUDE_TARGET`, so the empty surface planned for
  it would have been wrong. Blimp also advertises three setpoint messages in its
  `capabilities()` bitmask that it does not implement — a standing reason not to
  gate any future feature on an autopilot's self-reported capabilities.

- **The ack-timeout re-send is gated on per-command idempotency.** `AckWaiter`'s
  contract is explicit — pass `DEFAULT_MAX_RESENDS` *"only for a command
  affirmatively known to tolerate re-issue"* — because re-sending is premised on
  a lost command and a lost ack being indistinguishable. That premise is per
  *command*, and generalising Move's reposition confirm path to serve every
  acked action carried it somewhere it does not hold: a **relative**
  `CONDITION_YAW` is a delta, so a re-send after a lost ack turns the aircraft a
  second time. Relative turns now settle `unconfirmed` instead, which §9 already
  treats as a report rather than a failure. Absolute turns, speed changes and
  repositions are unchanged — re-issuing each lands the vehicle in the state it
  was already asked for. (Gitar, #303)

- Four hand-editable states that reported success while doing nothing useful,
  all found by the same editor-round-trip lens: `steer` × `stream` × `offset`
  (a repeating offset walks the vehicle instead of holding a target),
  `turn` / `speed` × `stream` (a MAV_CMD sent once and reported as a stream),
  and `attitude` / `manual` × `confirm` (waiting for an acknowledgement that no
  setpoint ever sends). Each now gets a deploy-time verdict naming the working
  alternative — the confirm rule is stated once for every unacked action rather
  than a fourth special case.

- **`mavlink-in` changed-only compared timestamps**, so any message carrying
  `time_boot_ms` differed on every frame and the filter silently delivered the
  whole stream (#300). The messages it broke were exactly the ones the feature
  exists for — `ATTITUDE`, `GLOBAL_POSITION_INT`, `GPS_RAW_INT`. Blank now
  compares every field *except* the four timestamp spellings; naming one in
  **Compare fields** still compares it verbatim.

## [0.4.0] - 2026-08-12

### Removed

- **Mission Clear's confirmation gate.** The `confirmClear` checkbox and the
  `msg.confirmed === true` escape are gone: selecting the Clear operation in
  the editor is the confirmation (owner ruling, 2026-08-13). The `unconfirmed`
  phase disappears from Mission's vocabulary with it; the destructive guard
  that stays is the empty-upload refusal, so an upload still can never degrade
  into an accidental clear. Repo examples updated in place (pre-1.0, no
  migrations).

- **The guardrail audit's runtime cuts — the driver trusts its callers
  everywhere now, not just on the motion paths.** A full sweep of every node
  family found and removed the refusals that vetted trusted input or
  duplicated an editor validator:
  - Mission no longer refuses a mission type the profile's firmware does not
    list — the request goes to the wire and the vehicle answers
    (`MAV_MISSION_UNSUPPORTED`, or the transfer deadline). The firmware
    support table is the editor dropdown's, and only the editor's.
  - Formation no longer validates `msg.payload` heading, pitch, anchor,
    spacing, or sysid entries — they coerce with `Number()` like every other
    trusted value. Fan-out's concurrency clamp and both nodes' second copies
    of editor defaults are gone with them.
  - Payload accepts an explicit `NaN` slot value — the spec's own "not used"
    sentinel, which its recipes already defaulted to — and an unknown carrier
    token builds `COMMAND_LONG`, the same coercion the Command node applies.
  - The codec's BigInt pre-range check is gone; the Buffer write already
    fails loud on overflow. The UDP transport's half-configured-destination
    error is gone; the editor now refuses the half-pair at deploy instead
    (Remote host and port validate as a pair), and a destination-less send
    stays a quiet drop.

### Added

- **Setpoints carry a real `time_boot_ms`.** Move stamps a shared boot clock
  (process start = boot, monotonic via performance.now) instead of `0`: builds without an explicit
  `timeBootMs` take the clock, stream ticks re-stamp at every send, and the
  synthesized brake packet stamps its own send time rather than inheriting
  the stream's build-time stamp. An explicit caller `timeBootMs` still rides
  through untouched.
- **Mission's Items box is a textarea.** A mission is a list, not a line —
  the Upload items JSON now edits in a resizable multi-line box.
- **Three editor validators, each covering a silent failure.** Formation's
  confirm timeout requires an integer ≥ 1 (a saved 0 armed the ack wait at
  0 ms and reported every member unconfirmed); `mavlink-in`'s component filter
  gets the same 0–255 check its system filter had (an out-of-range compid
  silently matched nothing); the Connection editor pairs Remote host and port
  (both or neither).

- **The runtime stops second-guessing its inputs — breaking for flows that
  relied on being refused.** The driver (`lib/**`, `nodes/*.js`) coerces what
  it is handed and sends it; the editor is the only layer that validates. What
  no longer throws: a blank or out-of-range coordinate on
  `msg.payload.position` (a blank encodes 0, and on an absolute frame that is
  the origin — null island globally, the EKF origin locally); a
  `msg.payload.rateHz` or `ttlMs` that is non-numeric, zero or negative (note
  that `setInterval` substitutes 1 ms for a delay it cannot represent, so a
  rate of 0 or NaN becomes a ~1000 Hz stream); and `speed`, `radius`,
  `changeMode` or `yawRate` on a streamed Go to, which the setpoint has no
  field to carry and now ignores. Firmware advisories (`advisoryFor`) are gone
  with them — the measurements behind them are kept in `DESIGN.md` §10/§14, and
  where operators hear about them is open in #285.

  The editor gained the checks that were worth keeping: Go to's lat/lon/alt are
  required and range-checked, Steer's north/east/up are all-or-nothing, Build's
  message must be one this dialect carries (not just non-blank), and Advanced
  mode's command cannot be blank.

### Added

- **Bitmask parameters edit as switches.** The param-definition catalog now
  parses `Bitmask` from all three published shapes (ArduPilot's `bit:Label`
  field text and JSON object, PX4's `bitmask` array and its XML mirror), and
  the Param editor's Value field renders a documented bitmask as a
  multi-select — `ARMING_CHECK` takes checks, not a sum computed by hand. The
  picker writes the sum through to the value box, which stays visible beside
  it: blank still defers to `msg.payload`, and bits that no metadata file
  lists survive picker changes untouched. Editor-only; the runtime is
  unchanged.

### Fixed

- **Example 11's Stop button stopped the circle.** It emitted a boolean `false`
  rather than `{action:"stop"}` — a Node-RED inject reads its payload from
  `props[0]`, and the legacy top-level fields are consulted only when `props[0]`
  carries no value of its own. The 0.2 s repeat also drove the flag that gates
  the ring, so a Stop was overwritten within 200 ms; the flag is set by a
  separate one-shot inject now and nothing on the repeating path writes it.
- **Orbit accepts its own spec sentinel.** `MAV_CMD_DO_ORBIT` documents NaN in
  param5/6 as "orbit where I am", and the preset was refusing exactly that.
  Blank centre and blank altitude now encode the sentinels. int32 cannot carry
  NaN, so the editor reds a blank centre on the COMMAND_INT carrier and names
  COMMAND_LONG as the fix.
- **Acceleration composes where the firmware names the mix.** `VelAccel` and
  `PosVelAccel` are real ArduPilot guided submodes, so velocity+acceleration
  and position+velocity+acceleration are modes now; the wire carries an
  independent ignore bit per group. Position+acceleration *without* velocity
  is the one mix with no named submode and no §14 measurement — it refuses
  loud in the editor and at derivation, because a setpoint carries no ack and
  a silently held position would be the only symptom.
- **Go To / Reposition is out of the Command node.** Move owns the goto (§6),
  so the preset is not offered — and the parameter rows, location rule, and
  altitude rule it left behind in the Command editor are gone with it. The
  library row survives as the `DO_REPOSITION` metadata `mavlink-formation`
  builds from. SITL examples 23 and 29 are Move goto nodes now, same wire.
- **Four SITL example paths in both READMEs.** They still named the pre-#270
  numbering, which was renumbered by restart class.
- **An unresolvable Connection says `no connection`, not `invalid config`.**
  The node status line reports what something outside the node said — the
  vehicle, the link, or another node, including by silence — never "your
  settings are wrong", which is the editor's job and shows as the red triangle.
  The `invalid` badge is struck from the vocabulary; `sending`, `ok`,
  `preview` and `error` are what is left.

## [0.3.0] "Move it" - 2026-08-12

The release Move stopped speaking MAVLink's vocabulary and started taking
intents — and the one where Command handed motion over to it.

### Changed

- **The identity row is labelled `Identity`.** It used to read *Send as* (or
  *Send-as* on Mission and Param), which now names the wire-message selector on
  Command, Payload and Formation — two rows, one label, in the same dialog.
  Label only: the `identity` config key and everything it addresses are
  unchanged.

- **`mavlink-move` surface redesign — breaking.** The carrier/mode/frame
  triple is gone; the node speaks intents. **Action** is `goto` (one-shot
  guided goto: Build/Send/Send & confirm ride `MAV_CMD_DO_REPOSITION`,
  Stream rides `SET_POSITION_TARGET_GLOBAL_INT`) or `steer` (setpoints; the
  type_mask derives from which field groups are filled — there is no mode
  pulldown). The only frame choices left are the ones that are choices: an
  altitude reference (above home / MSL) on goto, and world/body axes on
  steer, with the body frame derived from the vehicle profile's firmware
  (ArduPilot `BODY_OFFSET_NED`, PX4 `BODY_NED`) and refusing when firmware
  is unknown. `px4Compat` is deleted — global setpoint frames always
  transmit the `*_INT` twins. Terrain frames are off the surface until
  measured. The retired `msg.payload` keys (`carrier`, `mode`, `frame`,
  `px4Compat`) are not read — like any key Move does not speak, they are
  ignored, and the action-shaped overrides are what the node acts on.
- **`mavlink-command` sheds motion presets.** `yaw` and `rotate`
  (`CONDITION_YAW`) are deleted from the curated list — the raw command
  path keeps the capability, and PX4 never implemented the command. `Go To
  / Reposition` leaves the preset dropdown (Move owns the goto); its
  metadata row remains for `mavlink-formation`. The carrier selector is
  labelled **Send as** — the options are the literal wire messages.
- **The `carrier` config key is renamed `sendAs` — breaking.** On
  `mavlink-command`, `mavlink-payload`, and `mavlink-formation` (and
  `msg.payload.sendAs` for Payload's per-message override). The options are
  the literal wire messages (`COMMAND_INT`/`COMMAND_LONG`), matching the
  **Send as** label. No alias, no dual-read: a flow still carrying only
  `carrier` behaves as if no choice was saved — re-pick and redeploy. Batched
  into the release that already breaks Move's keys.

- **`mavlink-move` result vocabulary — breaking.** `succeeded` is gone: it
  meant both "put on the wire" (setpoints) and "the vehicle agreed"
  (reposition), and the double meaning let a silent run read as a success.
  Every result is now its own word, shared with `mavlink-command` where the
  meaning is shared: silent paths report `built`, `sent`, `streaming`,
  `stopped`, or `expired`; the reposition confirm path reports the ack outcome
  verbatim — `accepted`, the MAV_RESULT name for a refusal (`denied`,
  `command_int_only`, …), or `unconfirmed` for a lost ack (previously
  `timeout`). Stream expiry and stop now discriminate on `result` (`expired` /
  `stopped`), not `detail`. `failed` still means the input never took effect.

### Removed

- **`lib/move` sheds the retired frame vocabulary's parsing layer.** The
  deprecated `*_INT` aliases (names and numbers 5/6/11), string frame names,
  `LOCAL_OFFSET_NED`, and the terrain frames are deleted — unreachable since
  the Action surface, which derives only numeric frames (goto: 0/3, steer:
  1/8/9). The builders now validate a numeric frame against the derivable set
  and nothing else.

### Fixed

- **`mavlink-move`: the Body-on-Build gate never fired.** Steer's *body*
  reference derives its frame from the vehicle's firmware, so Body on the
  Build tier with a concrete dialect has no firmware to derive from — a node
  that deploys clean and then refuses every message. The editor validator
  added to red that combination was declared `function (v)`, and Node-RED
  only treats a returned string as an invalid *reason* when the validator
  takes two arguments; with one, the reason string is coerced with `!!`,
  comes out truthy, and the field passes. The gate has been reading as
  working and stopping nothing since it landed. Declared `(v, _opt)`, and the
  arity is now pinned by the test that covers it.

## [0.2.0] - 2026-08-11

Three weeks of transaction work: every node that waits for a vehicle now
retries, bounds its wait, and reports what the vehicle actually said. Several
changes alter observable behaviour — see **Changed** before upgrading.

### Added

- `mavlink-move`: a second carrier for one-shot goto — `carrier: reposition`
  sends `MAV_CMD_DO_REPOSITION` as `COMMAND_INT`, so a goto is **acknowledged**
  instead of fire-and-forget. Named frames, guarded coordinates, `CHANGE_MODE`
  as an explicit opt-in, and the Command node's ack machinery underneath.
  Measured accepted on both ArduPilot and PX4.
- `mavlink-move`: an explicit stream stop — `msg.payload = {action: 'stop'}`
  ends a setpoint stream without waiting out its TTL.
- `mavlink-payload`: camera `stop-photo`, so a capture started with an explicit
  count of 0 (continuous) can be stopped.
- `mavlink-payload`: an acknowledged gimbal-manager aim path
  (`DO_GIMBAL_MANAGER_PITCHYAW`) alongside the existing unconfirmed message.
- `mavlink-command`: the ack's `progress` and `result_param2` reach the status
  output instead of being discarded, and a long `IN_PROGRESS` moves the badge.
- `mavlink-command`: opt-in re-send on ack timeout, bounded so a periodic
  `IN_PROGRESS` cannot extend the deadline forever.
- `mavlink-param`: set re-send, reads that confirm what they read, and recovery
  when a collect loses frames mid-list.
- `mavlink-mission`: cancelling a transfer notifies the wire with a
  `MISSION_ACK` carrying `OPERATION_CANCELLED`, so the vehicle leaves the
  transfer instead of waiting out its own timeout.
- `mavlink-connection`: signing rejections surface instead of being counted
  silently, and outbound writes are bounded.
- `mavlink-build`: unknown field keys are named in an advisory warning rather
  than silently dropped — a misspelled field no longer builds a message
  missing it and reports success.

### Changed

- **`msg.trusted` from `mavlink-in` is now `undefined` on a plain unsigned
  link**, not `false`. `false` is reserved for frames admitted *despite* being
  untrusted (an allowlisted sender under require-signed, or accept-invalid
  recovery). Gate on `msg.trusted === false` to drop those; testing
  `!== true` now also rejects every frame on an unsigned link.
- **Untrusted frames no longer settle transactions.** Command, Move, Payload
  and Fan-out ack waits, the param echo and the mission machine all ignore
  frames explicitly marked untrusted.
- **A broadcast target (sysid 0) is refused on the ack-confirmed tiers** in
  Command, Move, Param and Mission — one ack cannot answer for a fleet. Use
  Send, or `mavlink-fanout`.
- `mavlink-move`: frame vocabulary is the modern set (0/3/10); a PX4-compat
  checkbox covers the older wire values.
- `mavlink-command`: a blank preset parameter stays blank rather than becoming
  0 on the wire — GCS parity.
- Signing: the first-contact freshness floor is no longer re-applied to an
  established stream; timestamp monotonicity already defeats replay there
  (pymavlink parity).
- `mavlink-fanout`: the selection-mode allowlist is gone — the flow author is
  trusted — but an unreadable selection is refused rather than partly applied.

### Fixed

- `mavlink-param`: a blank c-cast value sent a silent `0`, and an `undefined`
  confirmed itself before the echo was compared. Both refuse now.
- `mavlink-command`: preset coordinates are range-checked wherever a *global*
  location is present, including Takeoff and Land — an out-of-range latitude
  reached the wire as a valid-looking `COMMAND_INT`. Local frames are exempt:
  `param5`/`param6` there are metres, not degrees, so `±90`/`±180` does not
  apply to them.
- `mavlink-connection`: a peer with sysid 0 is no longer tracked; it walked
  into fan-out's `all` selection as a broadcast-shaped member.
- `mavlink-fanout`: duplicate targets in one selection are refused instead of
  merging last-wins.
- `mavlink-mission`: empty uploads and broadcast transfers are refused, and a
  throw while building the machine no longer wedges the target lock.
- Editor: a validator reads the live dialog only for the node whose dialog is
  open. Saving a config node validates its users while another node's dialog is
  on screen, so a closed node could be marked invalid against a field belonging
  to a different node — and the flag stuck until that node was reopened.
- Editor: gimbal-manager `flags` offers the whole bitmask on the acknowledged
  path, not a single choice.
- Editor: Command, Move and Build reject non-numeric and out-of-range values in
  the fields that reach the wire, rather than saving them for the runtime.

### Removed

- `mavlink-formation`: the unreachable `slotMap` option — dead since the commit
  that introduced it, with no payload path to it.
- The `sendConfirm` / `sendAwait` aliases, the `noDeprecation` toggle, and the
  fail-open guards and defaults that hid a misconfiguration instead of
  reporting it.

## [0.1.1] - 2026-08-08

### Changed

- `mavlink-in`: the message filter is a list — add a row per message. Handy for
  lumping a class of messages into one node, e.g. `GLOBAL_POSITION_INT`,
  `LOCAL_POSITION_NED`, `VFR_HUD`. An empty list still receives everything.
- `mavlink-param`: a completed build reports `succeeded`, matching the other
  nodes that report a task outcome.

### Fixed

- `mavlink-fanout`: a malformed sysid list is refused instead of quietly
  fanning out to whichever entries happened to parse.
- Editors reject non-numeric values in Command `timeout` and `max retries` and
  in Build `repeat`, rather than saving a field that reads as `NaN` at runtime.
- README lists `mavlink-formation` and the per-member fan-out offsets, and
  points at `examples/CATALOG.md` for the flows beyond the bundled selection.

## [0.1.0] - 2026-08-08

Initial release.
