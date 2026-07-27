# node-red-contrib-mavlink

MAVLink toolkit for Node-RED — GCS and companion roles, one node set.

Full design and behaviour are specified in [DESIGN.md](DESIGN.md).

## Install

From your Node-RED user directory (usually `~/.node-red`, or `/data` in the official Docker image).

**Do not** `npm install /path/to/checkout` alone. Modern npm symlinks a local path and does
**not** install that package's dependencies, so `require('mavlink-mappings')` fails at palette
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
**Configuration nodes**).

Requires Node.js 18+ and Node-RED 3.0+.

### Docker / volume mount (`/module`, Unraid, etc.)

If the log shows a require stack under `/module/lib/...`, Node-RED is loading the bind-mounted
checkout directly. A bare mount has no `node_modules`:

```text
[node-red-contrib-mavlink/mavlink-command] Error: Cannot find module 'mavlink-mappings'
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
| `mavlink-connection` | UDP transport (TCP/serial stubbed “not yet”), peer table, queue, signing, heartbeats |
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

Importable flows live in [`examples/`](examples/). In the Node-RED editor: **Import → Examples → node-red-contrib-mavlink**.

| File | Demonstrates |
|------|----------------|
| `01-udp-heartbeat.json` | Local Identity + Vehicle + Connection (UDP) + mavlink-in on HEARTBEAT |
| `02-arm-takeoff-chain.json` | Command arm (confirm) chained to takeoff (await completion) |
| `03-param-read-set.json` | Param read (MAV_SYSID) and set (FS_GCS_ENABLE) as separate injects |
| `04-mission-upload-download.json` | Mission upload then download |
| `05-swarm-arm.json` | Swarm sequential arm — dry-run then live |

Before deploying against a vehicle or SITL, set each example's **Connection** endpoints (`bind` is where traffic arrives — typically `127.0.0.1:14550`; `remote` is the vehicle/SITL input — often `14551`) and match the **Vehicle** dialect and default target system id to your link.

## Development

```bash
npm install
npm test
npm run lint
```
