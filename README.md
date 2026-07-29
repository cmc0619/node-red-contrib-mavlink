# node-red-contrib-mavlink

MAVLink toolkit for Node-RED — GCS and companion roles, one node set.

Full design and behaviour are specified in [DESIGN.md](DESIGN.md).

## Install

From your Node-RED user directory (usually `~/.node-red`, or `/data` in the official Docker image).

**Do not** `npm install /path/to/checkout` alone. Modern npm symlinks a local path and does
**not** install that package's dependencies, so `require('node-mavlink')` fails at palette
load. Use one of:

```bash
# From npm (when published), or from GitHub:
npm install cmc0619/node-red-contrib-mavlink

# From a local checkout — copy, don't symlink:
npm install --install-links /path/to/node-red-contrib-mavlink

# Or pack first, then install the tarball (also a real copy):
npm pack /path/to/node-red-contrib-mavlink
npm install ./node-red-contrib-mavlink-*.tgz
```

Restart Node-RED. The nodes appear under the **MAVLink** palette (config nodes under
**Configuration nodes**). Editor dialog screenshots live in
[`docs/screenshots/`](docs/screenshots/).

Requires Node.js 18.5+ and Node-RED 4.0+.

### Docker / volume mount (`/module`, Unraid, etc.)

If the log shows a require stack under `/module/lib/...`, Node-RED is loading the bind-mounted
checkout directly. A bare mount has no `node_modules`:

```text
[node-red-contrib-mavlink/mavlink-connection] Error: Cannot find module 'node-mavlink'
```

Install dependencies **on the mount** (so resolution from `/module/lib/...` succeeds):

```bash
cd /module   # or whatever you mounted
npm install --omit=dev
```

Then restart Node-RED. Alternatively, leave the mount as source only and install a **copy** into
the user directory with `--install-links` or a tarball (above) so the palette loads from
`/data/node_modules` like any other contrib package.

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

## SITL lab

A Docker Compose harness (5× ArduPilot + 5× PX4 + companion sysids 20/21) lives in
[`sitl/`](sitl/README.md). That short guide is the operator entry point for ports, `compose up`,
and log checks.

## Examples

Importable flows live in [`examples/`](examples/). Firmware pain-tests that need a live
SITL rig are in [`examples/sitl/`](examples/sitl/) — see that folder's README and the
[`sitl/`](sitl/README.md) Docker lab.

In the Node-RED editor: **Import → Examples → node-red-contrib-mavlink** (nested `sitl/`
entries appear under the package examples folder).

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

The `examples/sitl/` folder contains flows covering completion timing, mode tables,
PX4 param union, mission/fence/rally gating, swarm pacing, signing, and companion mode.
See [`examples/sitl/README.md`](examples/sitl/README.md) for the full index.

Before deploying against a vehicle or SITL, set each example's **Connection** endpoints (`bind` is where traffic arrives — typically `127.0.0.1:14550`; `remote` is the vehicle/SITL input — often `14551`) and match the **Vehicle** dialect and default target system id to your link.

## Development

```bash
npm install
npm test
npm run lint
```
