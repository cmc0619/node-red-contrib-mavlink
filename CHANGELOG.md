# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning is [SemVer](https://semver.org/spec/v2.0.0.html). Pre-1.0 means the
config-node shapes and message contracts may still change without a major bump.

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
- `mavlink-command`: preset coordinates are range-checked wherever a location
  is *present*, including Takeoff and Land — an out-of-range latitude reached
  the wire as a valid-looking `COMMAND_INT`.
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
