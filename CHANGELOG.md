# Changelog

Notable changes per release. This project has not been published to npm yet, so
everything below is pre-release history.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning is [SemVer](https://semver.org/spec/v2.0.0.html). Pre-1.0 means the
config-node shapes and message contracts may still change without a major bump —
see AGENTS.md "no migrations, no compatibility shims".

## [Unreleased]

### Changed

- **Fan-out is now a replicator, not an action node.** It takes one *built*
  message — wire any action node's Build tier (or mavlink-build) into it — and
  retargets it per member; the embedded command/move/payload/param mini-editor
  is gone, and with it every duplicated builder path. What a message means is
  inferred from its name — matched against explicit name sets, never prefixes
  (COMMAND_* ack-confirms; PARAM_SET echo-confirms sequential-only at the wire
  plane; the four offboard setpoints stream; mission *transfer steps* and
  PARAM_REQUEST_LIST refuse, while single-shot MISSION_SET_CURRENT /
  MISSION_CLEAR_ALL replicate normally). New: per-target overrides
  (`{message, targets: [{sysid, ...fieldPatches}]}` — wire units, the list is
  the selection) and sequential `concurrency` so confirm waits can overlap.
  Existing fan-out flows need rewiring (a Build node upstream); all bundled
  examples are updated. `memberParams` is replaced by `targets`.

### Added

- Ack attribution on shared links: `AckWaiter` and Fan-out's broadcast confirm
  now ignore a `COMMAND_ACK` explicitly addressed to a different GCS (MAVLink 2
  `target_system`/`target_component` extension fields), resolved from the
  sending identity via the connection's new `resolveSourceIds()`. MAVLink 1
  acks (no target fields) pass unchanged.
- Fan-out **Stop on error**: optionally halt remaining members after the first
  failure; never-dispatched members report `skipped` in the aggregate.
- Move refuses a blank local position coordinate (north/east/up) instead of
  zero-filling it into an origin setpoint — the local-frame twin of the
  global lat/lon guard. Velocity/acceleration blanks stay 0 (a zero rate is
  inert, not a place).
- In-node filters grew up: per-message rate limits (`ATTITUDE=2, HEARTBEAT=1`
  pairs with an optional bare default; the shape is editor-validated per §2),
  a compared-field subset for changed-only (so hot timestamps don't defeat
  it), and a field predicate (field present / field equals value).

- Move now covers the full `SET_POSITION_TARGET_*` matrix: modes Position,
  Velocity, Position + Velocity, Acceleration, Force (force bit set), and Yaw
  only — plus a Frame selector (local NED, offset-from-current, body offset for
  ArduPilot GUIDED, body NED for PX4 OFFBOARD, and global relative/MSL/terrain
  altitude). Labels follow the frame (body frames read forward/right), vertical
  inputs stay up-positive everywhere, and there is still no raw `type_mask` —
  named concepts only. Combinations firmware is known to silently drop (Force
  anywhere, acceleration-only on ArduPilot, terrain/OFFSET frames on PX4) still
  send but raise a node warning. A global-frame position with blank lat/lon now
  refuses instead of flying to 0,0. Fan-out move actions speak the same
  vocabulary (`moveMode` + new `moveFrame`, plus velocity/accel fields its
  editor previously lacked). The pre-frame mode names (`local-position`,
  `local-velocity`, `global-position`) are removed, not aliased — pre-1.0, no
  migrations; re-pick mode + frame in the affected Move/Fan-out nodes (bundled
  examples updated).

### Fixed

- Blank latitude/longitude no longer becomes `0,0`. Go To, Orbit and Set Home
  refuse a missing coordinate rather than flying to the Gulf of Guinea, on the
  command node, fan-out and the gimbal ROI payload alike. An explicit `0` still
  sends. (#88)
- `COMMAND_INT` now defaults to `MAV_FRAME_GLOBAL_RELATIVE_ALT` (3). ArduPilot
  checks the takeoff frame with a strict equality and answered `DENIED` for the
  previous default, with no carrier swap behind it. (#89)
- `target_system = 0` reaches every vehicle on a UDP star. The broadcast frame
  is serialized once and written to every learned peer endpoint instead of a
  single datagram to the configured remote.
- A redeployed fan-out no longer keeps commanding vehicles. `close` cancels
  every in-flight run and waits for it to unwind; a cancelled run is reported
  quietly rather than as a command failure, so a redeploy cannot trip a Catch
  node wired for failsafe.

### Added

- Optional **Swarm address** on Connection (UDP): a multicast group or broadcast
  address that carries one write to the whole fleet. Unverified against real
  hardware — see `TODO.md`.

### Security

- Dev dependencies refreshed. The remaining `xml2js` advisories are documented
  and accepted in `SECURITY.md`.
