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
| `mavlink-move` | `SET_POSITION_TARGET_*` streaming |
| `mavlink-param` | Read, set, or list parameters |
| `mavlink-payload` | Camera, gimbal, servo, release |
| `mavlink-state` | Peer table reads and transitions |
| `mavlink-mission` | Upload, download, or clear mission/fence/rally |
| `mavlink-swarm` | Fan-out one action across selected vehicles |

## Examples

Importable flows ship with the package. In the Node-RED editor:
**Import → Examples → @cmc0619/node-red-contrib-mavlink**.

| File | Demonstrates |
|------|----------------|
| `01-udp-heartbeat.json` | Local Identity + Vehicle + Connection (UDP) + mavlink-in on HEARTBEAT |
| `02-arm-takeoff-chain.json` | Command arm (confirm) chained to takeoff (await completion) |
| `03-param-read-set.json` | Param read (MAV_SYSID) and set (FS_GCS_ENABLE) as separate injects |
| `04-mission-upload-download.json` | Mission upload then download |
| `05-swarm-arm.json` | Swarm sequential arm — dry-run then live |
| `sitl/01-completion-takeoff.json` | Arm + completion-tier takeoff against ArduPilot Copter SITL |
| `sitl/08-swarm-sequential-five.json` | Five ArduPilot SITL sysids 1–5 sequential arm with 200 ms pacing |
| `sitl/13-param-defs-live.json` | Param read, set, and list — with live definition catalog |
| `sitl/14-command-mission-basics.json` | Command presets, advanced `SET_MESSAGE_INTERVAL`, mission upload/download |

The nested `sitl/` entries need a live SITL rig; they cover completion timing, mode tables,
PX4 param union, mission/fence/rally gating, swarm pacing, signing, and companion mode.

Before deploying against a vehicle or SITL, set each example's **Connection** endpoints (`bind` is where traffic arrives — typically `127.0.0.1:14550`; `remote` is the vehicle/SITL input — often `14551`) and match the **Vehicle** dialect and default target system id to your link.

## Development, SITL lab, and Docker bind-mounts

Building from a checkout, the Docker Compose SITL harness (5× ArduPilot + 5× PX4), and
troubleshooting bind-mounted installs are covered in the
[repository README](https://github.com/cmc0619/node-red-contrib-mavlink#readme). Those parts
are not in this package — they only apply to a git clone.

## License

MIT — see
[`LICENSE`](https://github.com/cmc0619/node-red-contrib-mavlink/blob/main/LICENSE).
