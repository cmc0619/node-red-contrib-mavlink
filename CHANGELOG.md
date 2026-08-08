# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning is [SemVer](https://semver.org/spec/v2.0.0.html). Pre-1.0 means the
config-node shapes and message contracts may still change without a major bump.

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
