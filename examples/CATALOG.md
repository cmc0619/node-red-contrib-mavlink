# Example flow catalog — `node-red-contrib-mavlink`

Index of the **shipped** importable Node-RED flows under `examples/` and
`examples/sitl/`. Node names, preset ids, delivery tiers, config keys, and firmware
facts match the package nodes and `DESIGN.md`. Section 3's README outline and section 4's
rename table are historical notes from when the set was assembled — the JSON files are
already in-tree.

Contents:

1. [Node/preset cheat-sheet](#0-cheat-sheet) — the exact strings the flows must use
2. [Regular examples (10–27)](#1-regular-examples-1027)
3. [SITL folder (`examples/sitl/`)](#2-sitl-folder-examplessitl) — see also [`sitl/README.md`](sitl/README.md)
4. [`examples/sitl/README.md` outline](#3-examplessitlreadmemd-outline)
5. [Renames / moves of 06–09](#4-renames--moves-of-0609)

---

## 0. Cheat-sheet

Config keys and enumerated values, verified against the node source. The flows below
reference these by name rather than re-explaining them each time.

**Delivery tiers per node** (the `delivery`/`tier` config value):

| Node | Values |
|---|---|
| `mavlink-command` | `build` \| `send` \| `confirm` \| `complete` |
| `mavlink-move` | `build` \| `send` \| `stream` |
| `mavlink-param` | `build` \| `send` \| `confirm` (set echo) \| `collect` (list) |
| `mavlink-payload` | `build` \| `send` \| `confirm` |
| `mavlink-build` | `build` \| `send` (config key is `tier`) |
| `mavlink-fanout` | `build` \| `send` \| `confirm` |

**Command presets** (`mode: "preset"`, `preset: <id>`): `arm`, `disarm`, `set_mode`,
`takeoff`, `land`, `rtl`, `set_home`, `reposition`, `change_speed`, `yaw`, `rotate`,
`orbit`, `mission_start`, `pause`, `resume`, `request_message`, `set_message_interval`,
`stop_message_interval`, `reboot_autopilot`, `flight_termination`. Advanced mode is
`mode: "advanced"`, `advancedCommand: "<MAV_CMD numeric>"`. `params` is a JSON string
keyed by param index (`"{\"7\":20}"` = param7 = 20).

**Move** `mode`: `position`, `velocity`, `position-velocity`, `acceleration`, `force`,
`yaw-only`; `frame` picks local (N/E/Up metres) vs global (`lat`/`lon` deg, `alt` m)
and the body/offset/altitude-datum variants. `intervalMs`, `ttlMs` govern the stream.
Up is up-positive in the UI; the node flips to NED at encode. **No arc primitive** — a
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
`primary-changed`, `multi-endpoint`, `profile-mismatch`, `statustext`.

**In** filters: `message`, `sysid`, `compid`, `changedOnly`, `rateLimit` (Hz).

**Fan-out** is a replicator: wire a Build-tier action node into it and it retargets
the built `{name, fields}` message per member. `selectionMode`: `all` \| `list`
(`sysids: "1,2,3"`) \| `filter` (`vehicleType`/`firmwareFilter`/`armedFilter`);
`executionMode`: `sequential` (`intervalMs`, `concurrency`) \| `broadcast`
(`target_system=0`); `dryRun` bool. Payload wrapper `{message, targets}` patches
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
  5. `rotate` (CONDITION_YAW relative) — `params {"1":360,"2":30,"3":1}` (360° CW at
     30°/s); `confirm`.
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
  `function` (ring generator — the only computed part), `move` (`mode: "position"`,
  `frame: "GLOBAL_RELATIVE_ALT_INT"`, `delivery: "stream"`, `intervalMs: 200`, `ttlMs: 1500`), `debug`.
- **Key config:** Function computes `lat = c_lat + (R·sinθ)/111320`,
  `lon = c_lon + (R·cosθ)/(111320·cos c_lat)` per §"Coordinate frames"; emits
  `{payload:{mode:"position",frame:"GLOBAL_RELATIVE_ALT_INT",position:{lat,lon,alt}}}`. Move TTL means the stream
  self-stops if injects stop arriving. Comment states plainly: no arc primitive exists;
  the ring is the flow author's maths.
- **Inject buttons:** **`Arm+GUIDED+Takeoff`**, **`◯ Fly circle`** (repeat inject at 5 Hz
  feeding the Function), **`■ Stop circle`** (`payload:false` to suppress), **`Land`**.

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

### 14 — Peer table & events (State)

- **File:** `examples/14-peer-events.json`
- **Tab label:** `14 Peer table & events`
- **Story:** A live operations panel: a State feed emits edge events as vehicles appear,
  go stale, change their primary endpoint, or shout STATUSTEXT, while a second State node
  snapshots the whole peer table on demand. This is how a flow reacts to fleet changes
  without polling.
- **Nodes:** config triplet, `state` (`mode: "feed"`, `events` = all ten), `state`
  (snapshot), `inject` `Snapshot now`, `debug`.
- **Key config:** feed events list spelled out so the demo shows `peer-new`/`stale`/
  `expired`/`primary-changed`/`profile-mismatch`. Snapshot node reads on inject and on a
  1 s repeat option. Comment: bind a `profile-mismatch` warning to an ArduPilot connection
  that a PX4 vehicle wandered onto to demonstrate the §7 binding check.
- **Inject buttons:** **`Snapshot now`**, **`Snapshot sysid 1 only`**
  (`payload:{sysid:1}`).

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
  a polygon geofence and a rally point, then clear behind a confirmation gate. Exercises
  all three mission actions and all three plan types, and shows that a failed upload never
  degrades into a clear.
- **Nodes:** config triplet (ArduPilot — carries all three plan types), `mission` ×:
  upload/mission, download/mission, upload/fence, upload/rally, clear/mission; `inject`
  (each carrying the item array); `debug` on status ports for progress records.
- **Key config:** mission items are NAV_WAYPOINT (`command:16`) + a `DO_CHANGE_SPEED`
  (`command:178`) to show DO items are legal in a plan (§9 / §14); fence items
  `MAV_CMD_NAV_FENCE_POLYGON_VERTEX_*`; rally `MAV_CMD_NAV_RALLY_POINT`. Clear inject
  carries `{confirmed:true}`. Comment: fence/rally only on ArduPilot (see SITL S6).
- **Inject buttons:** **`Upload mission`**, **`Download mission`**, **`Upload fence`**,
  **`Upload rally`**, **`⚠ Clear mission (confirm)`**.

### 22 — Go-to tour (Reposition, with NaN yaw hold)

- **File:** `examples/22-goto-tour.json`
- **Tab label:** `22 Go-to tour`
- **Story:** Send a GUIDED copter hopping between three points with `DO_REPOSITION`, each
  hop holding the current heading by passing `NaN` as yaw — a live demonstration of the §5
  rule that `NaN` is a real sentinel in exactly the fields whose metadata declares it.
- **Nodes:** config triplet, `command` arm→set_mode GUIDED (complete), 3× `command`
  `reposition`, `inject`, `debug`.
- **Key config:** each reposition `params` sets param4 (yaw) = `NaN` (hold), param5/6/7 =
  lat/lon/alt, param1 = ground speed. Comment: the editor must be able to emit `NaN` here;
  `JSON.stringify` cannot carry it, so the flow uses the node's NaN control, not a raw
  payload literal.
- **Inject buttons:** **`Arm + GUIDED`**, **`Go point A`**, **`Go point B`**,
  **`Go point C`**.

### 23 — Guided velocity joystick (Move velocity stream)

- **File:** `examples/23-velocity-joystick.json`
- **Tab label:** `23 Velocity joystick`
- **Story:** Nudge a GUIDED copter around with velocity setpoints: four buttons stream
  N/E/Up velocity through a Move node with a short TTL, so releasing a button lets the
  stream lapse and the vehicle stops — the freshness-and-stop contract that keeps a
  streamed control from running away.
- **Nodes:** config triplet, `command` arm→GUIDED, `move` (`mode: "velocity"`, `frame: "LOCAL_NED"`,
  `delivery: "stream"`, `intervalMs: 100`, `ttlMs: 500`), `inject` (velocity presets),
  `debug`.
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
- **Nodes:** config triplet, `move` (Build, velocity north 1 m/s) feeding 3× `fanout`
  (dry-run; `executionMode: "sequential"` `intervalMs: 150`; `broadcast`), `inject`, `debug`.
- **Key config:** selection `list` `sysids: "1,2,3,4,5"` (broadcast uses `all`); the Move
  node builds the setpoint, the fan-outs replicate it; broadcast pins `target_system=0`,
  single-stack only. Dry-run inject shows the expanded plan first. Comment references §10
  broadcast rules.
- **Inject buttons:** **`Dry run`**, **`Nudge (sequential)`**, **`Nudge (broadcast)`**.

### 25 — Speed & yaw choreography

- **File:** `examples/25-speed-yaw-choreo.json`
- **Tab label:** `25 Speed & yaw choreography`
- **Story:** A small aerobatic-ish routine for GUIDED: change ground speed, yaw to an
  absolute heading, then rotate relative — the three Autonomy presets built on
  `DO_CHANGE_SPEED` and `CONDITION_YAW`, with the Yaw/Rotate pair showing one command with
  the relative flag pinned two ways.
- **Nodes:** config triplet, `command` arm→GUIDED→takeoff (complete), `command`
  `change_speed`, `command` `yaw`, `command` `rotate`, `inject`, `debug`.
- **Key config:** change_speed `params {"1":1,"2":8,"3":-1}` (airspeed type enum, 8 m/s,
  no throttle change); yaw `params {"1":90,"2":20,"3":1}` (to 90° CW); rotate `params
  {"1":45,"2":20,"3":1}` (relative +45°). Comment: Yaw pins param4=0, Rotate pins
  param4=1 — same `MAV_CMD`.
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
verifier. Each flow's tab comment carries the **exact launch command(s)** for the
instances it needs. Filenames restart at `01` inside the folder.

### sitl/01 — Completion: IN_PROGRESS → ACCEPTED takeoff  *(moved from 06)*

- **File:** `examples/sitl/01-completion-takeoff.json` · **Tab:** `SITL 01 Completion takeoff`
- **Story:** Arm then take off with `delivery: "complete"` and watch the node correctly
  wait through the `IN_PROGRESS` ack for the terminal `ACCEPTED` once the copter is
  actually at altitude — the pain point that a naïve implementation reports early.
- **Nodes:** config triplet (ArduPilot sysid 1), `command` arm(confirm)→takeoff(complete),
  `inject`, `debug`.
- **Config/launch:** bind `14550`→`14551`; `completionTimeout ≥ 30000`.
  `sim_vehicle.py -v ArduCopter --out=udp:127.0.0.1:14550`.

### sitl/02 — Completion timeout: accepts but never climbs

- **File:** `examples/sitl/02-completion-timeout.json` · **Tab:** `SITL 02 Completion timeout`
- **Story:** Deliberately provoke the timeout branch — take off **without** first entering
  GUIDED (or with a low `completionTimeout`) so the vehicle accepts the command yet never
  reaches altitude; the wait ends, output 0 stays silent, and the status names the timeout.
- **Nodes:** config triplet, `command` takeoff (`complete`, `completionTimeout: 8000`),
  `inject`, `debug`.
- **Config/launch:** same single ArduCopter instance; comment tells the operator to skip
  the mode/arm prep so the climb never happens.

### sitl/03 — TEMPORARILY_REJECTED → back off and retry

- **File:** `examples/sitl/03-temporarily-rejected.json` · **Tab:** `SITL 03 Temporarily rejected`
- **Story:** Fire arm/takeoff the instant SITL boots, before GPS lock, to draw a
  `TEMPORARILY_REJECTED (1)`; the node backs off and retries and eventually succeeds —
  the readiness answer coming from the vehicle, not a client-side precondition table (§9).
- **Nodes:** config triplet, `command` arm→takeoff (`confirm`, `maxRetries: 5`), `inject`
  (fire immediately / `once`), `debug` (show the retry count in the status record).
- **Config/launch:** ArduCopter fresh boot; comment: inject `once` at deploy to race GPS.

### sitl/04 — Mode tables per stack (ArduPilot vs PX4)

- **File:** `examples/sitl/04-mode-tables.json` · **Tab:** `SITL 04 Mode tables`
- **Story:** Set flight modes on both stacks from the profile mode table and prove the
  `DO_SET_MODE` custom_mode differs — ArduCopter's small integer (`GUIDED=4`) versus PX4's
  encoded main/sub-mode bitfield — so a value that works on one is meaningless on the
  other. The headline "firmware-gated behaviour cannot be faked" demo.
- **Nodes:** 1 identity, 2 vehicles (ardupilot + px4), 2 connections, per-stack `command`
  `set_mode` (`complete`), `state` feed to read active mode, `inject`, `debug`.
- **Config/launch:** both single instances (sysid 1 + sysid 11) on their own ports;
  comment carries the ArduPilot and PX4 mode numbers and warns against cross-use.

### sitl/05 — PX4 parameter int/float union

- **File:** `examples/sitl/05-px4-param-union.json` · **Tab:** `SITL 05 PX4 param union`
- **Story:** Set an integer PX4 parameter (e.g. `COM_RC_IN_MODE`) and read it back to show
  the value survives the int/float **union** reinterpretation rather than a numeric cast —
  the corruption §11 warns about, only observable against real PX4.
- **Nodes:** config triplet (PX4 sysid 11), `param` set(`confirm`)→read, `inject`, `debug`.
- **Config/launch:** PX4 SITL, `paramType: "MAV_PARAM_TYPE_INT32"`; comment: verify the
  echo integer matches, not a float-cast neighbour.

### sitl/06 — Mission / fence / rally per firmware

- **File:** `examples/sitl/06-mission-fence-rally.json` · **Tab:** `SITL 06 Mission/fence/rally`
- **Story:** Upload mission + fence + rally to ArduPilot (all three supported), then send
  the same fence/rally to PX4 and watch the node refuse fail-loud because PX4 doesn't carry
  them over this protocol — the firmware-gated type list in action.
- **Nodes:** 1 identity, 2 vehicles, 2 connections, `mission` ×5 (ArduPilot: mission/fence/
  rally upload; PX4: fence upload → expected failure), `inject`, `debug`.
- **Config/launch:** ArduCopter sysid 1 + PX4 sysid 11; comment shows both launches and
  that the PX4 fence attempt should surface `px4 does not support fence`.

### sitl/07 — Malformed mission upload fails, never clears

- **File:** `examples/sitl/07-mission-failloud.json` · **Tab:** `SITL 07 Mission fail-loud`
- **Story:** First upload a good mission, then upload a malformed one (a fence command id
  smuggled into a mission plan, or a NaN coordinate) and confirm the transfer **fails** and
  leaves the previously-good mission intact — it must never degrade into a clear (§9).
- **Nodes:** config triplet, `mission` upload(good)→download(verify)→upload(bad)→
  download(verify unchanged), `inject`, `debug`.
- **Config/launch:** single ArduCopter; comment: the bad item is rejected by the per-type
  validator before or during transfer; the download after proves the good plan survived.

### sitl/08 — Five-vehicle fan-out pacing  *(moved from 07)*

- **File:** `examples/sitl/08-fanout-sequential-five.json` · **Tab:** `SITL 08 Fan-out ×5 pacing`
- **Story:** Sequential arm across ArduPilot sysids 1–5 on one connection with 200 ms
  pacing, dry-run first; exercises the peer table, queue pacing, and fan-out aggregation
  across the full five-instance rig.
- **Nodes:** config triplet, `command` (Build, preset Arm) per path feeding 2× `fanout`
  (dry-run + live, `list` 1–5, `sequential` `intervalMs: 200`), `inject`, `debug`.
- **Config/launch:** the five-ArduCopter loop (see README); bind `14550`→`14551`.

### sitl/09 — Fan-out member expires mid-fan-out

- **File:** `examples/sitl/09-fanout-member-expires.json` · **Tab:** `SITL 09 Fan-out member expires`
- **Story:** Start a sequential fan-out across five, then kill one SITL instance partway;
  the run continues, and the aggregate reports the dropped member as failed rather than
  aborting or silently re-resolving the group (§10).
- **Nodes:** config triplet, `command` (Build, preset Arm) feeding `fanout` (`sequential`,
  `confirm`, `intervalMs: 500` to give a human time to kill one), `state` feed (watch the
  `expired` event), `inject`, `debug`.
- **Config/launch:** five ArduCopters; comment: `kill` one instance's PID after the run
  starts; expect one `failed` entry in the aggregate, four succeeded.

### sitl/10 — Dual-stack ten vehicles, one panel

- **File:** `examples/sitl/10-dual-stack-ten.json` · **Tab:** `SITL 10 Dual-stack ×10`
- **Story:** Both connections live at once — five ArduPilot (1–5) + five PX4 (11–15) — with
  a State feed showing all ten peers and a per-stack broadcast arm (two broadcasts, one per
  connection, because a broadcast is single-stack). The whole-rig integration demo.
- **Nodes:** 1 identity, 2 vehicles, 2 connections, `command` (Build, preset Arm) per stack
  feeding 2× `fanout` (`broadcast` per stack), `state` feed, `inject`, `debug`.
- **Config/launch:** prefer `sitl/docker-compose.yml` (`--profile sitl`); AP bind
  `14550`→`14551`, PX4 bind `14560`→`14561`.

### SITL 15 — Companion ArduPilot (sysid 20)

- **File:** `examples/sitl/15-companion-ap.json` · **Tab:** `SITL 15 Companion AP`
- **Story:** Node-RED companion identity sharing sysid 20 / compid 191 on the lab companion ports.
- **Key config:** bind `14540`→`14541`; vehicle firmware ardupilot; Docker service `ap-companion-20`.

### SITL 16 — Companion PX4 (sysid 21)

- **File:** `examples/sitl/16-companion-px4.json` · **Tab:** `SITL 16 Companion PX4`
- **Story:** Companion identity sharing sysid 21 on PX4 companion ports.
- **Key config:** bind `14542`→`14543`; vehicle firmware px4; Docker service `px4-companion-21`.


### sitl/11 — Broadcast vs sequential arm, confirmed by state

- **File:** `examples/sitl/11-broadcast-vs-sequential.json` · **Tab:** `SITL 11 Broadcast vs sequential`
- **Story:** Arm the five-ArduPilot group two ways and compare: sequential fan-out (paced,
  per-vehicle acks) versus a single `target_system=0` broadcast confirmed by polling the
  peer-table armed state rather than counting the ack storm (§10).
- **Nodes:** config triplet, `command` (Build, preset Arm) per path feeding 2× `fanout`
  (sequential confirm; broadcast + `confirm` waiting on the resolved set), `state`
  snapshot, `inject`, `debug`.
- **Config/launch:** five ArduCopters; comment on the inbound ack-burst congestion note.

### sitl/12 — Signing: sign-outbound + require-signed (dry-run notes)

- **File:** `examples/sitl/12-signing.json` · **Tab:** `SITL 12 Signing`
- **Story:** A signing bring-up flow: one connection with **sign outbound** + **require
  signed inbound** enabled and a passphrase credential, plus a listen-only companion
  connection that is **require-signed with sign-off**. Mostly a configured template with a
  heavily-commented dry-run procedure, since making SITL actually verify signatures is
  version- and setup-dependent.
- **Nodes:** identity (+ signing credential ref), `vehicle`, 2× `connection` (signing
  switches set), `in` (watch `trusted` flag), `state` feed (untrusted indication),
  `command` arm (to send a signed frame), `debug`.
- **Config/launch:** comment walks the operator through setting a matching key on the SITL
  side and enabling signing, and states plainly which parts are dry-run notes vs live;
  first-contact / one-minute-window / monotonic-timestamp behaviour called out (§7).

### sitl/13 — Live param defs labels  *(moved from 08)*

- **File:** `examples/sitl/13-param-defs-live.json` · **Tab:** `SITL 13 Param defs (live)`
- **Story:** Read and set parameters on a live ArduCopter with the ArduPilot `apm.pdef.json`
  definitions bound to the profile, so values render with units, ranges, and enum labels —
  and request-list collects the full set. The bench-fetched defs meet live firmware here.
- **Nodes:** config triplet (Vehicle `paramDefsUrl` = ArduCopter pdef or family-derived),
  `param` read/set(`confirm`)/request-list(`collect`), `inject`, `debug`.
- **Config/launch:** single ArduCopter; comment: defs fetch needs internet once at the
  bench; read/set behaviour needs the live vehicle.

### sitl/14 — Command + mission basics on two instances  *(moved from 09)*

- **File:** `examples/sitl/14-command-mission-basics.json` · **Tab:** `SITL 14 Command & mission basics`
- **Story:** The original 09 demo, now folded into the rig folder: preset + advanced
  commands on sysid 1 and a mission upload/download on sysid 2, two ArduPilot instances on
  one connection, showing target-by-sysid routing on a shared link.
- **Nodes:** config triplet, `command` arm + advanced `set_message_interval`, `mission`
  upload/download to sysid 2, `inject`, `debug`.
- **Config/launch:** two ArduCopter instances (sysid 1, 2) both `--out=udp:127.0.0.1:14550`.

### sitl/28 — Param read by index

- **File:** `examples/sitl/28-param-read-by-index.json` · **Tab:** `SITL 28 Param read by index`
- **Story:** Collect the AP param table, pick `LOIT_SPEED_MS` by index, then send
  `PARAM_REQUEST_READ` with `param_index ≥ 0` and empty `param_id`.
- **Nodes:** config triplet, `param` collect → function → `param` read(send) → assert, `debug`.

### sitl/29 — Param fan-out set

- **File:** `examples/sitl/29-param-fanout-set.json` · **Tab:** `SITL 29 Param fan-out set`
- **Story:** Build-tier `PARAM_SET` of `LOIT_SPEED_MS=10` then sequential fan-out
  echo-confirm across AP sysids 1–5 (§10 sequential-only for sets).
- **Nodes:** config triplet, `param` (Build) → `fanout` (confirm), `inject`, `debug`.

### sitl/30 — PX4 param list collect

- **File:** `examples/sitl/30-px4-param-list.json` · **Tab:** `SITL 30 PX4 param list`
- **Story:** PX4 `request-list` + collect (the AP-only path in sitl/13), asserting known
  ids `COM_RC_IN_MODE` and `MPC_XY_VEL_MAX`.
- **Nodes:** config triplet (PX4 sysid 11), `param` collect → assert, `inject`, `debug`.

### sitl/31 — Param encoding override

- **File:** `examples/sitl/31-param-encoding-override.json` · **Tab:** `SITL 31 Param encoding override`
- **Story:** Explicit `msg.payload.paramEncoding` on both stacks — PX4 `bytewise` INT32
  and ArduPilot `c-cast` INT32 — each echo-confirmed (§11 ladder).
- **Nodes:** dual connections, 2× `param` set(confirm) with JSON inject payloads, `debug`.

### sitl/32 — Param echo timeout (unknown id)

- **File:** `examples/sitl/32-param-echo-timeout.json` · **Tab:** `SITL 32 Param echo timeout`
- **Story:** Deliberate set of missing `WPNAV_SPEED` on Copter 4.7.0; confirm must finish
  as `timed-out` / `echo timeout` (negative twin of sitl/21).
- **Nodes:** config triplet, `param` set(confirm, 5 s timeout), `inject`, `debug`.

---

## 3. `examples/sitl/README.md` outline

Short README to drop into the folder. Suggested sections:

1. **What this folder is** — one paragraph: flows that require the live SITL rig because
   they test firmware behaviour that cannot be faked with fixtures (completion timing, mode
   tables, the PX4 param union, mission/fence/rally per stack, fan-out pacing, signing).
   Top-level `examples/` demos work against any link; these need real firmware.
2. **The rig (§13)** — five ArduPilot at sysids 1–5, five PX4 at sysids 11–15, on
   **separate connections**, one Vehicle Profile per stack. Note the deliberate 1–5 / 11–15
   gap: a mistyped sysid lands nowhere, not on the wrong stack.
3. **Start the ArduPilot five** — the copy-paste loop:
   ```bash
   for i in 0 1 2 3 4; do \
     sim_vehicle.py -v ArduCopter -I $i --sysid $((i+1)) \
       --out=udp:127.0.0.1:14550 & \
   done
   ```
   Bind the ArduPilot Connection to `127.0.0.1:14550` (receives `--out`), remote
   `127.0.0.1:14551` (command destination).
4. **Start the PX4 five** — best-effort with a caveat that PX4 multi-instance networking is
   version-specific: e.g. `./Tools/simulation/sitl_multiple_run.sh 5` (or per-instance
   `make px4_sitl` with `PX4_INSTANCE`), then set `MAV_SYS_ID` = 11–15 per instance. Note
   PX4 emits its GCS MAVLink on a different port set than ArduPilot; point the PX4
   Connection at the port your build uses (commonly `14550` broadcast or `14570`/`14580`)
   and **verify against your PX4 version** — do not assume ArduPilot's ports.
5. **One vs five** — most flows use one instance; fan-out/dual-stack flows use five per stack.
   Each flow's tab comment names exactly which instances it needs.
6. **Signing** — extra setup: a matching key on the SITL side; sitl/12 documents the
   dry-run procedure. Off by default everywhere else.
7. **What is *not* provisioned** — SITL itself is the operator's local rig; nothing here
   launches it for you, and the fixture test suite (`node --test`) covers everything that
   doesn't need firmware. Cross-connection fan-out is out of scope (§10).
8. **Safety** — SITL only; several flows arm, fly, flip, terminate, or force-disarm. Never
   point these at a real vehicle without understanding each step.

---

## 4. Renames / moves of 06–09

Recommendation: **move the rig-specific 06–09 into `examples/sitl/`**, leave the general
demos 01–05 at top level. Rationale — 01–05 illustrate a node/contract against any single
link and belong in the front-door example set; 06–09 assume the §13 rig (five instances,
two stacks, live completion/param/mission behaviour) and are pain-tests, which is exactly
what `sitl/` is for.

| Current | Action | New path | Why |
|---|---|---|---|
| `01-udp-heartbeat.json` | **keep** | `examples/01-udp-heartbeat.json` | general first-contact demo; any link |
| `02-arm-takeoff-chain.json` | **keep** | `examples/02-arm-takeoff-chain.json` | general chain-model demo |
| `03-param-read-set.json` | **keep** | `examples/03-param-read-set.json` | general Param demo |
| `04-mission-upload-download.json` | **keep** | `examples/04-mission-upload-download.json` | general Mission demo |
| `05-fanout-arm.json` | **keep** | `examples/05-fanout-arm.json` | general Fan-out demo (small list) |
| `06-sitl-completion-takeoff.json` | **move + renumber** | `examples/sitl/01-completion-takeoff.json` | completion timing is firmware behaviour (§13) |
| `07-ardupilot-swarm-sequential.json` | **move + renumber** | `examples/sitl/08-fanout-sequential-five.json` | needs the five-instance rig |
| `08-param-read-set-defs.json` | **move + renumber** | `examples/sitl/13-param-defs-live.json` | live param read/set + defs against real firmware |
| `09-command-mission.json` | **move + renumber** | `examples/sitl/14-command-mission-basics.json` | assumes two SITL instances / rig routing |

Notes for the mover:

- Update each moved flow's **tab `label`** to the new `SITL NN …` form and keep the exact
  launch command already present in its comment (06/07/09 already carry `sim_vehicle.py`
  lines; 08 should gain one).
- Renumbering is cosmetic — Node-RED imports by node `id`, not filename — but keeping the
  `sitl/NN` order aligned with this catalog helps the reader.
- If the package's `package.json` enumerates examples under `node-red.examples`, add the
  `sitl/` entries there so they appear in the editor's import menu.
- The new regular examples continue at **10–27**; the `sitl/` set is numbered **01–14**
  within its own folder.
