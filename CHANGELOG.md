# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning is [SemVer](https://semver.org/spec/v2.0.0.html). Pre-1.0 means the
config-node shapes and message contracts may still change without a major bump.

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
  (module load = boot) instead of `0`: builds without an explicit
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
