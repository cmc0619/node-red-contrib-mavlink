# MAVLINK.md

MAVLink protocol lessons learned while building this toolkit. This file is the
protocol-fact counterpart to `DESIGN.md` §14: `DESIGN.md` records how the toolkit must be
built; this file records what the MAVLink protocol actually does.

## The certainty gate (read before adding anything)

An entry is written **only when sure**. "Sure" means confirmed against:

- the dialect XML (the message/enum definitions compiled from `mavlink-mappings`); or
- measured on-wire behavior — a SITL capture or real-vehicle exchange, recorded as a §14
  ground-truth entry in `DESIGN.md`.

Reading the established implementations — pymavlink, MAVSDK, the GCS codebases, and above all
the ArduPilot and PX4 source trees — is the right way to form the hypothesis; their behavior
is the default expectation. But an entry is only written once that hypothesis is confirmed
against the XML or the wire: even the true references disagree with each other, and with the
spec, often enough that none of them alone is ground truth (see `AGENTS.md`). If a belief is
plausible but unconfirmed, it does not go in the entries — it goes in **Open questions** below
until someone measures it.

## Entry format

Each entry:

- states the protocol fact as confirmed;
- names the evidence — dialect XML file and field, or the capture/rig that demonstrated it,
  with a date;
- notes the consequence for the toolkit — which node or `lib/` module cares, and why.

Delete or correct an entry the moment a §14 measurement contradicts it; this file is ground
truth only because it is kept honest, not because it is written down.

## Entries

**Both lab stacks answer `AVAILABLE_MODES` (435). ArduPilot Copter-4.7.0 is not mute
(2026-08-18).**
*Fact:* `MAV_CMD_REQUEST_MESSAGE` (512) with `param1=435` is `ACCEPTED` (0) on PX4 1.18.0
SIH (`px4io/px4-sitl@sha256:bab4270c…`, sysid 11 `:14560`) and ArduPilot Copter-4.7.0
(`flight_sw_version=67567871` → `4.7.0 type=255`; Compose `ARDUPILOT_REF=Copter-4.7.0`,
sysid 1 `:14550`). The AP version *is* the finding — older AP may still be mute.

The lists are request-driven, not unsolicited. Neither stack streamed `AVAILABLE_MODES`
in a 20 s watch. Dump shape differs:

1. **PX4** answers `param2=0` with all 27 frames in one burst.
2. **ArduPilot** answers `param2=0` with one frame (`mode_index=1`, `number_modes=25`)
   and requires walking `param2 = 1 … number_modes`. A client that only sends `param2=0`
   will conclude AP has a single mode.

**`CURRENT_MODE` (436).** PX4 streams it unsolicited (~10 frames / 20 s ≈ 0.5 Hz) and
`REQUEST_MESSAGE` `param1=436` is `ACCEPTED` (0). ArduPilot streams nothing; the same
request is `FAILED` (4). HEARTBEAT `custom_mode` remains the live-mode source on AP.

**What `custom_mode` is.** PX4 publishes the HEARTBEAT-packed bitfield (Hold
`0x03040000` = `50593792`, matching the live HEARTBEAT). That is a display/resolve
value, not `DO_SET_MODE` param2 — this SIH still wants the unpacked main_mode integer
there (POSCTL param2=`3`, not `196608`). ArduPilot publishes the Copter flight-mode
integer (`Stabilize=0` … `Turtle=28`), which *is* HEARTBEAT and `DO_SET_MODE` param2.

