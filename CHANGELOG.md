# Changelog

Notable changes per release. This project has not been published to npm yet, so
everything below is pre-release history.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning is [SemVer](https://semver.org/spec/v2.0.0.html). Pre-1.0 means the
config-node shapes and message contracts may still change without a major bump —
see AGENTS.md "no migrations, no compatibility shims".

## [Unreleased]

### Added

- **A parameter is identified by name or by index, not both at once.** The
  dialog showed Param id and Index side by side, with `-1` in Index meaning
  "ignore me, use the name" — a sentinel to know, dressed as a field to fill.
  A radio picks one. By name the Index row is hidden and carries `-1`, stamped
  on every switch rather than left at whatever was typed before, because
  `PARAM_REQUEST_READ` sends both fields and a leftover index silently wins
  over the name. By index the range starts at **0**, since `-1` contradicts the
  mode, and `-5` or `99999` are now refused instead of reaching the vehicle.
- **The Type field answers itself where the firmware publishes an answer.** PX4
  states a type for all 1836 of its parameters and it was being parsed and then
  discarded; it now ships in the seed, and choosing a parameter narrows Type to
  that one option — immutable by having nothing else on offer. ArduPilot
  publishes no type in either of its metadata formats, so there the full choice
  remains and nothing is guessed: DESIGN.md §14 records a REAL32-typed set of an
  integer parameter timing out a confirm for a set that had actually succeeded.
- **Definition detail moved to hover.** Description, unit and range were a
  standing row under the field; they are reference read once when picking a
  parameter, so they now ride on the field's tooltip like every other
  catalog-backed field in the palette. The Firmware dropdown's blank-looking
  placeholder is labelled "(select firmware)".

- **Parameter definitions now ship with the package.** 30,938 definitions
  across seven targets — ArduPilot's six vehicle documents and PX4's — as a
  737 KB gzipped seed alongside the existing dialect seed, taking the package
  from 516 KB to 1.2 MB. The Param id field is populated out of the box, with
  no manual download; the Build tier, which names no Vehicle Profile and could
  previously reach no definitions at all, is answered from the seed. Keyed on
  the profile's firmware and vehicle family, because the same id genuinely
  differs between stacks — `RC1_MIN` is microseconds 800–1500 on PX4 and PWM
  800–2200 on ArduPilot. A profile that has downloaded its own definitions
  still overrides the seed id by id; a corrupt download is now reported *and*
  falls back to the seed rather than costing the operator both.
  Regenerate with `npm run generate-param-seed`.
- **The Value field now knows what it is setting.** A parameter with a
  documented enumeration gets a real select — `FLTMODE1` offers "AltHold (2)"
  rather than asking you to remember that AltHold is 2 — with a
  **Custom value…** escape, because firmware accepts values no metadata file
  lists. Hovering an entry shows its description, as on every other
  catalog-backed dropdown. Documented bounds are enforced at edit time: 50 for an 800–2200 PWM
  parameter is refused in the editor instead of reaching the vehicle. Units
  print beside the box and the documented increment becomes the step. Roughly
  1 parameter in 4 carries an enumeration and about half carry bounds (24%/51%
  on ArduPilot Copter, 20%/61% on PX4). A blank value still defers to
  `msg.payload`, an unknown parameter is never rejected for being unknown, and
  with no definitions loaded this is exactly the previous numeric check.
- **A vehicle you have not named gets names, and nothing that can act.** The
  Vehicle Profile's **Vehicle** field gains **Blimp**, so all six ArduPilot
  documents are now selectable — Blimp's 3127 definitions previously shipped
  with no family able to reach them. **Generic** is renamed **Unknown /
  custom**, and now serves the union of parameter *names* with no bounds and no
  choice lists. The documents disagree: of the 5467 ids in more than one
  ArduPilot document, 122 disagree on their enumeration and 25 on their maximum,
  and whichever document was read first used to win. On a Blimp that meant
  `WP_RADIUS` offered 1–32767 m instead of the documented 0.1–10, so the editor
  refused a legal 0.5 and accepted 5000; a divergent enumeration is worse, since
  picking "AltHold (2)" on a vehicle whose mode 2 is something else sets the
  wrong mode. Naming the vehicle turns the range check and the dropdown back on.
  Descriptions and units are still shown — they inform, they do not refuse.
- **Param id is now searched, not just autocompleted.** The datalist is
  replaced by a results panel that matches on **description as well as name**,
  so "minimum" finds `RC1_MIN` — previously you had to know the name before
  you could find it, which a 6827-entry list makes worse rather than better.
  Exact and prefix name matches rank above description matches, each row shows
  the description and units, and arrow keys plus Enter select. Typing a name
  in no list still works: Lua scripts and custom builds declare parameters no
  metadata file has heard of.

- **PX4 parameter definitions now work from the upstream URL.** Point Param
  defs URL at `https://artifacts.px4.io/Firmware/_general/parameters.xml` and
  Update loads all 1836 definitions. PX4 publishes the same parameters twice —
  `parameters.json.xz` and an uncompressed `parameters.xml` — and reading the
  XML avoids an LZMA dependency entirely, since `fast-xml-parser` is already
  used for dialect XML. Format is sniffed from the document's first byte, not
  its `Content-Type`, because PX4 serves the archive as `application/json`.
  The XML normalizes into the PX4 JSON shape, so one code path reads both.
  A `boolean="true"` parameter expands to the same Disabled/Enabled pair PX4's
  own JSON generator emits — the whole measured difference between the two
  published formats, 98 parameters. Verified field-for-field against the live
  document: 1836 parsed, 369 with enumerated values, 737 with units, 1119 with
  a minimum, 503 with an increment — every count identical to the JSON.

- Parameter definitions now read **PX4's `parameters.json`** as well as
  ArduPilot's `apm.pdef.json`. The two shapes differ in both directions: PX4
  is a flat `parameters` array carrying the id inside each entry as `name`
  (the ArduPilot walk would have keyed those off the array index and produced
  a param called `0`), describes with `shortDesc`/`longDesc`, states bounds as
  plain numbers rather than a `"low high"` string, and lists enumerated values
  as `[{value, description}]` instead of `{"0": "Label"}`.

### Fixed

- The Param id field explains itself when it has no definitions to offer.
  Four paths out of the loader — no Connection, a Connection with no Vehicle
  Profile, no dialect, no firmware — returned before marking the load
  complete, and the notice row renders only on a completed load. The two most
  likely states therefore produced no dropdown, no hover text, and no reason;
  typing a real param id looked like nothing happening.
- A compressed parameter-definitions file is named rather than parsed. PX4
  publishes `parameters.json.xz` **and serves it as
  `Content-Type: application/json`**, so the header cannot be trusted and the
  magic number is checked instead. Previously the XZ bytes reached
  `JSON.parse`, whose error — binary and all — was shown to the operator as
  ``Unexpected token '<27>', "<27>7zXZ..." is not valid JSON``. Non-JSON bodies
  are now quoted as printable ASCII only.

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
  inert, not a place). SITL measurement (§14) narrowed this to *absolute*
  frames: blanks pass as zero offsets in `LOCAL_OFFSET_NED`/`BODY_OFFSET_NED`,
  and are refused in `LOCAL_NED` and `BODY_NED` — the latter because ArduPilot
  reads it as a body offset while PX4 moves absolute-like on the same packet.

