# Move node: the curated primitive roster — implementation brief

**For the implementing LLM.** You cannot see the conversation that produced this. Everything
you need is here, in `DESIGN.md`, in `AGENTS.md`, and in the sources cited. Read `AGENTS.md`
and `DESIGN.md` §2/§6/§9 before writing anything — the driver/protector split governs every
line, and this repo deletes guardrails on sight.

**Evidence tiers used throughout** (this repo's epistemics, `AGENTS.md` "Measurement outranks
source"): **[§14]** = measured on SITL, recorded in `DESIGN.md` §14 — authority. **[source]** =
read in firmware/GCS source this week — strong hypothesis. **[wild]** = observed in ecosystem
code (QGC/MAVSDK/pymavlink call sites). **[verify]** = asserted from docs/memory; check before
building on it. Nothing ships on [verify]; unmeasured hazards stay off the surface
(the terrain-frame precedent, `DESIGN.md` § "Move Action surface").

---

## 0. Where the node stands today

Surface: **Action** (`goto` | `steer`) × **Delivery** (`build`/`send`/`confirm`/`stream`).

- `goto` → `MAV_CMD_DO_REPOSITION` (192) as `COMMAND_INT` on Build/Send/Confirm [§14 gate:
  CHANGE_MODE flag]; `SET_POSITION_TARGET_GLOBAL_INT` on Stream — byte-identical to MAVSDK's
  `send_position_global` (frame 6, type_mask 2552, executed and compared).
- `steer` → `SET_POSITION_TARGET_LOCAL_NED`; Reference picks the frame: World (1), Body
  (firmware-derived 9/8, fails closed), and — **in local commit `fb986a8`, unpushed, awaiting
  a second opinion** — Offset from here (7). Mode derives from filled field groups
  (`deriveSteerMode`); type_mask is code. Stream lock is one owner per (connection, target)
  (#176, `lib/delivery/lock.js`).
- `{action: 'stop'}` halts a stream and brakes (zero-velocity setpoint, [§14 #115]).

Baseline for this work: branch `claude/faildone-removal-impact-3hdmrn` at `fb986a8`. If that
commit was rejected by the second opinion, its findings below still hold — re-derive the
Offset reference from them.

## 1. The roster

The curation rule: **a primitive earns a row by being emitted in the wild (QGC, MAVSDK,
pymavlink) or by being the only way a supported vehicle family can do the thing.** Forward
entries (marked ⏩) are in the shipped seed and in firmware `master`, but no GCS emits them
yet.

| # | Action | Wire | In the wild | copter | plane | rover/boat | sub | blimp | Status |
|---|--------|------|-------------|--------|-------|------------|-----|-------|--------|
| 1 | **Go to** | DO_REPOSITION / COMMAND_INT | QGC guided goto, both stacks [source] | ✓ [§14] | ✓ [source] | [verify] | [verify] | — | **shipped** |
| 2 | **Steer** | SET_POSITION_TARGET_LOCAL_NED | MAVSDK offboard [source] | ✓ [§14] | frame 7 z-only [source] | pos/vel, no accel [source] | pos/vel + frame 12 [source] | — | **shipped + fb986a8** |
| 3 | **Attitude** | SET_ATTITUDE_TARGET (82) | MAVSDK Attitude/AttitudeRate [wild] | ✓ [verify: GUID_OPTIONS thrust semantics] | PX4 offboard ✓ [wild] | — | [verify] | — | **build next** |
| 4 | **Manual** | MANUAL_CONTROL (69) | QGC joystick ~25 Hz; **the ArduSub primary control path** [source] | ✓ | ✓ | ✓ | ✓ [source] | ✓ [verify] | **build next** |
| 5 | **Turn** | CONDITION_YAW (115) on AP; setpoint-yaw on PX4; ⏩ GUIDED_CHANGE_HEADING (43002) on plane | AP autotest `guided_achieve_heading` [source] | ✓ [source] | ⏩ [verify] | [verify] | ✓ [source] | — | **build** — closes a measured hole |
| 6 | **Speed** | DO_CHANGE_SPEED (178); ⏩ GUIDED_CHANGE_SPEED (43000) on plane | QGC `guidedModeChangeGroundSpeed` [source] | ✓ | ✓ | ✓ | [verify] | — | **build** |
| 7 | **Orbit** | DO_ORBIT (34) | QGC orbit UI + MAVSDK orbit plugin, **PX4 only** — no ArduPilot handler found [source] | PX4 only | PX4 only | — | — | — | **gate on PX4 profile; measure first** |

**Antenna Tracker:** no setpoint or manual handlers — the Move node hides entirely for that
family (it points, via Command).

**Why Turn is not optional.** The toolkit currently has **no working way to yaw an ArduPilot
copter**: DO_REPOSITION `param4` is ignored by ArduCopter (`set_destination(..., use_yaw=false)`,
[source 2026-08-12, recorded in DESIGN § "Move Action surface"]), and a yaw-only setpoint
stream measured as *heading held* on AP GUIDED ([§14 #179, mask 2559]). CONDITION_YAW is how
AP's own test suite yaws in guided. PX4 has no CONDITION_YAW handler [verify], so Turn derives
per firmware exactly like the Body reference: AP → CONDITION_YAW command (acked); PX4 →
yaw-bearing position setpoint at the current target; plane ⏩ 43002. Unknown firmware fails
closed with a named error (the `frameForReference` precedent, `lib/move/action.js`).

## 2. Deliberately not on the roster

Write these into the node help or DESIGN so no future sweep re-files them:

- **Takeoff / Land / RTL / mode changes** — Command's presets own vehicle *state*; Move owns
  *where and how it moves*. That boundary sentence goes in DESIGN §3.
- **Global velocity / global pos+vel** — both firmwares honour it (PX4
  `handle_message_set_position_target_global_int` decodes each component independently
  [source]; Rover/Sub honour global pos+vel [source]) but **nobody emits it** — MAVSDK's
  global setpoint is position+yaw only (mask 2552), QGC never sends the message at all.
  Declined on the one-way-parity rule. Revisit only if a rover "drive to lat/lon at speed"
  use case shows up with a §14 measurement.
- **FOLLOW_TARGET** — Formation's leader-follower (#200), not Move.
- **DO_SET_ROI_LOCATION** — already owned by Payload (`roi-set`/`roi-clear`,
  `lib/payload/index.js:163-179`), matching MAVSDK's gimbal-plugin placement. One
  implementation per concept: Move never grows a second one.
- **Force bit (512)** — measured unactuated on both stacks [§14]. Stays dead.
- **Terrain frames (10/11)** — datum unmeasured [§14]. Stays off until the rig says.
- **TRAJECTORY_REPRESENTATION_\*, SET_ACTUATOR_CONTROL_TARGET** — no GCS emits them;
  `mavlink-build` is the escape hatch for raw anything.

## 3. Editor design ("beautiful")

Three mechanisms, all with in-repo precedent:

1. **The Action select is rebuilt per vehicle family** — same pattern as
   `refreshReferenceOptions` rebuilding per firmware (fb986a8) and `DELIVERY_OPTIONS` per
   action. Family comes from `RED.mavlink.resolveCatalogTarget()` (`vehicleFamily`; values:
   `copter|plane|rover|boat|sub|blimp|antenna-tracker|unknown`; boat = rover firmware).
   `unknown` shows everything — hiding needs knowledge.
2. **Hide from new, red on saved** (the fb986a8 PX4-offset rule): an option the family can't
   use is not offered, but a node that already holds it keeps it visible and gets a deploy-time
   red naming the reason. Never silently rewrite a saved config.
3. **Group checkboxes on Steer** (owner-requested): ☑ Position ☐ Velocity ☐ Acceleration
   ☐ Yaw. A checked box *reveals* that group's rows; the type_mask still derives from which
   fields are *filled* — the checkboxes are disclosure, not state, and save nothing new to the
   config. Fresh node: Position only. This is the curated-easy path the -ai preset dropdown
   served, without re-growing a preset vocabulary.

Per-family surface after hiding:

| family | actions offered |
|---|---|
| copter | Go to, Steer, Attitude, Manual, Turn, Speed (+ Orbit if PX4) |
| plane | Go to, Steer (Offset only — the one frame ArduPlane accepts, z-only [source]), Attitude (PX4 offboard), Manual, Turn ⏩, Speed |
| rover/boat | Go to [verify], Steer (no accel groups), Manual, Turn [verify], Speed |
| sub | Steer, **Manual (the headline)**, Turn, Go to [verify] |
| blimp | Manual [verify] |
| antenna-tracker | *(node hidden / empty-state text)* |
| unknown | everything, nothing hidden |

## 4. Per-primitive specs

### Attitude (new)
- **Fields:** roll/pitch/yaw (deg) → `q[4]` built here — convert exactly once at encode, the
  degE7/radians rule; body roll/pitch/yaw rates (deg/s → rad/s); thrust 0–1 (and
  `thrust_body[3]` only via payload, it's an extension). Presence drives `type_mask`
  (`ATTITUDE_TARGET_TYPEMASK`: attitude ignore 128, rate ignores 1/2/4, throttle ignore 64) —
  "filling fields IS the mode" transfers intact.
- **Delivery:** Build / Send / Stream. No Confirm (no ack). PX4 actuates in OFFBOARD under
  stream; AP Copter takes it in GUIDED — **[verify] GUID_OPTIONS bit for thrust-as-climb-rate
  vs raw thrust before labelling the thrust field.**
- **Stop semantics — ruled (§5.1):** stream end = **cease transmitting**, no brake packet.
  The Steer brake has no attitude analogue (zero thrust is a crash), the firmware watchdogs
  are the protocol's own end-of-control, and MAVSDK's extra Hold-switch is a mode change —
  opt-in territory per the `changeMode` precedent, not built until asked. Still measure what
  each stack does on attitude-stream silence (§6.3) and record it in §14.
- Shares the (connection, target) stream lock with Steer — two nodes commanding one vehicle's
  motion is the same hazard regardless of message. Files: `lib/move/attitude.js`, tests in
  `test/move/`.

### Manual (new)
- **Fields:** x/y/z/r sticks, buttons/buttons2. **Addressing: `target` is a system id only —
  no compid.** The one Move action with no Target compid row; do not invent one.
- **The Sub trap [source, verified this week]:** x/y/r are −1000..1000 neutral 0, but on Sub
  **z is 0..1000 with neutral 500** (0–499 reverse thrust). A "zero stick" built naively
  full-reverses the vertical thruster. Operator surface speaks −1..1 per axis everywhere and
  the node maps to the family's wire convention at encode — exactly once. [verify] the z
  convention on copter/plane/rover before shipping the map.
- **Failsafe is the deadman [source]:** ArduSub disarms on MANUAL_CONTROL silence (GCS
  failsafe). So: Send tier = one message per input (wire a dashboard joystick straight in);
  Stream tier = repeat last sticks at rate with a **short default TTL**; stop = send neutral
  sticks (family-correct neutral!) then cease. TTL expiry = cease without neutral — silence
  *is* the protocol's stop. Measure both on the rig before trusting this paragraph.
- Same stream lock scope. Files: `lib/move/manual.js`.

### Turn (new)
- AP (copter/sub): `CONDITION_YAW` — param1 heading deg, param2 rate deg/s, param3 direction
  −1/1, param4 relative flag. Acked ⇒ Build/Send/Confirm, riding the existing AckWaiter
  exactly like goto's confirm. PX4: no handler [verify] — derive a yaw-bearing setpoint
  instead, or fail closed pending measurement. Plane: ⏩ 43002 behind a [§14 measurement].
  Unknown firmware: fail closed, named error.
- Files: `lib/move/turn.js` (or fold into `action.js` derivation if ≤ ~40 lines — net-code
  budget decides, not module aesthetics).

### Speed (new)
- `DO_CHANGE_SPEED` param1 speed-type (0 airspeed / 1 groundspeed — enum in seed), param2
  m/s, param3 throttle. Acked ⇒ Build/Send/Confirm. Plane ⏩ 43000 later. [verify] per-family
  param semantics against the seed's enum before labelling.

### Orbit (PX4-gated)
- `DO_ORBIT`: radius, velocity, yaw-behaviour enum, lat/lon/alt as COMMAND_INT. No ArduPilot
  handler found [source] — offer only when profile firmware is px4, and **measure on the PX4
  SIH before shipping** (the DESIGN rule: unmeasured stays off).

## 5. Rulings — resolved by ecosystem practice (owner directive 2026-08-13: "what's everyone
else doing? That's the answer")

1. **Attitude stream end = cease transmitting. No brake packet, ever.** MAVSDK
   `Offboard::stop()` does exactly two things [source]: removes the setpoint timer, then
   commands `FlightMode::Hold`. The wire half — silence — is ours to copy: both stacks carry
   their own watchdog (PX4 `COM_OF_LOSS_T`, AP `GUID_TIMEOUT` [§14 #179]) and silence is the
   protocol's own end-of-control. The Hold-switch half is a **mode change**, and this repo
   already ruled mode changes are strict opt-ins (the DO_REPOSITION `changeMode` checkbox,
   default off, [§14 2026-08-12]) — so it is not built until someone asks, and if asked it is
   a checkbox mirroring `changeMode`, not a default.
2. **Stream lock is shared across Steer / Attitude / Manual — one lock per (connection,
   target).** MAVSDK runs **one** sending loop per vehicle: switching setpoint type removes
   the old periodic call and installs the new one [source]. Replacement follows Steer's
   existing handover semantics (new stream live before old stops, no brake between).
3. **ROI: dissolved — Payload already owns it.** `lib/payload/index.js:163-179` carries
   `roi-set` / `roi-clear` (`DO_SET_ROI_LOCATION`/`_NONE`), matching MAVSDK's placement (ROI
   lives in its gimbal plugin). One implementation per concept (§2): Move never touches ROI.
4. **Speed is a Move action.** QGC offers change-speed as a fly-view *guided action* beside
   goto and altitude change [source], and #277 already moved motion presets out of Command.
5. **Manual TTL: keep Move's existing convention — default 1000 ms, same as Steer.** The
   ecosystem has no sender-side TTL at all: QGC streams while the joystick is enabled and the
   firmware failsafe (ArduSub disarms on ~seconds of silence [source]) is the deadman. So no
   new number is invented; 1000 ms sits safely under every firmware watchdog, and the Send
   tier (one message per input) is the native fit for a dashboard joystick widget.
6. **Plane Steer collapses to altitude-change.** QGC's plane guided surface is goto +
   "Change altitude" — no lateral steer is offered [source], and ArduPlane's handler reads
   only `z` of frame 7. On the plane family the Reference locks to Offset and only the Up row
   shows.

## 6. Rig measurement checklist (hand to the SITL LLM verbatim)

Each result → `DESIGN.md` §14 entry naming belief/fact/recheck, per house style.

1. Offset × stream on Copter: does a repeated frame-7 setpoint walk the vehicle? (source says
   yes; currently refused on source alone — fb986a8.)
2. PX4 ≥1.18 frame 7: still inert? (2026-08-05 measurement is the standing authority.)
3. SET_ATTITUDE_TARGET: AP GUIDED single-shot + stream (thrust semantics, GUID_OPTIONS);
   PX4 OFFBOARD stream; what each stack does when the stream stops.
4. MANUAL_CONTROL: Sub z-neutral 500 confirmed live + failsafe timing; copter/plane/rover z
   convention; blimp handling at all.
5. CONDITION_YAW: copter + sub guided (angle, rate, relative); rover behaviour; PX4 rejection.
6. DO_CHANGE_SPEED: rover + copter + plane param semantics.
7. DO_ORBIT on PX4 SIH; confirm AP rejection code.
8. GUIDED_CHANGE_SPEED/ALTITUDE/HEADING (43000-2) on ArduPlane SITL.
9. Steer mask 3128 (pos+accel, no vel) on both stacks — a one-line MODES row if it works
   (`lib/move/frames.js` comment already says so).
10. Sub DO_REPOSITION + frame 12 body steer; Rover DO_REPOSITION.

## 7. Phasing — each a draft PR, ≤50 files, gauntlet before push

- **PR A** *(exists, unpushed `fb986a8`)*: Offset reference. Fate pending second opinion.
- **PR B**: editor infrastructure — family-aware Action rebuild, hide-from-new/red-on-saved
  helper (generalise the fb986a8 pattern into `resources/mavlink-editor.js`), Steer group
  checkboxes. No new wire capability, so the net-code budget applies hard.
- **PR C**: Manual. (First — it's the sub/blimp story and the biggest family win.)
- **PR D**: Turn. (Closes the measured yaw hole.)
- **PR E**: Attitude. (After its ruling + measurements.)
- **PR F**: Speed. **PR G**: Orbit (post-measurement). ⏩ plane 43000-2 ride F/D as
  firmware-gated arms once measured.

**Step 0 of every PR that widens the surface:** `DESIGN.md` §3's Move charter currently reads
"`SET_POSITION_TARGET_*` over the full mode × frame matrix" — amend it (and §9's Move
sections) *straight to `main`, never through the PR* (`AGENTS.md`). Proposed charter: *"Move
owns where the vehicle goes and how it moves — guided goto, setpoints, attitude, manual
sticks, heading, speed, orbit — deriving carrier, frame, and mask from intent; Command owns
vehicle state."*

**Non-negotiables from doctrine** (they will save you three bot rounds): runtime never
refuses except where there is no right answer to give (body-without-firmware class); editor
is the only protector; `msg` is trusted; result vocabulary — one meaning per word, `succeeded`
is banned in Move; every new editor combo lands in `test/move/legality-matrix.test.js`
(offered completes / unoffered refuses loud / NOT_OFFERED set for withdrawn cells); every
validator that returns a reason declares `(v, opt)` [§14]; regenerate nothing under `seed/`
for this work (no metadata changes); run the four gauntlet lenses on your own diff before the
first push.
