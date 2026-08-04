# Changelog

Notable changes per release. This project has not been published to npm yet, so
everything below is pre-release history.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning is [SemVer](https://semver.org/spec/v2.0.0.html). Pre-1.0 means the
config-node shapes and message contracts may still change without a major bump —
see AGENTS.md "no migrations, no compatibility shims".

## [Unreleased]

### Added

- Move now covers the full `SET_POSITION_TARGET_*` matrix: modes Position,
  Velocity, Position + Velocity, Acceleration, Force (force bit set), and Yaw
  only — plus a Frame selector (local NED, offset-from-current, body offset for
  ArduPilot GUIDED, body NED for PX4 OFFBOARD, and global relative/MSL/terrain
  altitude). Labels follow the frame (body frames read forward/right), vertical
  inputs stay up-positive everywhere, and there is still no raw `type_mask` —
  named concepts only. Combinations firmware is known to silently drop (Force
  anywhere, acceleration-only on ArduPilot, terrain/OFFSET frames on PX4) still
  send but raise a node warning. Legacy `local-position` / `local-velocity` /
  `global-position` configs keep working and migrate in the editor; a
  global-frame position with blank lat/lon now refuses instead of flying
  to 0,0.

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