### Fixed

- Move firmware advisories are now measured rather than asserted (§14). The
  warning list is exactly Force (either stack), PX4 + either OFFSET frame, and
  PX4 + `BODY_NED`. Three were removed as refuted: ArduPilot Copter-4.7.0 *does*
  act on acceleration-only setpoints (moved ≈43 m), it handles `BODY_NED` and
  `BODY_OFFSET_NED` identically, and PX4 accepted a terrain-altitude target and
  moved without complaint. The editor's "Body NED — PX4 OFFBOARD" label had the
  firmware attribution backwards and is corrected.
- In-node filters grew up: per-message rate limits (`ATTITUDE=2, HEARTBEAT=1`
  pairs with an optional bare default; the shape is editor-validated per §2),
  a compared-field subset for changed-only (so hot timestamps don't defeat
  it), and a field predicate (field present / field equals value).

- Move now covers the full `SET_POSITION_TARGET_*` matrix: modes Position,
  Velocity, Position + Velocity, Acceleration, Force (force bit set), and Yaw
  only — plus a Frame selector (local NED, offset-from-current, body offset,
  body NED, and global relative/MSL/terrain altitude). Labels follow the frame
  (body frames read forward/right), vertical inputs stay up-positive
  everywhere, and there is still no raw `type_mask` — named concepts only.
  Combinations measured as unsupported still send but raise a node warning (see
  the advisory list under Fixed). A global-frame position with blank lat/lon now
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
