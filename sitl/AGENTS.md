# SITL lab — agent playbook

How to bring up the Docker lab and run `examples/sitl/` efficiently.
Human-oriented detail lives in [`README.md`](README.md); design intent in
[`DESIGN.md` §13–§14](../DESIGN.md).

**Live results go to a GitHub Issue** (label `sitl-results`), not into a PR.
Close the prior open `sitl-results` issue when posting a new run. See
[`../testing.md`](../testing.md) for the pointer only.

## Do this, not that

| Do | Don’t |
|----|--------|
| Use the official prebuilt AP binary (Dockerfile already does) | `waf copter` / clone ArduPilot in the image (~40 min in nested Docker) |
| `docker compose --profile sitl --profile nodered up -d --build` | Hunt for a standalone Node-RED if Compose can host it |
| Wait for HEARTBEATs, then `node sitl/run-example-suite.js` | Deploy all example flows at once (UDP bind exclusivity) |
| Post curated verdicts to a **GitHub Issue** (`sitl-results`) | Open a docs PR that only updates `testing.md` / results JSON |
| Close the previous `sitl-results` issue after posting | Leave a trail of open result issues |
| Load `copter.parm` + `ap-logging.parm` (entrypoint default) | Run bare `arducopter` without autotest defaults → ARM DENIED |
| Write harness JSON under `/tmp/` (default) | Commit `sitl/example-suite-results.json` |

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
node sitl/run-example-suite.js --out /tmp/sitl-example-suite-results.json
# subset:
node sitl/run-example-suite.js --only 01,10,17
```

Harness: deploy one `examples/sitl/*.json` at a time → enable debug→console →
fire injects → scrape `docker logs nrc-nodered` → write JSON under `/tmp/`
(default). Example **25** (TCP) is **SKIP** unless Compose exposes SITL TCP.

### Post results (no PR)

```bash
# 1) Curate PASS/PARTIAL/FAIL/SKIP from the JSON (do not trust auto-status blindly).
# 2) Open a new issue:
gh issue create --label sitl-results \
  --title "SITL suite results — run N" \
  --body-file /tmp/sitl-run-N.md
# 3) Close the previous open sitl-results issue:
gh issue list --label sitl-results --state open
gh issue close <prior> --comment "Superseded by #<new>"
```

Attach or paste a short summary table in the issue body. Keep the full JSON
local or paste a collapsed `<details>` block — do not land it in git.

### Harness auto-verdict traps

- Example **02** historically false-PASS’d on the word “timeout” in node names;
  verdict now requires a real `timed-out` / timeout detail.
- Example **09**: kill must land mid-run; late kill → all-accepted aggregate.
- Examples **15/16**: many `sent` lines → look for `NAMED_VALUE_FLOAT` specifically.
- Example **07**: bad upload must fail validation; empty success is not fail-loud.
- Example **03**: `TEMPORARILY_REJECTED` needs a fresh AP boot race — often PARTIAL.

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