**Names.** PX4 leaves `mode_name` blank whenever `standard_mode ≠ 0`; the name lives in
`MAV_STANDARD_MODE_*` — in the shipped seed: 1 POSITION_HOLD, 2 ORBIT, 3 CRUISE,
4 ALTITUDE_HOLD, 5 SAFE_RECOVERY, 6 MISSION, 7 LAND, 8 TAKEOFF. The names first written
beside this capture (5 RETURN_HOME, 6 SAFE_RECOVERY, 7 MISSION, 8 LAND) came from the
decoding dialect and were one off; the raw numbers were right. Decoded with the seed,
T1 agrees row for row with PX4's `px4_custom_mode.h` AUTO sub-modes (TAKEOFF 2, LOITER 3,
MISSION 4, RTL 5, LAND 6), and a 2026-09-27 re-capture on the same SIH read the same
(`DESIGN.md` §14.151). PX4's own name for (4,5) is "Return"; the standard mode it
publishes for it is SAFE_RECOVERY. ArduPilot fills every `mode_name` and sets
`standard_mode=0` on all 25. PX4 indexes 20–27 are `"(Mode not available)"` with
`properties=2` (`MAV_MODE_PROPERTY_NOT_USER_SELECTABLE`).

**Decode.** pymavlink `common` 2.4.49 does not carry msgid 435/436; the capture used
`dialect='development'`. This tree's seed carries both (`AVAILABLE_MODES` 435,
`CURRENT_MODE` 436).

`AVAILABLE_MODES.properties`: 0 none, 1 `ADVANCED`, 2 `NOT_USER_SELECTABLE`, 3 both.

*Evidence:* SITL 2026-08-18, HEAD `4255a6c`; host captures
`available-modes-capture.json` / `available-modes-ap-followup.json`.
*Check:* `REQUEST_MESSAGE` 512 `param1=435` (PX4 `param2=0`; AP `param2=1…N`) on the
lab ports above. Re-measure if the PX4 digest or `ARDUPILOT_REF` moves.

*Toolkit consequence:* mode-name resolution is a ladder — vehicle list first, shipped
tables second. Rung 1 is real on both lab stacks. A baked PX4 table row that disagrees
with a published hex loses. See `DESIGN.md` §11 / §14.

**T1 — PX4 1.18.0 SIH, `number_modes=27`, one `param2=0` request** (std names from the
shipped seed):

| idx | std | custom_hex | props | mode_name |
|---|---|---|---|---|
| 1 | 0 | `0x00010000` | 1 | Manual |
| 2 | 4 ALTITUDE_HOLD | `0x00020000` | 0 | *(blank)* |
| 3 | 1 POSITION_HOLD | `0x00030000` | 0 | *(blank)* |
| 4 | 6 MISSION | `0x04040000` | 1 | *(blank)* |
| 5 | 0 | `0x03040000` | 1 | Hold |
| 6 | 5 SAFE_RECOVERY | `0x05040000` | 1 | *(blank)* |
| 7 | 0 | `0x02030000` | 1 | Position Slow |
| 8 | 0 | `0x13040000` | 1 | Guided Course |
| 9 | 0 | `0x000B0000` | 1 | Altitude Cruise |
| 10 | 0 | `0x00050000` | 1 | Acro |
| 11 | 0 | `0x000A0000` | 3 | Termination |
| 12 | 0 | `0x00060000` | 1 | Offboard |
| 13 | 0 | `0x00070000` | 1 | Stabilized |
| 14 | 8 TAKEOFF | `0x02040000` | 1 | *(blank)* |
| 15 | 7 LAND | `0x06040000` | 1 | *(blank)* |
| 16 | 0 | `0x08040000` | 1 | Follow Target |
| 17 | 0 | `0x09040000` | 1 | Precision Landing |
| 18 | 2 ORBIT | `0x01030000` | 1 | *(blank)* |
| 19 | 0 | `0x0A040000` | 1 | VTOL Takeoff |
| 20 | 0 | `0x0B040000` | 2 | (Mode not available) |
| 21 | 0 | `0x0C040000` | 2 | (Mode not available) |
| 22 | 0 | `0x0D040000` | 2 | (Mode not available) |
| 23 | 0 | `0x0E040000` | 2 | (Mode not available) |
| 24 | 0 | `0x0F040000` | 2 | (Mode not available) |
| 25 | 0 | `0x10040000` | 2 | (Mode not available) |
| 26 | 0 | `0x11040000` | 2 | (Mode not available) |
| 27 | 0 | `0x12040000` | 2 | (Mode not available) |

