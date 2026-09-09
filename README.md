# node-red-contrib-mavlink

MAVLink toolkit for Node-RED — GCS and companion roles, one node set.

Full design and behaviour are specified in
[DESIGN.md](https://github.com/cmc0619/node-red-contrib-mavlink/blob/main/DESIGN.md).

## Install

From your Node-RED user directory (usually `~/.node-red`, or `/data` in the official Docker
image):

```bash
npm install @cmc0619/node-red-contrib-mavlink
```

Or through the Node-RED editor: **Menu → Manage palette → Install**.

Restart Node-RED. The nodes appear under the **MAVLink** palette (config nodes under
**Configuration nodes**). Editor dialog screenshots live in
[`docs/screenshots/`](https://github.com/cmc0619/node-red-contrib-mavlink/tree/main/docs/screenshots).

Requires Node.js 20+ and Node-RED 4.0+.

## Nodes

| Node | Role |
|------|------|
| `mavlink-local-identity` | Source sysid/compid, role preset, heartbeat, signing credential |
| `mavlink-vehicle` | Dialect selection, bundled or custom XML, default target ids |
| `mavlink-connection` | UDP / TCP / serial transport, peer table, queue, signing, heartbeats |
| `mavlink-in` | Subscribe to decoded traffic with filters |
| `mavlink-out` | Send raw or pre-built messages |
| `mavlink-build` | Build any dialect message with delivery tiers |
| `mavlink-command` | `MAV_CMD` presets and advanced commands |
| `mavlink-move` | Motion: go to, steer, turn, speed, attitude, manual — acked commands or streamed setpoints per action |
| `mavlink-param` | Read, set, or list parameters |
| `mavlink-payload` | Camera, gimbal, servo, gripper, winch, parachute, relay |
| `mavlink-state` | Peer table reads and transitions |
| `mavlink-health` | Assert an identity's health with an expiring lease; a fault stops its HEARTBEAT |
| `mavlink-mission` | Upload, download, or clear mission/fence/rally |
| `mavlink-system` | Onboard logs, MAVLink FTP files, and parameter backup/restore |
| `mavlink-fanout` | Fan-out one action across selected vehicles, with optional per-member offsets |
| `mavlink-formation` | Position a group into a geometric formation around an anchor |

### Payload control and discovery

The Payload node offers camera streaming, point/rectangle tracking, storage formatting,
and explicit gimbal-manager configure/take/release commands. Photo interval and count
already support timed capture. Gimbal device-ID suggestions come from managers observed
on the selected Connection; manual IDs remain available. State exposes each manager's
capabilities, radian limits, and primary/secondary owners under `gimbalManagers`.
Discovery does not acquire control; use **Take control** explicitly before aiming when
the manager requires ownership, and **Release control** when finished.

The Command node's **Run Prearm Checks** preset requests the checks. An accepted command
acknowledgement means they will run, not that they passed or the vehicle is armable.

### Onboard system services

Use **mavlink-system** with **Logs → List** to obtain log IDs, timestamps, and advertised
sizes. Pass a selected PX4 entry as `{id, size}` in `msg.payload` to **Logs → Download**,
or configure the log ID. Omit `size` for peers whose advertised size is approximate, such
as ArduPilot; completion then follows a short or zero-count EOF. Successful downloads put
the bytes in `msg.payload` and the ID in `msg.logId`, preserving fields such as
`msg.filename` for a downstream File node. A cancelled log transfer sends
`LOG_REQUEST_END`.

**Files** uses MAVLink FTP: list and download read `msg.payload.path` or the configured
Path; upload takes a Buffer from `msg.payload` and reads `msg.path` or the configured Path.
The path is limited to 239 UTF-8 bytes and cannot contain NUL. FTP `CREATE_FILE` may
truncate an existing remote file.

**Parameters → Backup** returns parameter-only `{paramId, paramType, value}` records that
can travel through JSON or File nodes and be wired directly to **Parameters → Restore**.
Non-finite values use string representations, and Restore reports its confirmed prefix on
partial failure without rolling back earlier writes. All services preserve input metadata
on output 0; progress and terminal records use output 1, with large result data omitted
from status records. Timeout and retry settings are explicit in the editor.

## Examples

Importable flows ship with the package — 23 of them, plus 43 more for a live SITL rig. In
the Node-RED editor: **Import → Examples → @cmc0619/node-red-contrib-mavlink**.

A few to start with; every flow is indexed in
[`examples/CATALOG.md`](https://github.com/cmc0619/node-red-contrib-mavlink/blob/main/examples/CATALOG.md),
which ships in the package too.

| File | Demonstrates |
|------|----------------|
| `01-udp-heartbeat.json` | Local Identity + Vehicle + Connection (UDP) + mavlink-in on HEARTBEAT |
| `02-arm-takeoff-chain.json` | Command arm (confirm) chained to takeoff (await completion) |
| `03-param-read-set.json` | Param read (MAV_SYSID) and set (FS_GCS_ENABLE) as separate injects |
| `04-mission-upload-download.json` | Mission upload then download |
| `05-fanout-arm.json` | Fan-out sequential arm — preview then live |
| `10-sunday-stroll.json` | A full flight: arm, takeoff, waypoints, return |
| `24-formation-nudge.json` | Formation node moving a group as one |
| `27-safety-estop.json` | Emergency force-disarm and flight termination |
| `sitl/20-completion-takeoff.json` | Arm + completion-tier takeoff against ArduPilot Copter SITL |
| `sitl/31-fanout-sequential-five.json` | Five ArduPilot SITL sysids 1–5 sequential arm with 200 ms pacing |
| `sitl/04-param-defs-live.json` | Param read, set, and list — with live definition catalog |
| `sitl/22-command-mission-basics.json` | Command presets, advanced `SET_MESSAGE_INTERVAL`, mission upload/download |

The nested `sitl/` entries need a live SITL rig; they cover completion timing, mode tables,
PX4 param union, mission/fence/rally gating, fan-out pacing, signing, and companion mode.

Before deploying against a vehicle or SITL, set each example's **Connection** endpoints (`bind` is where traffic arrives — typically `127.0.0.1:14550`; `remote` is the vehicle/SITL input — often `14551`) and match the **Vehicle** dialect and default target system id to your link.

## Development, SITL lab, and Docker bind-mounts

Building from a checkout, the Docker Compose SITL harness (5× ArduPilot + 5× PX4), and
troubleshooting bind-mounted installs are covered in the
[repository README](https://github.com/cmc0619/node-red-contrib-mavlink/blob/main/.github/README.md).
Those parts are not in this package — they only apply to a git clone.

## License

MIT — see
[`LICENSE`](https://github.com/cmc0619/node-red-contrib-mavlink/blob/main/LICENSE).
