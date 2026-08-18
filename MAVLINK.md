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
`MAV_STANDARD_MODE_*` (1 POSITION_HOLD, 2 ORBIT, 4 ALTITUDE_HOLD, 5 RETURN_HOME,
6 SAFE_RECOVERY, 7 MISSION, 8 LAND). ArduPilot fills every `mode_name` and sets
`standard_mode=0` on all 25. PX4 indexes 20–27 are `"(Mode not available)"` with
`properties=2` (`MAV_MODE_PROPERTY_NOT_USER_SELECTABLE`).

**Decode.** pymavlink `common` 2.4.49 does not carry msgid 435/436; the capture used
`dialect='development'`. This tree's seed/catalog has neither message yet.

`AVAILABLE_MODES.properties`: 0 none, 1 `ADVANCED`, 2 `NOT_USER_SELECTABLE`, 3 both.

*Evidence:* SITL 2026-08-18, HEAD `4255a6c`; host captures
`available-modes-capture.json` / `available-modes-ap-followup.json`.
*Check:* `REQUEST_MESSAGE` 512 `param1=435` (PX4 `param2=0`; AP `param2=1…N`) on the
lab ports above. Re-measure if the PX4 digest or `ARDUPILOT_REF` moves.

*Toolkit consequence:* mode-name resolution is a ladder — vehicle list first, shipped
tables second. Rung 1 is real on both lab stacks. A baked PX4 table row that disagrees
with a published hex loses. See `DESIGN.md` §11 / §14.

**T1 — PX4 1.18.0 SIH, `number_modes=27`, one `param2=0` request:**

| idx | std | custom_hex | props | mode_name |
|---|---|---|---|---|
| 1 | 0 | `0x00010000` | 1 | Manual |
| 2 | 4 ALTITUDE_HOLD | `0x00020000` | 0 | *(blank)* |
| 3 | 1 POSITION_HOLD | `0x00030000` | 0 | *(blank)* |
| 4 | 6 SAFE_RECOVERY | `0x04040000` | 1 | *(blank)* |
| 5 | 0 | `0x03040000` | 1 | Hold |
| 6 | 5 RETURN_HOME | `0x05040000` | 1 | *(blank)* |
| 7 | 0 | `0x02030000` | 1 | Position Slow |
| 8 | 0 | `0x13040000` | 1 | Guided Course |
| 9 | 0 | `0x000B0000` | 1 | Altitude Cruise |
| 10 | 0 | `0x00050000` | 1 | Acro |
| 11 | 0 | `0x000A0000` | 3 | Termination |
| 12 | 0 | `0x00060000` | 1 | Offboard |
| 13 | 0 | `0x00070000` | 1 | Stabilized |
| 14 | 8 LAND | `0x02040000` | 1 | *(blank)* |
| 15 | 7 MISSION | `0x06040000` | 1 | *(blank)* |
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

## Open questions

*(Unverified beliefs worth measuring go here — never in Entries.)*