POSCTL is index 3, `0x00030000` (= `196608`) — the HEARTBEAT pack, not `DO_SET_MODE` param2.

**T2 — ArduPilot Copter-4.7.0, `number_modes=25`, `param2` walk 1…25; all `standard_mode=0`:**

| idx | custom | hex | props | mode_name |
|---|---|---|---|---|
| 1 | 27 | `0x0000001B` | 0 | Auto RTL |
| 2 | 3 | `0x00000003` | 0 | Auto |
| 3 | 1 | `0x00000001` | 0 | Acro |
| 4 | 0 | `0x00000000` | 0 | Stabilize |
| 5 | 2 | `0x00000002` | 0 | Altitude Hold |
| 6 | 7 | `0x00000007` | 0 | Circle |
| 7 | 5 | `0x00000005` | 0 | Loiter |
| 8 | 4 | `0x00000004` | 0 | Guided |
| 9 | 9 | `0x00000009` | 0 | Land |
| 10 | 6 | `0x00000006` | 0 | RTL |
| 11 | 11 | `0x0000000B` | 0 | Drift |
| 12 | 13 | `0x0000000D` | 0 | Sport |
| 13 | 14 | `0x0000000E` | 0 | Flip |
| 14 | 15 | `0x0000000F` | 0 | Autotune |
| 15 | 16 | `0x00000010` | 0 | Position Hold |
| 16 | 17 | `0x00000011` | 0 | Brake |
| 17 | 18 | `0x00000012` | 0 | Throw |
| 18 | 19 | `0x00000013` | 0 | Avoid ADSB |
| 19 | 20 | `0x00000014` | 0 | Guided No GPS |
| 20 | 21 | `0x00000015` | 0 | Smart RTL |
| 21 | 22 | `0x00000016` | 2 | Flow Hold |
| 22 | 23 | `0x00000017` | 2 | Follow |
| 23 | 24 | `0x00000018` | 0 | ZigZag |
| 24 | 25 | `0x00000019` | 2 | SystemID |
| 25 | 28 | `0x0000001C` | 2 | Turtle |

`properties=2`: Flow Hold, Follow, SystemID, Turtle. Copter integers 8, 10, 12, 26 were
not published.

**Camera rectangle tracking uses param5 as a camera ID (2026-09-09).**
Evidence: `common.xml`, `MAV_CMD_CAMERA_TRACK_RECTANGLE` (2005), param5
`Target Camera ID` (0..255). This is a scalar ID, not latitude. The Payload
COMMAND_INT recipe must mark param5 as raw rather than applying the frame's
coordinate scaling. A builder regression verifies that ID 255 remains x=255.

**A NaN `DO_SET_MODE` param2 aborts ArduCopter SITL; PX4 answers TEMPORARILY_REJECTED
(2026-09-27).**
*Fact:* `COMMAND_LONG` 176 with `param1=1, param2=NaN` got no ACK from ArduCopter 4.7.0
SITL, and the process died ("Floating point exception - aborting", then a segfault;
Docker restarted the container) on 3 of 3 vehicles. PX4 1.18 SIH answered
TEMPORARILY_REJECTED (1) with STATUSTEXT "Unsupported main mode" and kept its mode. What
ArduPilot hardware does with `(uint32_t)NaN` is unmeasured.
*Evidence:* `DESIGN.md` §14.152.
*Toolkit consequence:* none in the driver — NaN is a legal float and rides (§14.105).

**PX4 flies a `DO_REPOSITION` altitude as AMSL whatever the `COMMAND_INT` frame
(2026-09-27).**
*Fact:* `COMMAND_INT` 192 with `frame=3` (`GLOBAL_RELATIVE_ALT`) and `z=20` to PX4 SIH
(home 489.5 m AMSL) was ACCEPTED, and the vehicle descended to the ground and disarmed;
`mavlink_receiver.cpp` copies `z` into param7 and `navigator` reads it as AMSL.
`SET_POSITION_TARGET_GLOBAL_INT` with `coordinate_frame=6` does convert and held 20 m
above home. `frame=0` with an AMSL `z` flies as written on PX4 and ArduPilot.
*Evidence:* `DESIGN.md` §14.153 (the takeoff datum: §14.79).
*Toolkit consequence:* Formation's leader anchor rides frame 0 at the leader's AMSL
altitude. Move's Above home, and Formation's fixed anchor on frame 3, ride as chosen.

