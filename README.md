# node-red-contrib-mavlink

MAVLink toolkit for Node-RED — GCS and companion roles, one node set.

Full design and behaviour are specified in [DESIGN.md](DESIGN.md).

## Install

From your Node-RED user directory (usually `~/.node-red`):

```bash
npm install /path/to/node-red-contrib-mavlink
```

Restart Node-RED. The nodes appear under the **MAVLink** palette (config nodes under **Configuration nodes**).

Requires Node.js 18+ and Node-RED 3.0+.

## Nodes

| Node | Role |
|------|------|
| `mavlink-local-identity` | Source sysid/compid, role preset, heartbeat, signing credential |
| `mavlink-vehicle` | Dialect selection, bundled or custom XML, default target ids |
| `mavlink-connection` | UDP/TCP/serial transport, peer table, queue, signing, heartbeats |
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
| `03-param-read-set.json` | Param read then set with echo confirmation |
| `04-mission-upload-download.json` | Mission upload then download |
| `05-swarm-arm.json` | Swarm sequential arm — dry-run then live |

Before deploying against a vehicle or SITL, set each example's **Connection** remote host/port and match the **Vehicle** dialect and target system id to your link.

## Development

```bash
npm install
npm test
npm run lint
```
