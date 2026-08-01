# SITL lab — agent playbook

How to bring up the Docker lab and run `examples/sitl/` efficiently.
Human-oriented detail lives in [`README.md`](README.md); design intent in
[`DESIGN.md` §13–§14](../DESIGN.md). Live results go in repo-root
[`testing.md`](../testing.md) + [`example-suite-results.json`](example-suite-results.json).

## Do this, not that

| Do | Don’t |
|----|--------|
| Use the official prebuilt AP binary (Dockerfile already does) | `waf copter` / clone ArduPilot in the image (~40 min in nested Docker) |
| `docker compose --profile sitl --profile nodered up -d --build` | Hunt for a standalone Node-RED if Compose can host it |
| Wait for HEARTBEATs, then `node sitl/run-example-suite.js` | Deploy all example flows at once (UDP bind exclusivity) |
| Curate verdicts in `testing.md` from the JSON | Trust harness auto-status blindly (false PASS on “timeout” node names, etc.) |
| Load `copter.parm` + `ap-logging.parm` (entrypoint default) | Run bare `arducopter` without autotest defaults → ARM DENIED |

## Cold start (cloud / nested Docker VM)

```bash
# If docker missing: install Engine + compose plugin, then:
sudo mkdir -p /etc/docker
echo '{"storage-driver":"vfs"}' | sudo tee /etc/docker/daemon.json
# no systemd → sudo dockerd & ; chmod 666 /var/run/docker.sock

cd sitl
docker compose --profile sitl --profile nodered up -d --build
```

- AP image (`nrc-mavlink-ap-sitl:local`): curls
  `firmware.ardupilot.org/Copter/stable-4.7.0/SITL_x86_64_linux_gnu/arducopter`
  (~7 MB) + `Tools/autotest/default_params/copter.parm`. **Pinned
  `linux/amd64`** (binary is x86_64-only).
- PX4: official `px4io/px4-sitl` digest in `docker-compose.yml` (no local compile).
- Node-RED: host network, editor `http://127.0.0.1:1880`, package bind-mounted
  from repo root via `nodered/install-and-start.sh`.

Ready when:

```bash
docker compose --profile sitl --profile nodered ps
docker logs nrc-ap-1 2>&1 | grep -E 'udpclient|Loaded defaults'
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:1880   # 200
```

Expect AP log: `out=udpclient:172.…:14550` and
`Loaded defaults from /params/copter.parm,/params/ap-logging.parm`.

## Optional PX4 arming helpers

On a fresh SIH image, set once per container (at least `nrc-px4-11`):

```bash
docker exec nrc-px4-11 sh -lc \
  'cd /opt/px4 && ./bin/px4-param set MAV_0_BROADCAST 1 \
   && ./bin/px4-param set COM_RCL_EXCEPT 7 \
   && ./bin/px4-param set COM_ARM_MAG_STR 0'
```

Multi-instance containers use `/tmp/px4-sock-<i>`; `px4-param` may say
“server not running” if the wrong socket is selected — prefer instance 0
(`nrc-px4-11`) for single-vehicle examples.

## Run the example suite

From **repo root** (not `sitl/`):

```bash
node sitl/run-example-suite.js --out sitl/example-suite-results.json
# subset:
node sitl/run-example-suite.js --only 01,10,17
```

Harness: deploy one `examples/sitl/*.json` at a time → enable debug→console →
fire injects → scrape `docker logs nrc-nodered` → write JSON.

After the run, **update [`../testing.md`](../testing.md)** with human-curated
verdicts (PASS / PARTIAL / FAIL / SKIP). Keep the JSON as the machine log.
Force-add the JSON if needed (`sitl/.gitignore` only ignores `logs/`; the
results file is tracked on purpose).

### Harness auto-verdict traps

- Example **02** node name contains “timeout” → auto-PASS even when takeoff is
  immediate DENIED. Curate as FAIL unless you see accept→completion-timeout.
- Example **09**: `/failed|expired/` elsewhere in the log → auto-PASS even when
  the kill was too late and the swarm aggregate succeeded.
- Examples **15/16**: many `sent` lines → auto-UNKNOWN; NVF `sent` is PASS.
- Example **07**: good+bad upload both `succeeded` → PARTIAL, not PASS.

## Port / sysid map (quick)

| Fleet | Sysids | Bind (Node-RED) | Vehicle → host |
|-------|--------|-----------------|----------------|
| AP GCS | 1–5 | `0.0.0.0:14550` | udpclient → `14550` |
| PX4 GCS | 11–15 | `0.0.0.0:14560` | mavlink `-o 14560` |
| AP companion | 20 | `0.0.0.0:14540` | udpclient → `14540` |
| PX4 companion | 21 | `0.0.0.0:14542` | mavlink → `14542` |

Directed commands use the Connection peer table (reply to HEARTBEAT source).
`remotePort` 14551/14561 is pre-peer fallback only.

## Takeoff / GUIDED

AP `NAV_TAKEOFF` needs GUIDED. The suite prep `ap-guided-1` sends SET_MODE for
sysid 1 before deploy; if takeoff is DENIED (`resultCode: 4`) after a successful
arm, re-check GUIDED and GPS/EKF — do not reintroduce a source build.

## Fixture tests (no Docker)

```bash
node --test test/sitl/*.test.js
```

Pins prebuilt URL, amd64 platform, `udpclient`, and `--defaults
copter.parm,ap-logging.parm`. Ordinary package CI does **not** run the
12-vehicle lab.

## Tear down

```bash
cd sitl && docker compose --profile sitl --profile nodered down
```