**`MANUAL_CONTROL.z` is 0…1000 with neutral 500 on ArduCopter and PX4, as on ArduSub
(2026-09-27).**
*Fact:* ArduCopter 4.7.0 discards a whole `MANUAL_CONTROL` frame whose `z < 0` — the
override then lapses after `RC_OVERRIDE_TIME` and SITL fell 4.3 m — and reads `z=0` as
minimum throttle; 500 held altitude. PX4 SIH: 500 held in Altitude, 0 descended, and
negative z added no descent.
*Evidence:* `DESIGN.md` §14.155 (ArduSub source read: §14.102).
*Toolkit consequence:* Move's help gives 0.5 as the thrust neutral on Copter, Sub and PX4.

**An ArduPilot absolute-yaw-only setpoint holds heading (2026-08-08).**
*Fact:* `SET_POSITION_TARGET_LOCAL_NED` with type_mask 2559 (yaw only) does nothing on
ArduCopter — `hold_position()` never reads the yaw. A yaw-only setpoint *with* a yaw rate
is a different mask and slews. ArduPilot yaws in guided through `CONDITION_YAW`.
*Evidence:* `DESIGN.md` §14.98.2, §14.99.
*Toolkit consequence:* Move's Turn is the ArduPilot yaw; the Steer dialog does not refuse
a yaw-only setpoint.

**`SET_ATTITUDE_TARGET` without thrust holds position on ArduCopter and is refused by
PX4 Offboard (2026-09-27).**
*Fact:* with THROTTLE_IGNORE (mask 71), ArduCopter 4.7.0 in GUIDED held position (roll
0.0°, 0.01 m drift, against 20.2° and 14.6 m with thrust). PX4 SIH refused to enter
Offboard ("Switching to Offboard is currently not available"), and dropping thrust while
in Offboard triggered its failsafe into Return.
*Evidence:* `DESIGN.md` §14.156.
*Toolkit consequence:* none in the editor or driver; thrust rides as given.

**PX4 stores the `DO_SET_HOME` yaw it is sent; a zero Orbit radius is ACKed and not
flown (2026-09-27).**
*Fact:* on PX4 SIH, `DO_SET_HOME` with param4 0 recorded home yaw 0 (north); with param4
NaN — the spec's "use default heading" — it recorded NaN; only `param1=1` ("use
current") recorded the vehicle's heading. `DO_ORBIT` with radius 0 was ACCEPTED, the mode
switched to Orbit, STATUSTEXT said "Orbit radius limit exceeded", and the vehicle did
not circle.
*Evidence:* `DESIGN.md` §14.157.
*Toolkit consequence:* Set Home pins param4 to NaN and a blank Orbit radius sends NaN; a
flow that wants PX4 to record the true heading sends `param1=1`.

**Gimbal manager angles and rates are radians on the message and degrees on the command
(ArduPilot, 2026-09-27).**
*Fact:* on ArduCopter 4.7.0 with a SITL gimbal, `GIMBAL_MANAGER_SET_PITCHYAW` reads pitch
and yaw in rad and rates in rad/s; `MAV_CMD_DO_GIMBAL_MANAGER_PITCHYAW` and
`MAV_CMD_DO_MOUNT_CONTROL` read degrees and deg/s. Rate control needs NaN angles: the
message with both angles and rates set is dropped with no ack, and the command with
angles 0/0 aims at 0/0, ignores the rates and answers ACCEPTED.
*Evidence:* `DESIGN.md` §14.166.
*Toolkit consequence:* blank manager-path angles ride NaN; the Payload help states the
units per path.

