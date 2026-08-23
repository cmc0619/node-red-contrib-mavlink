# Example flow catalog — `node-red-contrib-mavlink`

Index of the **shipped** importable Node-RED flows under `examples/` and
`examples/sitl/`. Node names, preset ids, delivery tiers, config keys, and firmware
facts match the package nodes and `DESIGN.md`. Section 3's README outline is a historical
note from when the set was assembled — the JSON files and
[`examples/sitl/README.md`](sitl/README.md) are already in-tree.

Contents:

1. [Node/preset cheat-sheet](#0-cheat-sheet) — the exact strings the flows must use
2. [Regular examples (10–27)](#1-regular-examples-1027)
3. [SITL folder (`examples/sitl/`)](#2-sitl-folder-examplessitl) — see also [`examples/sitl/README.md`](sitl/README.md)
4. [`examples/sitl/README.md` outline](#3-examplessitlreadmemd-outline)

---

## 0. Cheat-sheet

Config keys and enumerated values, verified against the node source. The flows below
reference these by name rather than re-explaining them each time.

**Delivery tiers per node** (the `delivery`/`tier` config value):

| Node | Values |
|---|---|
| `mavlink-command` | `build` \| `send` \| `confirm` \| `complete` |
| `mavlink-move` | `build` \| `send` \| `confirm` (Go to only) \| `stream` |
| `mavlink-param` | `build` \| `send` \| `confirm` (set echo) \| `collect` (list) |
| `mavlink-payload` | `build` \| `send` \| `confirm` |
| `mavlink-build` | `build` \| `send` (config key is `tier`) |
| `mavlink-fanout` | `build` \| `send` \| `confirm` |

**Command presets** (`mode: "preset"`, `preset: <id>`): `arm`, `disarm`, `set_mode`,
`takeoff`, `land`, `rtl`, `set_home`, `change_speed`, `orbit`, `mission_start`, `pause`,
`resume`, `request_message`, `set_message_interval`, `stop_message_interval`,
`reboot_autopilot`, `flight_termination`. `reposition` is **not** a Command preset: Move
owns the goto, and the library row survives only as the `DO_REPOSITION` metadata
`mavlink-formation` builds from (`listed: false`). The old `yaw`/`rotate` presets are
**gone**: `CONDITION_YAW`
rides advanced mode now (`advancedCommand: "115"`, param4 = 0 absolute / 1 relative).
Advanced mode is `mode: "advanced"`, `advancedCommand: "<MAV_CMD numeric>"`. `params` is
a JSON string keyed by param index (`"{\"7\":20}"` = param7 = 20).

**Move** `action`: `goto` (one-shot guided goto — `DO_REPOSITION` as COMMAND_INT on
Build/Send/Send & confirm, `SET_POSITION_TARGET_GLOBAL_INT` on Stream; `altRef`: `home` \|
`msl` is the only frame choice, plus `speed`/`radius`/`changeMode`/`ackTimeout` on the
command path) or `steer` (setpoints; `reference`: `world` = Local NED everywhere, `body`
derives the frame from the bound firmware and fails closed without one). There is no
mode pulldown: the type_mask derives from which field groups are non-blank — filling
fields IS the mode. Fields in an **unused** group must be blank (`""`); `0` inside an
active group is a commanded zero (hover, pure-north) and stays. `rateHz`
(setpoints/s), `ttlMs` govern the stream. Up is up-positive and yaw is degrees in the UI;
the node flips to NED and converts to radians at encode. **No arc primitive** — a
curved path is either many setpoints from a Function node, `DO_ORBIT`, or a mission ring.

**Payload** `topic`/`verb`: camera → `photo`, `start-video`, `stop-video`, `set-mode`,
`trigger-distance`; gimbal → `aim` (with `path: "manager"` for
`GIMBAL_MANAGER_SET_PITCHYAW`, else `legacy` for `DO_MOUNT_CONTROL`), `set-mode`,
`roi-set`, `roi-clear`; servo → `set`, `repeat`; release → `gripper`, `winch`,
`parachute`. Only `aim`+`manager` has no ack; everything else is `command_ack`.

**Mission** `action`: `download` \| `upload` \| `clear`; `missionType`: `mission` \|
`fence` \| `rally`. Upload items arrive on `msg.payload` as an array of
`{command, frame, param1..4, x, y, z, autocontinue}`.

**State** `mode`: `feed` (edge events) or snapshot (input-triggered). Feed `events`:
`peer-new`, `component-new`, `heartbeat`, `stale`, `expired`, `endpoint-added`,
`primary-changed`, `multi-endpoint`, `statustext`, plus the
flight-dynamic transitions `armed-changed`, `mode-changed`, `landed-changed`,
`gps-fix-changed`, `home-changed`, `sensor-health-changed` (each carries
sysid/compid and from/to; first observation is not a transition).

**In** filters: `message`, `sysid`, `compid`, `changedOnly`, `rateLimit` (Hz).

**Fan-out** is a replicator: wire a Build-tier action node into it and it retargets
the built `{name, fields}` message per member. `selectionMode`: `all` \| `list`
(`members` rows `{sysid, north?, east?, up?, patch?}` — offsets in metres, patch in wire
units) \| `filter` (`vehicleType`/`firmwareFilter`/`armedFilter`);
`executionMode`: `sequential` (`intervalMs`, `concurrency`) \| `broadcast`
(`target_system=0`). Payload wrapper `{message, targets}` patches
wire fields per member.

**Firmware honesty facts used below:**

- ArduCopter custom-mode numbers: `GUIDED=4`, `LOITER=5`, `RTL=6`, `CIRCLE=7`, `AUTO=3`,
  `LAND=9`, `FLIP=14`. `DO_SET_MODE` param1 = base_mode (bit 0 =
  `MAV_MODE_FLAG_CUSTOM_MODE_ENABLED`, so `1`), param2 = custom_mode.
- **There is no `MAV_CMD_DO_FLIP`.** A "flip" is ArduCopter **FLIP flight mode (14)**:
  enter it armed and airborne, it performs one flip and auto-returns to the prior mode.
  PX4 has no flip — the flip step is ArduCopter-only and the catalog says so.
- **A circle, honest options** (pick per flow): (a) `DO_ORBIT` (Orbit preset) — one
  command, ArduCopter 4.x and PX4 both implement it; center defaults to current position
  on ArduPilot when lat/lon are 0. (b) ArduCopter **CIRCLE mode (7)** after setting the
  `CIRCLE_RADIUS` param — firmware-native, ArduPilot-only. (c) A **Move global position
  stream** (`mode: "position"`, global frame) of setpoints computed around a ring in a Function node — shows the toolkit's
  streaming path but the arc is your maths, not the vehicle's. The stroll flow uses
  `DO_ORBIT`; a sibling flow shows the Move-stream ring for contrast.
- PX4 `DO_SET_MODE` custom_mode is an encoded main/sub-mode bitfield, **not** a small
  integer — never hardcode ArduPilot mode numbers on a PX4 target (see SITL S4).
- Emergency force-disarm is `COMPONENT_ARM_DISARM` param2 = `21196` (band 0 emergency).

Every regular flow reuses the config-node triplet unless noted: one
`mavlink-local-identity` (GCS 255/190), one `mavlink-vehicle`, one `mavlink-connection`.
Standard first-ArduPilot binding is **bind `127.0.0.1:14550` → remote `127.0.0.1:14551`**.

---

## 1. Regular examples (10–27)

Product demos that exercise every palette node. They assume *a* link (SITL or a real
vehicle) but are not firmware pain-tests — those live in `examples/sitl/`. Prefer a single
importable tab per file with shared config nodes inline.

### 10 — Sunday Drone Stroll  ⭐

- **File:** `examples/10-sunday-stroll.json`
- **Tab label:** `10 Sunday drone stroll`
- **Story:** One button flies a whole joyride on an ArduCopter: arm, climb to 20 m in
  GUIDED, carve a lazy 200 m-wide circle, spin a full turn on the spot, do a single flip,
  then land. Steps with a completion condition (arm / set mode / takeoff / land) use
  `delivery: "complete"` so the next cannot fire early; orbit, rotate, and FLIP use
  `confirm` (ACK only — those presets have no completion key). Headline demo of the
  completion tier and the command presets working as a chain.
- **Nodes:** `local-identity`, `vehicle` (family `copter`, firmware `ardupilot`),
  `connection`, 7× `command`, `inject` per step, `debug` on each status port.
- **Key config:** Chain on output 0, every step `delivery: "complete"` where a completion
  exists (arm/set_mode/takeoff/land) so the next cannot fire early. Steps:
  1. `arm` (complete).
  2. `set_mode` GUIDED — `params {"1":1,"2":4}` (complete on active mode).
  3. `takeoff` — `params {"7":20}` (complete on relative alt 20 m).
  4. `orbit` (DO_ORBIT) — `params {"1":100,"2":5,"3":0,"5":"NaN","6":"NaN","7":"NaN"}`
     (radius 100 m ⇒ ~200 m circle, 5 m/s, center = current position via NaN); `confirm`.
  5. spin — advanced `CONDITION_YAW` (`advancedCommand: "115"`) —
     `params {"1":360,"2":30,"3":1,"4":1}` (360° CW at 30°/s, param4=1 relative);
     `confirm`. No yaw preset exists — Move owns motion intents.
  6. `set_mode` FLIP — `params {"1":1,"2":14}`; `confirm`. Comment: ArduCopter-only; must
     be airborne + armed; auto-returns to GUIDED after one flip.
  7. `land` (complete on landed state).
- **Inject buttons:** one master **`▶ Start stroll`** wired into step 1, plus manual
  per-step buttons for demo/recovery: **`1 Arm`**, **`2 GUIDED`**, **`3 Takeoff 20 m`**,
  **`4 Circle 200 m`**, **`5 Spin 360°`**, **`6 Flip`**, **`7 Land`**.
- **Honesty note in the tab comment:** circle = `DO_ORBIT` (real command, no path
  planner); flip = FLIP mode, not a fake `MAV_CMD`; PX4 would need different mode numbers.

### 11 — Sunday Stroll: the streamed circle

- **File:** `examples/11-stroll-move-circle.json`
- **Tab label:** `11 Streamed circle (Move)`
- **Story:** The same joyride, but the circle is flown by *the toolkit* instead of the
  autopilot: a Function node walks a lat/lon ring around the current position and a Move
  node streams `SET_POSITION_TARGET_GLOBAL_INT` setpoints at 5 Hz with a TTL, so letting
  go stops the vehicle. It exists to contrast honest streaming against `DO_ORBIT` and to
  show Move's freshness/stop behaviour.
- **Nodes:** config triplet, `command` (arm/set_mode/takeoff/land), `inject`, one
  `function` (ring generator — the only computed part), `move` (`action: "goto"`,
  `altRef: "home"`, `delivery: "stream"`, `rateHz: 5`, `ttlMs: 1500`), `debug`.
- **Key config:** Function computes `lat = c_lat + (R·sinθ)/111320`,
  `lon = c_lon + (R·cosθ)/(111320·cos c_lat)` per §"Coordinate frames"; emits
  `{payload:{position:{lat,lon,alt}}}` — the action and altitude reference live in the
  Move node's config, not the payload. Move TTL means the stream
  self-stops if injects stop arriving. Comment states plainly: no arc primitive exists;
  the ring is the flow author's maths.
- **Inject buttons:** **`Arm+GUIDED+Takeoff`**, **`◯ Fly circle`** (one-shot, sets
  `flow.circling`), **`■ Stop circle`** (clears it and sends `{action:"stop"}`), **`Land`**.
  A separate **`◯ circle tick (0.2 s)`** repeat inject drives the Function, which emits
  only while `flow.circling` is true — nothing on the repeating path writes the flag, or
  it would overwrite Stop within 200 ms.

### 12 — Ebony & Ivory (ArduPilot + PX4 side by side)

- **File:** `examples/12-ebony-and-ivory.json`
- **Tab label:** `12 Ebony & Ivory`
- **Story:** Two drones lift off together — one ArduPilot (sysid 1), one PX4 (sysid 11) —
  each on its own Connection with its own Vehicle Profile, driven by one shared GCS
  identity. It is the canonical dual-stack demo: one toolkit, two firmwares, two ports,
  no per-packet routing.
- **Nodes:** one `local-identity`; **two** `vehicle` (ardupilot/`ardupilotmega` +
  px4/`common` or `ardupilotmega`); **two** `connection`; per-side `command` arm→takeoff;
  `inject`; `state` feed to watch both; `debug`.
- **Key config:** ArduPilot connection bind `14550`→`14551`; PX4 connection bind `14560`→`14561`
  (Docker lab / current examples). ArduPilot side sets mode GUIDED (`custom_mode 4`); PX4
  side comment: **do not** reuse ArduPilot mode numbers — either take off via PX4's takeoff
  which auto-switches, or use the profile mode table (SITL S4). Both arm+takeoff run in
  parallel from one inject.
- **Inject buttons:** **`▶ Both up`** (fans to both sides), **`Ebony (ArduPilot) up`**,
  **`Ivory (PX4) up`**, **`Both land/RTL`**.

### 13 — Telemetry wall (In filters + rate limiting)

- **File:** `examples/13-telemetry-wall.json`
- **Tab label:** `13 Telemetry wall`
- **Story:** A tidy read-only dashboard feed: separate `In` subscriptions for HEARTBEAT,
  GLOBAL_POSITION_INT, ATTITUDE, SYS_STATUS and VFR_HUD, each rate-limited and
  changed-only where it matters, so a 50 Hz ATTITUDE stream doesn't drown the debug pane.
  Shows the `(message, sysid, compid)` keying of the In node's filters.
- **Nodes:** config triplet, 5× `in`, `debug` (some to sidebar status). No action nodes.
- **Key config:** ATTITUDE `rateLimit: 5`; HEARTBEAT `changedOnly: true`;
  GLOBAL_POSITION_INT `rateLimit: 4`, `sysid: 1`. One In left unfiltered to show the
  firehose vs a filtered view.
- **Inject buttons:** none (passive). Optional `inject` `Set 4 Hz posn` wired to a
  `command` `set_message_interval` to make the streams actually appear (cross-refs 15).

### 14 — Peer table (State → debug + dashboard)

- **File:** `examples/14-peer-events.json`
- **Tab label:** `14 Peer table`
- **Requires (optional):** `@flowfuse/node-red-dashboard` for `/dashboard/peers`. Debug
  panes work with core Node-RED alone — the only shipped example that soft-depends on a
  package outside this one.
- **Story:** One peer-table story that used to be three examples (14 events, 28 inspector,
  29 dashboard). A State snapshot of the Connection-owned peer table fans out to a raw
  debug, a readable layout debug, and a Dashboard table (replace every tick); a State feed
  subscribed to every peer-table event (including the flight-dynamic `*-changed` edges)
  fans out to an events debug and a rolling Dashboard log (append, capped at 200). Nothing
  on the page is configured — every cell is built from received traffic, so identity and
  mode appear well before position, GPS, battery, or home.
- **Nodes:** config triplet, `ui-theme`/`ui-base`/`ui-page`/`ui-group` ×2, `inject` ×3,
  `state` snapshot, `function` ×2 (layout text; one row per component), `debug` ×3,
  `ui-table` (replace), `state` feed, `function` (event → row), `ui-table` (append).
- **Key config:** feed lists the full event set (liveness + `armed-changed` /
  `mode-changed` / `landed-changed` / `gps-fix-changed` / `home-changed` /
  `sensor-health-changed`). Both tables run `autocols: true`. Enum labels in the Function
  nodes are display-only — the wire carries numbers and the dialect catalog is the
  authority.
- **Inject buttons:** **`every 2s`** (fires once 3 s after deploy, then repeats),
  **`Snapshot now`**, **`Snapshot sysid 1 only`** (`payload:{sysid:1}`).

### 15 — Telemetry rates (Request / Set / Stop interval)

- **File:** `examples/15-telemetry-rates.json`
- **Tab label:** `15 Telemetry rates`
- **Story:** Three buttons drive the telemetry system presets: request one ATTITUDE now,
  stream GLOBAL_POSITION_INT at 5 Hz, then stop it — each a Command preset over
  `REQUEST_MESSAGE`/`SET_MESSAGE_INTERVAL`, with an In node proving the rate changed.
- **Nodes:** config triplet, 3× `command` (`request_message`, `set_message_interval`,
  `stop_message_interval`), `in` (GLOBAL_POSITION_INT), `inject`, `debug`.
- **Key config:** message-id params are dialect message dropdowns; e.g. set interval
  `params {"1":33,"2":200000}` (msg 33 @ 200000 µs = 5 Hz); stop pins interval −1
  (`params {"1":33}`). `delivery: "confirm"`.
- **Inject buttons:** **`Request ATTITUDE`**, **`Stream posn 5 Hz`**, **`Stop posn`**.

### 16 — Parameter inspector (read / set / list)

- **File:** `examples/16-param-inspector.json`
- **Tab label:** `16 Parameter inspector`
- **Story:** Read a single parameter, set it and watch the echo confirm, then pull the
  whole list — the three Param actions with their two confirmation styles (echo for set,
  collect for list) side by side. Param defs give the values friendly labels when the
  Vehicle Profile has a defs URL.
- **Nodes:** config triplet (Vehicle `vehicleFamily: "copter"`), 3× `param` (`read`;
  `set` `delivery: "confirm"`; `request-list` `delivery: "collect"`), `inject`, `debug`.
- **Key config:** read `paramId: "WPNAV_SPEED"`; set `paramId: "WPNAV_SPEED"`,
  `value: 500`, `paramType: "MAV_PARAM_TYPE_REAL32"`; list `timeout: 20000`. Comment notes
  set is **echo-confirmed**, not acked, and PX4 params use the int/float union (SITL S5).
- **Inject buttons:** **`Read WPNAV_SPEED`**, **`Set WPNAV_SPEED=500`**, **`List all`**.

### 17 — Camera & gimbal operator (Payload)

- **File:** `examples/17-camera-gimbal.json`
- **Tab label:** `17 Camera & gimbal`
- **Story:** A payload operator's console: snap a photo, start and stop video, point a
  gimbal two different ways (modern manager message vs legacy mount control), and set/clear
  a region-of-interest lock. Demonstrates that gimbal `aim` picks its message per gimbal
  generation and that only the manager setpoint has no ack.
- **Nodes:** config triplet, `payload` ×: camera `photo`, camera `start-video`, camera
  `stop-video`, gimbal `aim`(`path:"legacy"`, `confirm`), gimbal `aim`(`path:"manager"`,
  `send` — no ack), gimbal `roi-set`, gimbal `roi-clear`; `inject`; `debug`.
- **Key config:** photo `values {count:1}`; aim legacy `values {pitch:-45,yaw:90}`; aim
  manager same but comment that it is fire-and-forget; roi-set `values
  {lat:47.3977,lon:8.5456,alt:500}`.
- **Inject buttons:** **`Photo`**, **`Video start`**, **`Video stop`**, **`Aim −45°/90°
  (legacy)`**, **`Aim (manager)`**, **`ROI set`**, **`ROI clear`**.

### 18 — Servo & release bench (Payload)

- **File:** `examples/18-servo-release.json`
- **Tab label:** `18 Servo & release`
- **Story:** A ground bench for actuators: drive a servo to a PWM, repeat-pulse it, then
  exercise the release verbs — gripper grab/release, winch pay-out, and (gated) parachute.
  Covers the servo and release payload topics that the camera/gimbal demo doesn't touch.
- **Nodes:** config triplet, `payload` ×: servo `set`, servo `repeat`, release `gripper`,
  release `winch`, release `parachute`; `inject`; `debug`.
- **Key config:** servo set `values {servo:9,pwm:1900}`; repeat `values
  {servo:9,pwm:1900,count:3,period:1}`; gripper `values {instance:1,action:1}`; winch
  `values {instance:1,action:1,length:2,rate:0.5}`; parachute gated behind a confirm
  inject + comment (it is a real release). All `delivery: "confirm"` (command-backed).
- **Inject buttons:** **`Servo 1900`**, **`Servo pulse ×3`**, **`Gripper release`**,
  **`Winch out 2 m`**, **`⚠ Parachute (armed test only)`**.

### 19 — Build & Out: craft a raw message

- **File:** `examples/19-build-and-out.json`
- **Tab label:** `19 Build & Out`
- **Story:** Build any dialect message by hand and push it on the wire: a STATUSTEXT built
  in the Build node (Build tier) is inspected then forwarded through Out, while a second
  Build node originates a NAMED_VALUE_FLOAT on a repeat interval and reports its achieved
  vs configured rate in the badge. Shows the Build→Out handoff and Build's repeat metering.
- **Nodes:** `local-identity`, `vehicle`, `connection`, `build` (STATUSTEXT, `tier:
  "build"`), `out`, `build` (NAMED_VALUE_FLOAT, `tier: "send"`, `repeatMs: 1000`),
  `inject`, `debug`.
- **Key config:** Build STATUSTEXT `fields {"severity":6,"text":"hello from Node-RED"}`;
  Out default band Control; repeat Build `band: 4` (Bulk) so it can't starve control.
  Comment: Build tier output 0 → Out input; the `char[]` text is padded/truncated by the
  codec (§5).
- **Inject buttons:** **`Build STATUSTEXT`**, **`Toggle NVF stream`**.

### 20 — Companion heartbeat & origination

- **File:** `examples/20-companion-origination.json`
- **Tab label:** `20 Companion origination`
- **Story:** Node-RED as an onboard companion, not a GCS: a `companion`-role identity
  shares the vehicle's sysid 1 under component 191, heartbeats as
  `MAV_TYPE_ONBOARD_CONTROLLER`, and originates a NAMED_VALUE_FLOAT of a computed metric.
  Demonstrates the identity role split and origination from the vehicle's own address.
- **Nodes:** `local-identity` (`role: "companion"`, sysid 1, compid 191), `vehicle`,
  `connection`, `build` (NAMED_VALUE_FLOAT `tier:"send"` `repeatMs:1000`), `in`
  (HEARTBEAT), `state` feed, `debug`.
- **Key config:** identity heartbeat type ONBOARD_CONTROLLER, autopilot INVALID; comment:
  a companion sharing sysid is normal MAVLink (§7); the peer table will show two components
  under sysid 1. Connection binds to the SITL as usual.
- **Inject buttons:** **`Send one NVF now`** (in addition to the timer).

### 21 — Mission designer (upload / download / clear + fence + rally)

- **File:** `examples/21-mission-designer.json`
- **Tab label:** `21 Mission designer`
- **Story:** Build a small survey: upload a 4-item mission, read it back to confirm, upload
  a polygon geofence and a rally point, then clear the plan. Exercises
  all three mission actions and all three plan types, and shows that a failed upload never
  degrades into a clear.
- **Nodes:** config triplet (ArduPilot — carries all three plan types), `mission` ×:
  upload/mission, download/mission, upload/fence, upload/rally, clear/mission; `inject`
  (each carrying the item array); `debug` on status ports for progress records.
- **Key config:** mission items are NAV_WAYPOINT (`command:16`) + a `DO_CHANGE_SPEED`
  (`command:178`) to show DO items are legal in a plan (§9 / §14); fence items
  `MAV_CMD_NAV_FENCE_POLYGON_VERTEX_*`; rally `MAV_CMD_NAV_RALLY_POINT`. Clear runs on
  any input — selecting the operation is the confirmation. Comment: fence/rally only on
  ArduPilot (see SITL S6).
- **Inject buttons:** **`Upload mission`**, **`Download mission`**, **`Upload fence`**,
  **`Upload rally`**, **`⚠ Clear mission`**.

### 22 — Go-to tour (Move goto, blank-yaw heading hold)

- **File:** `examples/22-goto-tour.json`
- **Tab label:** `22 Go-to tour`
- **Story:** Send a GUIDED copter hopping between three points with the Move node's Go to
  action (`DO_REPOSITION` on the COMMAND_INT carrier under the hood), each hop holding the
  current heading by leaving Yaw blank — a live demonstration of the §5 rule that blank
  fields encode the spec sentinels (`NaN` yaw = hold) rather than zero-filling.
- **Nodes:** config triplet, `command` arm→set_mode GUIDED (complete), 3× `move`
  (`action: "goto"`, `delivery: "confirm"`), `inject`, `debug`.
- **Key config:** each Move goto sets `lat`/`lon`/`alt` (`altRef: "home"`), `speed: 5`,
  blank `yaw` (hold current heading) and blank `radius` (0 = ignored);
  `delivery: "confirm"` waits on the `COMMAND_ACK`.
- **Inject buttons:** **`Arm + GUIDED`**, **`Go point A`**, **`Go point B`**,
  **`Go point C`**.

### 23 — Guided velocity joystick (Move velocity stream)

- **File:** `examples/23-velocity-joystick.json`
- **Tab label:** `23 Velocity joystick`
- **Story:** Nudge a GUIDED copter around with velocity setpoints: four buttons stream
  N/E/Up velocity through a Move node with a short TTL, so releasing a button lets the
  stream lapse and the vehicle stops — the freshness-and-stop contract that keeps a
  streamed control from running away.
- **Nodes:** config triplet, `command` arm→GUIDED, `move` (`action: "steer"`,
  `reference: "world"`, `delivery: "stream"`, `rateHz: 10`, `ttlMs: 500`), `inject`
  (velocity presets), `debug`.
- **Key config:** e.g. Forward `{velocity:{north:2,east:0,up:0}}`; Up
  `{velocity:{north:0,east:0,up:1}}`; a `Stop` inject sends `payload:false` (suppress) so
  the TTL times the setpoints out. Comment: Up is up-positive in the UI, flipped to NED at
  encode exactly once.
- **Inject buttons:** **`Fwd 2 m/s`**, **`Back 2 m/s`**, **`Left`**, **`Right`**,
  **`Up 1 m/s`**, **`■ Stop`**.

### 24 — Formation nudge (Fan-out + Move)

- **File:** `examples/24-formation-nudge.json`
- **Tab label:** `24 Formation nudge`
- **Story:** Push a whole group the same direction at once: a Fan-out node fans a Move
  velocity setpoint across a sysid list, first sequentially (paced) then as a single
  broadcast, showing when simultaneity beats pacing. Move carries no ack, so the fan-out
  reports per-vehicle send outcomes, not confirmations.
- **Nodes:** config triplet, `move` (Build, `action: "steer"` world, velocity north 1 m/s) feeding 3× `fanout`
  (preview via Build; `executionMode: "sequential"` `intervalMs: 150`; `broadcast`), `inject`, `debug`.
- **Key config:** selection `list` with member rows for sysids 1–5 (broadcast uses `all`); the Move
  node builds the setpoint, the fan-outs replicate it; broadcast pins `target_system=0`,
  single-stack only. The Build-tier preview inject shows the expanded plan first. Comment references §10
  broadcast rules.
- **Inject buttons:** **`Preview`**, **`Nudge (sequential)`**, **`Nudge (broadcast)`**.

### 25 — Speed & yaw choreography

- **File:** `examples/25-speed-yaw-choreo.json`
- **Tab label:** `25 Speed & yaw choreography`
- **Story:** A small aerobatic-ish routine for GUIDED: change ground speed, yaw to an
  absolute heading, then rotate relative — the `change_speed` preset plus the raw
  `CONDITION_YAW` command twice, showing one `MAV_CMD` with the relative flag set two
  ways (the old yaw/rotate presets are gone — Move owns motion intents).
- **Nodes:** config triplet, `command` arm→GUIDED→takeoff (complete), `command`
  `change_speed`, 2× `command` advanced `115` (Face / Rotate), `inject`, `debug`.
- **Key config:** change_speed `params {"1":1,"2":8,"3":-1}` (airspeed type enum, 8 m/s,
  no throttle change); Face 90° — advanced `115`, `params {"1":90,"2":20,"3":1,"4":0}`
  (param4=0 absolute); Rotate +45° — advanced `115`, `params {"1":45,"2":20,"3":1,"4":1}`
  (param4=1 relative). Same `MAV_CMD`, one param apart.
- **Inject buttons:** **`Prep (arm/GUIDED/takeoff)`**, **`Speed 8 m/s`**, **`Face 90°`**,
  **`Rotate +45°`**.

### 26 — Cross-connection bridge (In → Out)

- **File:** `examples/26-connection-bridge.json`
- **Tab label:** `26 Connection bridge`
- **Story:** Mirror one link onto another: an In node subscribed to a vehicle's telemetry
  feeds straight into an Out node on a second Connection, forwarding decoded traffic to a
  downstream GCS without re-encoding. Shows the In→Out passthrough shape and two
  Connections coexisting.
- **Nodes:** `local-identity`, 2× `vehicle`, 2× `connection` (source bind `14550`→`14551`;
  mirror bind `14560`→`14561`), `in` (source, no filter or HEARTBEAT+position), `out`
  (mirror, band Bulk), `debug`.
- **Key config:** Out recognises the In shape (`msg.topic` = name, `msg.payload` = fields)
  and forwards as-is; comment: forwarding across connections is the honest In→Out path,
  not a Function node. Band Bulk so mirrored telemetry can't starve control.
- **Inject buttons:** none (passive bridge). Optional **`Mirror on/off`** feeding
  `payload:false` to gate.

### 27 — Safety: emergency stop & flight termination

- **File:** `examples/27-safety-estop.json`
- **Tab label:** `27 Safety e-stop`
- **Story:** The two loud-and-final safety actions, each gated: an emergency force-disarm
  (`COMPONENT_ARM_DISARM` param2 = 21196, band 0 Emergency) and `DO_FLIGHTTERMINATION`,
  which the node refuses to send without explicit confirmation. Demonstrates the Safety
  preset group and the emergency queue band.
- **Nodes:** config triplet, `command` `disarm` (advanced/force with param2=21196),
  `command` `flight_termination` (`requiresConfirmation`), `inject` (confirm payloads),
  `debug`.
- **Key config:** force-disarm uses `disarm` preset with `params {"2":21196}`;
  flight_termination inject carries `{confirmed:true}` and `params {"1":1}`. Comment: these
  never auto-continue a chain and force-disarm rides the Emergency band that is never
  coalesced or dropped (§7).
- **Inject buttons:** **`⚠ Force disarm (21196)`**, **`⚠⚠ Flight termination (confirm)`**.

---

## 2. SITL folder (`examples/sitl/`)

Flows that only make sense against the live five-ArduPilot + five-PX4 rig (§13): they
exercise real firmware behaviour — completion timing, mode tables, the PX4 param union,
mission/fence/rally per stack, fan-out pacing across five vehicles, and signing against a
verifier. Prefer the Docker lab (`sitl/docker-compose.yml`). Filenames are **numbered in
harness run order**, batched by `PROFILE.restart` so cold vehicle resets stay selective
(see [`examples/sitl/README.md`](sitl/README.md)):

| Phase | `restart` | Between examples |
|-------|-----------|------------------|
| 01–19 | `none` | no docker restart (after one cold prime) |
| 20–27 | `ap-1` / `ap-12` / `ap-2` | only those AP containers |
| 28–30 | `px4-1` | `nrc-px4-11` only |
| 31–35 | `ap-fleet` | AP 1–5 |
| 36–38 | `fleet` | all 13 vehicles |
| 39 | `none` | no docker restart |

### 01–19 — `restart: none` (params / missions / companions / payload)

### sitl/01 — PX4 parameter int/float union

- **File:** `examples/sitl/01-px4-param-union.json` · **Tab:** `SITL 01 PX4 param union`
- **Story:** Set an integer PX4 parameter (e.g. `COM_RC_IN_MODE`) and read it back to show
  the value survives the int/float **union** reinterpretation rather than a numeric cast —
  the corruption §11 warns about, only observable against real PX4.
- **Nodes:** config triplet (PX4 sysid 11), `param` set(`confirm`)→read, `inject`, `debug`.
- **Config/launch:** PX4 SITL, `paramType: "MAV_PARAM_TYPE_INT32"`; bind `14560`→`14561`.

### sitl/02 — Mission / fence / rally per firmware

- **File:** `examples/sitl/02-mission-fence-rally.json` · **Tab:** `SITL 02 Mission/fence/rally`
- **Story:** Upload mission + fence + rally to ArduPilot (all three supported), then send
  the same fence/rally to PX4 and watch the node refuse fail-loud because PX4 doesn't carry
  them over this protocol — the firmware-gated type list in action.
- **Nodes:** 1 identity, 2 vehicles, 2 connections, `mission` ×5 (ArduPilot: mission/fence/
  rally upload; PX4: fence upload → expected failure), `inject`, `debug`.
- **Config/launch:** ArduCopter sysid 1 + PX4 sysid 11.

### sitl/03 — Malformed mission upload fails, never clears

- **File:** `examples/sitl/03-mission-failloud.json` · **Tab:** `SITL 03 Mission fail-loud`
- **Story:** First upload a good mission, then upload a malformed one and confirm the
  transfer **fails** and leaves the previously-good mission intact — it must never degrade
  into a clear (§9).
- **Nodes:** config triplet, `mission` upload(good)→download→upload(bad)→download, `inject`,
  `debug`.
- **Config/launch:** single ArduCopter sysid 1.

### sitl/04 — Live param defs labels

- **File:** `examples/sitl/04-param-defs-live.json` · **Tab:** `SITL 04 Param defs (live)`
- **Story:** Read and set parameters on a live ArduCopter with ArduPilot `apm.pdef.json`
  definitions bound to the profile, so values render with units, ranges, and enum labels —
  and request-list collects the full set.
- **Nodes:** config triplet (Vehicle `paramDefsUrl`), `param` read/set(`confirm`)/
  request-list(`collect`), `inject`, `debug`.
- **Config/launch:** single ArduCopter; defs fetch needs internet once at the bench.

### sitl/05 — Companion ArduPilot (sysid 20)

- **File:** `examples/sitl/05-companion-ap.json` · **Tab:** `SITL 05 Companion AP`
- **Story:** Node-RED companion identity sharing sysid 20 / compid 191 on the lab companion
  ports.
- **Key config:** bind `14540`→`14541`; Docker service `ap-companion-20`.

### sitl/06 — Companion PX4 (sysid 21)

- **File:** `examples/sitl/06-companion-px4.json` · **Tab:** `SITL 06 Companion PX4`
- **Story:** Companion identity sharing sysid 21 on PX4 companion ports.
- **Key config:** bind `14542`→`14543`; Docker service `px4-companion-21`.

### sitl/07 — COMMAND_INT local vs global scale

- **File:** `examples/sitl/07-int-local-vs-global.json` · **Tab:** `SITL 07 INT local vs global`
- **Story:** Prove §14: `COMMAND_INT` local-frame x/y scale as metres × 1e4, global as
  degrees × 1e7. ArduPilot accepts `DO_SET_HOME` with `GLOBAL_INT` and denies `LOCAL_NED`;
  PX4 accepts both and decodes `LOCAL_NED` as metres.
- **Nodes:** dual connections, 4× `command` `DO_SET_HOME` probes, `inject`, `debug`.
- **Config/launch:** AP sysid 1 + PX4 sysid 11.

### sitl/08 — Param float32 echo (both stacks)

- **File:** `examples/sitl/08-param-echo-float32.json` · **Tab:** `SITL 08 Param float32 echo`
- **Story:** Focused REAL32 set → echo-confirm → read on AP (`LOIT_SPEED_MS`) and PX4
  (`MPC_XY_VEL_MAX`).
- **Nodes:** dual connections, `param` set/read per stack, `inject`, `debug`.

### sitl/09 — In → Build → Out

- **File:** `examples/sitl/09-in-build-out.json` · **Tab:** `SITL 09 In → Build → Out`
- **Story:** Live In → Build → Out handoff against the lab (decode, re-encode, forward).
- **Nodes:** config triplet, `in`, `build`, `out`, `inject`, `debug`.

### sitl/10 — Companion receive

- **File:** `examples/sitl/10-companion-receive.json` · **Tab:** `SITL 10 Companion receive`
- **Story:** Companion role on AP sysid 20: receive HEARTBEAT/STATUSTEXT; optional
  NAMED_VALUE_FLOAT send.
- **Key config:** bind `14540`→`14541`; identity `companion` sysid 20 / compid 191.

### sitl/11 — Param read by index

- **File:** `examples/sitl/11-param-read-by-index.json` · **Tab:** `SITL 11 Param read by index`
- **Story:** Collect the AP param table, pick `LOIT_SPEED_MS` by index, then send
  `PARAM_REQUEST_READ` with `param_index ≥ 0` and empty `param_id`.
- **Nodes:** config triplet, `param` collect → function → `param` read(send) → assert.

### sitl/12 — Param fan-out set

- **File:** `examples/sitl/12-param-fanout-set.json` · **Tab:** `SITL 12 Param fan-out set`
- **Story:** Build-tier `PARAM_SET` of `ARMING_OPTIONS=1` then sequential fan-out
  echo-confirm across AP sysids 1–5 (§10 sequential-only for sets).
- **Nodes:** config triplet, `param` (Build) → `fanout` (confirm), `inject`, `debug`.
- **Why this parameter:** `ARMING_OPTIONS` is INT32 on Copter-4.7.0 and the node
  declares `MAV_PARAM_TYPE_REAL32` on purpose. ArduPilot ignores the declared type,
  c-casts the value, and echoes its *own* table type, so sent and echoed types never
  match. All five members must still report accepted — the wire matcher compares
  types only on bytewise, where a mismatch really does mean a garbage store. Five
  `unconfirmed` is the regression signal.

### sitl/13 — PX4 param list collect

- **File:** `examples/sitl/13-px4-param-list.json` · **Tab:** `SITL 13 PX4 param list`
- **Story:** PX4 `request-list` + collect, asserting known ids `COM_RC_IN_MODE` and
  `MPC_XY_VEL_MAX`.
- **Nodes:** config triplet (PX4 sysid 11), `param` collect → assert, `inject`, `debug`.

### sitl/14 — Param encoding override

- **File:** `examples/sitl/14-param-encoding-override.json` · **Tab:** `SITL 14 Param encoding override`
- **Story:** Explicit `msg.payload.paramEncoding` on both stacks — PX4 `bytewise` INT32 and
  ArduPilot `c-cast` INT32 echo-confirm — plus a crossed AP `bytewise` set that must
  echo-timeout (§11).
- **Nodes:** dual connections, 3× `param` set(confirm) with JSON inject payloads, `debug`.

### sitl/15 — Param echo timeout (unknown id)

- **File:** `examples/sitl/15-param-echo-timeout.json` · **Tab:** `SITL 15 Param echo timeout`
- **Story:** Confirm live `LOIT_SPEED_MS` first (AP-1 reachable), then set missing
  `WPNAV_SPEED` on Copter 4.7.0; confirm must finish as `timed-out` / `echo timeout`.
- **Nodes:** config triplet, 2× `param` set(confirm), `inject`, `debug`.

### sitl/16 — Payload gimbal legacy (AP-31)

- **File:** `examples/sitl/16-payload-gimbal-legacy.json` · **Tab:** `SITL 16 Payload gimbal legacy`
- **Story:** Legacy mount aim / set-mode / ROI set+clear against dedicated payload vehicle
  sysid 31 (`--gimbal` + servo mount) on bind `14570`.
- **Nodes:** config triplet (sysid 31), 4× `payload` gimbal(confirm), `inject`, `debug`.

### sitl/17 — Payload camera (AP-31)

- **File:** `examples/sitl/17-payload-camera.json` · **Tab:** `SITL 17 Payload camera`
- **Story:** `IMAGE_START_CAPTURE` ACCEPTED with `CAM1_TYPE=1`; `VIDEO_*` DENIED —
  documents the measured servo-camera limit on Copter-4.7.0 SITL.
- **Nodes:** config triplet (sysid 31), 3× `payload` camera(confirm), `inject`, `debug`.

### sitl/18 — Payload gimbal manager (AP-31)

- **File:** `examples/sitl/18-payload-gimbal-manager.json` · **Tab:** `SITL 18 Payload gimbal manager`
- **Story:** `GIMBAL_MANAGER_SET_PITCHYAW` via delivery=send (no ack by design); proves the
  wire path on AP-31 even though this stack emits no manager telemetry.
- **Nodes:** config triplet (sysid 31), `payload` gimbal aim manager(send), `inject`, `debug`.

### sitl/19 — TCP connection (template; SKIP in default lab)

- **File:** `examples/sitl/19-tcp-connection.json` · **Tab:** `SITL 19 TCP connection`
- **Story:** Structural TCP client example (`127.0.0.1:5760`). Default Compose lab is
  UDP-only, so the harness **SKIPs** this unless TCP is explicitly exposed.
- **Nodes:** config triplet (`mode: "tcp"`), `in` (HEARTBEAT), optional `build` NVF, `debug`.

### 20–27 — ArduPilot flight (`ap-1` / `ap-12` / `ap-2`)

### sitl/20 — Completion: IN_PROGRESS → ACCEPTED takeoff

- **File:** `examples/sitl/20-completion-takeoff.json` · **Tab:** `SITL 20 Completion takeoff`
- **Story:** GUIDED → arm → takeoff with `delivery: "complete"`; wait through
  `IN_PROGRESS` for terminal `ACCEPTED` once at altitude.
- **Nodes:** config triplet (AP sysid 1), `command` chain, `inject`, `debug`.
- **Config/launch:** bind `14550`→`14551`; `completionTimeout ≥ 30000`. `restart: ap-1`.

### sitl/21 — Completion timeout

- **File:** `examples/sitl/21-completion-timeout.json` · **Tab:** `SITL 21 Completion timeout`
- **Story:** 80 m takeoff with a short `completionTimeout` so the ACK arrives but altitude
  is never reached; status names the timeout, output 0 stays silent.
- **Nodes:** config triplet, `command` GUIDED→arm→takeoff(`complete`), `inject`, `debug`.
- **Config/launch:** `restart: ap-1`.

### sitl/22 — Command + mission basics on two instances

- **File:** `examples/sitl/22-command-mission-basics.json` · **Tab:** `SITL 22 Command & mission basics`
- **Story:** Preset + advanced commands on sysid 1 and a mission upload/download on sysid 2,
  two ArduPilot instances on one connection — target-by-sysid routing on a shared link.
- **Nodes:** config triplet, `command`, `mission` upload/download to sysid 2, `inject`,
  `debug`.
- **Config/launch:** AP sysids 1+2; `restart: ap-12`.

### sitl/23 — AP INT carrier goto

- **File:** `examples/sitl/23-ap-int-carrier-goto.json` · **Tab:** `SITL 23 AP INT carrier goto`
- **Story:** Live `COMMAND_INT` / `DO_REPOSITION` goto on ArduCopter sysid 1 via Move's
  goto action (decimal degrees → degE7 on the wire).
- **Nodes:** config triplet, `command` arm/takeoff, `move` goto (Send & confirm), `inject`, `debug`.
- **Config/launch:** `restart: ap-1`.

### sitl/24 — Move stream + stop

- **File:** `examples/sitl/24-move-stream-stop.json` · **Tab:** `SITL 24 Move stream + stop`
- **Story:** Move velocity stream then stop — freshness/TTL and the zero-velocity halt
  contract (§14 / #115).
- **Nodes:** config triplet, `command` prep, `move` (`stream`), stop inject, `debug`.
- **Config/launch:** `restart: ap-1`.

### sitl/25 — Profile target inherit

- **File:** `examples/sitl/25-profile-target-inherit.json` · **Tab:** `SITL 25 Profile target inherit`
- **Story:** Vehicle profile `targetSystem` is 2; the command leaves target blank so the
  wire address inherits from the profile default.
- **Nodes:** config triplet (profile sysid 2), `command` arm, `inject`, `debug`.
- **Config/launch:** AP sysid 2; `restart: ap-2`.

### sitl/26 — Peer table in flight

- **File:** `examples/sitl/26-peer-table-inflight.json` · **Tab:** `SITL 26 Peer table in flight`
- **Story:** Fly AP sysid 1, then snapshot the Connection peer table (§8) — armed, position,
  GPS, battery, home. Hard field asserts live in `sitl/measure-peer-table.js`.
- **Nodes:** config triplet, `command` chain, `move` velocity stream, `state` snapshot,
  `inject`, `debug`.
- **Config/launch:** `restart: ap-1`.

### sitl/27 — Move reposition carrier (AP)

- **File:** `examples/sitl/27-move-reposition-carrier.json` · **Tab:** `SITL 27 Move reposition carrier`
- **Story:** Move's acked goto (`action: "goto"`, `delivery: "confirm"` —
  `DO_REPOSITION`/COMMAND_INT derived, not configured) against ArduCopter sysid 1 — same
  goto SITL 23 flies through Command, routed through `mavlink-move` instead (#239).
- **Nodes:** config triplet, `command` prep, `move` (`action: "goto"`, confirm), `inject`,
  `debug`.
- **Config/launch:** `restart: ap-1`.

### 28–30 — PX4 flight (`px4-1`)

### sitl/28 — TEMPORARILY_REJECTED → backoff and retry

- **File:** `examples/sitl/28-temporarily-rejected.json` · **Tab:** `SITL 28 Temporarily rejected`
- **Story:** PX4 `DO_SET_MODE` with the wrong HEARTBEAT-packed custom_mode draws stable
  `TEMPORARILY_REJECTED (1)`; AckWaiter backs off until `maxRetries` exhausts (§14).
- **Nodes:** config triplet (PX4 sysid 11), `command` set_mode(`confirm`), `inject`,
  `debug`.
- **Config/launch:** bind `14560`→`14561`; `restart: px4-1`.

### sitl/29 — INT carrier goto (PX4)

- **File:** `examples/sitl/29-int-carrier-goto.json` · **Tab:** `SITL 29 INT carrier goto`
- **Story:** Arm → takeoff (LONG) → Move goto, which rides `DO_REPOSITION` on the INT
  carrier, against PX4 sysid 11; decimal degrees become degE7 on the wire.
- **Nodes:** config triplet (PX4), `command` arm/takeoff, `move` goto (Send & confirm), `inject`, `debug`.
- **Config/launch:** `restart: px4-1`.

### sitl/30 — PX4 Move reposition

- **File:** `examples/sitl/30-px4-move-reposition.json` · **Tab:** `SITL 30 PX4 Move reposition`
- **Story:** PX4 twin of SITL 27 — `DO_REPOSITION` via `mavlink-move` (`action: "goto"`,
  `delivery: "confirm"`) with CHANGE_MODE on (the shape SITL 29 measured accepted through
  Command). Records ACK either way; yaw 90 → EAST (§14 / #239).
- **Nodes:** config triplet (PX4), `command` arm/takeoff, `move` goto (confirm), `inject`,
  `debug`.
- **Config/launch:** `restart: px4-1`.

### 31–35 — AP fleet (`ap-fleet`)

### sitl/31 — Five-vehicle fan-out pacing

- **File:** `examples/sitl/31-fanout-sequential-five.json` · **Tab:** `SITL 31 Fan-out ×5 pacing`
- **Story:** Sequential arm across ArduPilot sysids 1–5 with 200 ms pacing, Build-tier preview first.
- **Nodes:** config triplet, `command` (Build, Arm) → 2× `fanout`, `inject`, `debug`.
- **Config/launch:** five ArduCopters; `restart: ap-fleet`.

### sitl/32 — Fan-out member expires mid-fan-out

- **File:** `examples/sitl/32-fanout-member-expires.json` · **Tab:** `SITL 32 Fan-out member expires`
- **Story:** Sequential fan-out across five, then kill one SITL instance partway; aggregate
  reports the dropped member as failed (§10).
- **Nodes:** config triplet, `command` → `fanout` (`sequential` `confirm`), `state` feed,
  `inject`, `debug`.
- **Config/launch:** five ArduCopters; `restart: ap-fleet`.

### sitl/33 — Broadcast vs sequential arm

- **File:** `examples/sitl/33-broadcast-vs-sequential.json` · **Tab:** `SITL 33 Broadcast vs sequential`
- **Story:** Arm the five-ArduPilot group two ways: sequential (paced acks) versus
  `target_system=0` broadcast confirmed via peer-table armed state (§10).
- **Nodes:** config triplet, 2× `fanout` paths, `state` snapshot, `inject`, `debug`.
- **Config/launch:** `restart: ap-fleet`.

### sitl/34 — Formation basics

- **File:** `examples/sitl/34-formation-basics.json` · **Tab:** `SITL 34 Formation basics`
- **Story:** Fan-out formation offsets / basic multi-vehicle formation exercise on the AP
  five.
- **Nodes:** config triplet, `move`/`fanout`, `inject`, `debug`.
- **Config/launch:** `restart: ap-fleet`.

### sitl/35 — Lucy in the Sky

- **File:** `examples/sitl/35-lucy-in-the-sky.json` · **Tab:** `SITL 35 Lucy in the Sky`
- **Story:** Full formation choreography demo on the AP fleet (see §14 Lucy notes).
- **Nodes:** config triplet, formation chain, `inject`, `debug`.
- **Config/launch:** `restart: ap-fleet`.

### 36–38 — Full fleet (`fleet`)

### sitl/36 — Mode tables per stack

- **File:** `examples/sitl/36-mode-tables.json` · **Tab:** `SITL 36 Mode tables`
- **Story:** Set flight modes on both stacks from the profile mode table — ArduCopter
  `GUIDED=4` versus PX4's encoded main/sub-mode bitfield. Never cross-use mode numbers.
- **Nodes:** 1 identity, 2 vehicles, 2 connections, per-stack `command` `set_mode`, `state`
  feed, `inject`, `debug`.
- **Config/launch:** sysid 1 + sysid 11; `restart: fleet`.

### sitl/37 — Dual-stack ten vehicles

- **File:** `examples/sitl/37-dual-stack-ten.json` · **Tab:** `SITL 37 Dual-stack ×10`
- **Story:** Both connections live — five ArduPilot (1–5) + five PX4 (11–15) — State feed
  of all ten peers and per-stack broadcast arm.
- **Nodes:** 1 identity, 2 vehicles, 2 connections, 2× `fanout` (`broadcast`), `state` feed,
  `inject`, `debug`.
- **Config/launch:** Docker lab; `restart: fleet`.

### sitl/38 — Signing

- **File:** `examples/sitl/38-signing.json` · **Tab:** `SITL 38 Signing`
- **Story:** Sign-outbound + require-signed inbound with a passphrase credential, plus a
  listen-only companion that is require-signed with sign-off. Bring-up / dry-run notes for
  SITL signature verification (§7).
- **Nodes:** identity (+ signing credential), 2× `connection`, `in`, `state`, `command`,
  `debug`.
- **Config/launch:** matching key on the SITL side; `restart: fleet`.

### sitl/39 — Companion health lease

- **File:** `examples/sitl/39-companion-health-lease.json` · **Tab:** `SITL 39 Health Lease`
- **Story:** `mavlink-health` on the companion identity (sysid 20 / compid 191) with a 5 s
  TTL lease. Assert `ok` arms/renews the lease and the companion HEARTBEAT rides; silence
  past the TTL or an explicit `fatal` faults the identity and stops the HEARTBEAT — the
  vehicle's companion-loss behavior is the point.
- **Nodes:** companion identity, vehicle, `connection`, `health` (5 s lease), 2× `inject`
  (`{health:'ok'}`, `{health:'fatal'}`), 2× `debug`.
- **Key config:** bind `14540`→`14541`; Docker service `ap-companion-20`.

### sitl/40 — Flight transition events

- **File:** `examples/sitl/40-transition-events.json` · **Tab:** `SITL 40 Transition events`
- **Story:** A State feed subscribed to only the six `*-changed` events while a flight
  chain (GUIDED → 2 s settle → arm → `EXTENDED_SYS_STATE` interval → takeoff) drives
  `mode-changed`, `armed-changed`, `home-changed`, and `landed-changed`. Prep is
  arm-ready without GUIDED so the flow's Set GUIDED is a real edge. ARM cannot
  ride the GUIDED ACK: same-tick arm is FAILED on Copter-4.7.0. Edges only — no
  heartbeat traffic — and nothing fires at connect, because first observation is
  not a transition.
- **Nodes:** identity, vehicle, `connection`, `state` (feed), `command` ×4, `debug`.
- **Config/launch:** AP sysid 1 on 14550→14551; `restart: ap-1`; EXTENDED_SYS_STATE (245)
  must be requested via `set_message_interval` — this SITL does not send it unasked.

---

## 3. `examples/sitl/README.md` outline

The folder README is shipped — keep it aligned with the table in §2 and
[`examples/sitl/README.md`](sitl/README.md). Suggested sections:

1. **What this folder is** — flows that require the live SITL rig (completion timing, mode
   tables, PX4 param union, mission/fence/rally, fan-out pacing, signing).
2. **The rig (§13)** — five ArduPilot at sysids 1–5, five PX4 at 11–15, separate
   connections; companions 20/21; payload 31.
3. **Docker lab** — `cd sitl && docker compose --profile sitl up -d --build`.
4. **Suite order / selective restart** — numbered 01–40 by `PROFILE.restart` phase.
5. **Signing** — sitl/38 documents the dry-run procedure. Off by default elsewhere.
6. **Safety** — SITL only; never point these at a real vehicle without understanding each
   step.