**MAVLink FTP on ArduPilot keeps 238 bytes of a path, and a long name can be missing
from a listing (2026-09-27).**
*Fact:* ArduCopter 4.7.0 (`GCS_FTP.cpp` writes NUL over the last byte of the 239-byte
`data` field) stored a 239-byte upload path as 238 bytes; a download of the same path
also succeeded, so the round trip hides the rename. A `ListDirectory` of `/` returned
neither a 237- nor a 238-byte name.
*Evidence:* `DESIGN.md` §14.167.
*Toolkit consequence:* the System dialog's path ring stays at the wire's 239 UTF-8 bytes.

## Open questions

*(Unverified beliefs worth measuring go here — never in Entries.)*

**ArduCopter holds position on a partial body-rate `SET_ATTITUDE_TARGET` (source read,
2026-09-27).** `GCS_MAVLink_Copter.cpp` `handle_message_set_attitude_target` calls
`hold_position()` unless the three body-rate ignore bits are all set or all clear. The
review's source read also says Rover and Sub drop an attitude target without thrust and
that only ArduPlane flies one. None of this is measured beyond §14.156's Copter
THROTTLE_IGNORE run.

**ArduPilot drops a `GIMBAL_MANAGER_SET_ATTITUDE` that carries an attitude and rates
(source read, Copter-4.7.0).** `AP_Mount::handle_gimbal_manager_set_attitude` returns
when neither the quaternion nor the rate vector has a NaN — and the vector it tests is
`{x, y, y}`, so `angular_velocity_z` is never checked. A NaN `q` selects rate control.
Unmeasured; the Payload attitude path carries both.

**PX4 also keeps 238 bytes of an FTP path (source read, 2026-09-27).**
`mavlink_ftp.cpp` writes NUL over the last `data` byte, as ArduPilot does (§14.167). Not
measured on PX4 SIH.

**PX4 matches `PARAM_ID` case-sensitively (source read, 2026-09-27).** `param_find` in
PX4's parameter module compares with `strcmp`, so a lowercase or space-padded
`param_id` names no parameter and is ignored. `PARAM_ID` is `char[16]`; the wire carries
either spelling. Measure: `PARAM_SET` of a lowercase id to PX4 SIH, then read it back.

**ArduPilot mission item 0 is home and is never flown; PX4 flies from item 0 (source
read, 2026-09-27).** `AP_Mission` starts at `AP_MISSION_FIRST_REAL_COMMAND` (1),
"command #0 reserved to hold home position", so an uploaded `[takeoff, waypoint]` would
not fly its takeoff on ArduPilot. To promote: upload a plan whose item 0 is a takeoff to
ArduCopter SITL, download it, and fly it.

**Log-transfer interoperability to verify on the wire (2026-09-09).**
Source inspection of [PX4 at 0d2c7058](https://github.com/PX4/PX4-Autopilot/blob/0d2c7058b328687c01ec08c8cf9f77c930aaada6/src/modules/mavlink/mavlink_log_handler.cpp)
shows `handle_log_request_list` advertising `last_log_num = num_logs` for the full
list while `state_listing` emits IDs starting at zero. `handle_log_request_data`
returns without sending when the requested offset reaches the file size; a final
full 90-byte packet therefore has no separate zero-count EOF response. It also
requires a list request before downloading. Source-matching JavaScript fixtures
reproduce the affected client behavior; these are not SITL or vehicle captures.
Measure the list metadata and exact-multiple-of-90 EOF behavior on the target PX4
release before promoting these observations to Entries. A caller-supplied exact
byte length can establish a download boundary without interpreting silence as EOF.

For comparison, [ArduPilot at 4891432f](https://github.com/ArduPilot/ardupilot/blob/4891432f35c371d432336dea78260588d3543000/libraries/AP_Logger/AP_Logger_MAVLinkLogTransfer.cpp)
uses 1-based list IDs, clamps the requested end to its log count, and sends a
zero-count data response for an offset at or beyond its size. Its advertised size
must not be treated as an exact byte length merely because it appeared in LOG_ENTRY.

