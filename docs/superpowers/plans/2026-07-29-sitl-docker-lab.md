# SITL Docker Lab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Compose lab with 5 ArduPilot + 5 PX4 + 2 companion SITL containers, arm-only flight logs, example port retargets, companion flows, and a short operator `sitl/README.md`.

**Architecture:** One container per vehicle under `sitl/`. Vehicles UDP to the host via `host.docker.internal`. Start with `docker compose --profile sitl up` (optional `--profile nodered` adds Node-RED). Examples use AP `14550/14551` and PX4 `14560/14561`.

**Tech Stack:** Docker Compose v2, ArduPilot SITL (`sim_vehicle.py` / MAVProxy), PX4 SITL, Node-RED (optional profile), bash for `check-logs.sh`

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-29-sitl-docker-lab-design.md`
- Port map is normative: AP GCS `14550/14551`, PX4 GCS `14560/14561`, AP companion `14540/14541`, PX4 companion `14542/14543`
- Sysids: AP `1–5`, PX4 `11–15`, companions `20` / `21`
- PR ≤ 50 files; split Compose scaffold vs example retargets if needed
- Do not add full 12× SITL to ordinary CI
- End-user docs live in `sitl/README.md` (short); DESIGN.md §13 gets a pointer only
- `extra_hosts: host.docker.internal:host-gateway` on every vehicle service

## File map

| Path | Responsibility |
|------|----------------|
| `sitl/docker-compose.yml` | 12 vehicle services + optional `nodered` |
| `sitl/Dockerfile.ardupilot` | ArduCopter SITL + MAVProxy image |
| `sitl/Dockerfile.px4` | PX4 SITL image (headless, no Gazebo GUI) |
| `sitl/scripts/entrypoint-ap.sh` | Launch one AP instance with sysid, `-I`, `--out`, logging parms |
| `sitl/scripts/entrypoint-px4.sh` | Launch one PX4 instance with `MAV_SYS_ID`, GCS UDP to host |
| `sitl/params/ap-logging.parm` | `LOG_DISARMED 0` (+ minimal copter defaults if required) |
| `sitl/params/px4-logging.env` | Env/exports for SDLOG-on-arm (document exact param in README if airframe-specific) |
| `sitl/check-logs.sh` | Best-effort arm-only log proof |
| `sitl/README.md` | Operator guide |
| `sitl/.gitignore` | Ignore `logs/` |
| `sitl/nodered/settings.js` + flow preload | Optional profile only |
| Example JSON / CATALOG / READMEs | Retarget `14555` → `14560/14561`; companion SITL flows |
| `DESIGN.md` §13 | One paragraph + link |

---

### Task 1: Scaffold `sitl/` + log checker (no images yet)

**Files:**
- Create: `sitl/.gitignore`
- Create: `sitl/check-logs.sh`
- Create: `sitl/params/ap-logging.parm`
- Create: `test/sitl/check-logs.test.js` (fixture dirs only)
- Create: `sitl/README.md` (stub port table + “compose coming” is OK; Task 7 expands)

**Interfaces:**
- Consumes: none
- Produces: `sitl/check-logs.sh` CLI — args: `--logs-root DIR` `[--expect-armed SERVICE…]`; exit `0` if armed services have a flight log newer than a marker / non-empty; exit `1` with message on failure. Default root `sitl/logs`.

- [ ] **Step 1: Write failing test for the checker**

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '../../sitl/check-logs.sh');

test('check-logs fails when armed service has no flight log', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sitl-logs-'));
  fs.mkdirSync(path.join(root, 'ap-1'));
  const r = spawnSync('bash', [SCRIPT, '--logs-root', root, '--expect-armed', 'ap-1'], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
});

test('check-logs passes when armed service has .bin or .ulg', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sitl-logs-'));
  const dir = path.join(root, 'ap-1');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, '00000001.BIN'), 'x');
  const r = spawnSync('bash', [SCRIPT, '--logs-root', root, '--expect-armed', 'ap-1'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
});
```

- [ ] **Step 2: Run test — expect FAIL (script missing)**

Run: `node --test test/sitl/check-logs.test.js`  
Expected: non-zero (cannot find script or fails)

- [ ] **Step 3: Implement `sitl/check-logs.sh` + `.gitignore` + `ap-logging.parm`**

```bash
#!/usr/bin/env bash
# Usage: check-logs.sh --logs-root DIR [--expect-armed NAME ...]
set -euo pipefail
ROOT="sitl/logs"
EXPECT=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --logs-root) ROOT="$2"; shift 2 ;;
    --expect-armed) EXPECT+=("$2"); shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
fail=0
for name in "${EXPECT[@]}"; do
  dir="$ROOT/$name"
  if ! compgen -G "$dir/*.{BIN,bin,ulg,ULG}" > /dev/null 2>&1 \
     && ! find "$dir" -type f \( -iname '*.bin' -o -iname '*.ulg' \) 2>/dev/null | grep -q .; then
    echo "check-logs: no flight log under $dir" >&2
    fail=1
  fi
done
exit "$fail"
```

`sitl/.gitignore`:

```
logs/
```

`sitl/params/ap-logging.parm`:

```
LOG_DISARMED 0
```

- [ ] **Step 4: Re-run test — expect PASS**

Run: `node --test test/sitl/check-logs.test.js`

- [ ] **Step 5: Commit**

```bash
git add sitl/.gitignore sitl/check-logs.sh sitl/params/ap-logging.parm test/sitl/check-logs.test.js
git commit -m "feat(sitl): add flight-log checker scaffold"
```

---

### Task 2: ArduPilot image + entrypoint

**Files:**
- Create: `sitl/Dockerfile.ardupilot`
- Create: `sitl/scripts/entrypoint-ap.sh`

**Interfaces:**
- Consumes: env `SYSSID` (int), `INSTANCE` (`-I`), `OUT_HOST` (default `host.docker.internal`), `OUT_PORT` (default `14550`), `HOME_LAT`/`HOME_LON`/`HOME_ALT`
- Produces: container that runs one ArduCopter SITL; MAVProxy `--out=udp:$OUT_HOST:$OUT_PORT`; loads `/params/ap-logging.parm`

- [ ] **Step 1: Add Dockerfile.ardupilot**

Use Ubuntu 22.04, install build/runtime deps, clone ArduPilot (pinned tag/commit documented in README), `waf` build `copter` SITL, install MAVProxy. Keep image single-arch `linux/amd64` unless multi-arch is free.

Pin a specific ArduPilot release tag in the Dockerfile `ARG ARDUPILOT_REF=...` and echo it at build time.

- [ ] **Step 2: Add entrypoint-ap.sh**

```bash
#!/usr/bin/env bash
set -euo pipefail
: "${SYSID:?}"
: "${INSTANCE:=0}"
: "${OUT_HOST:=host.docker.internal}"
: "${OUT_PORT:=14550}"
: "${HOME_LAT:=-35.363262}"
: "${HOME_LON:=149.165237}"
: "${HOME_ALT:=584}"
# Offset home slightly by INSTANCE so vehicles do not stack
LAT=$(awk -v b="$HOME_LAT" -v i="$INSTANCE" 'BEGIN{printf "%.8f", b + (i*0.0001)}')
LON=$(awk -v b="$HOME_LON" -v i="$INSTANCE" 'BEGIN{printf "%.8f", b + (i*0.0001)}')
mkdir -p /logs
# Prefer writing DataFlash to /logs when supported by the build; document path in sitl/README.md
exec sim_vehicle.py -v ArduCopter -I "$INSTANCE" --sysid "$SYSID" \
  --custom-location="${LAT},${LON},${HOME_ALT},270" \
  --add-param-file=/params/ap-logging.parm \
  --out="udp:${OUT_HOST}:${OUT_PORT}" \
  --no-rebuild -w
```

Make executable in the image (`chmod +x`).

- [ ] **Step 3: Build image locally (smoke)**

Run: `docker build -f sitl/Dockerfile.ardupilot -t nrc-mavlink-ap-sitl sitl/`  
Expected: exit 0 (long). If the environment cannot build, document blocker in `sitl/README.md` and keep Dockerfile correct for operators.

- [ ] **Step 4: Commit**

```bash
git add sitl/Dockerfile.ardupilot sitl/scripts/entrypoint-ap.sh
git commit -m "feat(sitl): ArduPilot SITL image and entrypoint"
```

---

### Task 3: PX4 image + entrypoint

**Files:**
- Create: `sitl/Dockerfile.px4`
- Create: `sitl/scripts/entrypoint-px4.sh`
- Create: `sitl/params/px4-logging.env`

**Interfaces:**
- Consumes: env `SYSID`, `OUT_HOST`, `OUT_PORT` (GCS remote port on host, default `14560`), `INSTANCE` (PX4 instance / mavlink port offset)
- Produces: headless PX4 SITL sending GCS MAVLink to `udp://$OUT_HOST:$OUT_PORT` with `MAV_SYS_ID=$SYSID`; SDLOG starts on arm (set via startup/param as required by the pinned PX4 version — record exact knobs in README)

- [ ] **Step 1: Dockerfile.px4**

Pin PX4-Autopilot ref. Build `px4_sitl_default` without GUI Gazebo if possible (jmavsim or none / SIH). Prefer the lightest simulator that still emits MAVLink HEARTBEAT.

- [ ] **Step 2: entrypoint-px4.sh**

```bash
#!/usr/bin/env bash
set -euo pipefail
: "${SYSID:?}"
: "${OUT_HOST:=host.docker.internal}"
: "${OUT_PORT:=14560}"
: "${INSTANCE:=0}"
mkdir -p /logs
export PX4_SYS_AUTOSTART="${PX4_SYS_AUTOSTART:-4001}"
# Version-specific: set MAV_SYS_ID and GCS UDP target; write ulogs under /logs
# Implement using the pinned PX4's supported env (PX4_MAV_*: document in README)
exec ./build/px4_sitl_default/bin/px4 -i "$INSTANCE" -d
```

Fill in the exact MAVLink `mavlink start` / param lines required by the pinned PX4 so traffic hits `$OUT_HOST:$OUT_PORT`. Companion containers pass `OUT_PORT=14542`.

- [ ] **Step 3: px4-logging.env**

```
# Sourced by entrypoint; values confirmed against pinned PX4
# SDLOG_MODE=1 means arm-to-disarm on many PX4 versions — verify at pin time
SDLOG_MODE=1
```

- [ ] **Step 4: Build smoke**

Run: `docker build -f sitl/Dockerfile.px4 -t nrc-mavlink-px4-sitl sitl/`

- [ ] **Step 5: Commit**

```bash
git add sitl/Dockerfile.px4 sitl/scripts/entrypoint-px4.sh sitl/params/px4-logging.env
git commit -m "feat(sitl): PX4 SITL image and entrypoint"
```

---

### Task 4: Compose — twelve vehicles

**Files:**
- Create: `sitl/docker-compose.yml`

**Interfaces:**
- Consumes: images from Tasks 2–3
- Produces: `docker compose --profile sitl up -d` starts all 12 services with the normative port/sysid map

- [ ] **Step 1: Write docker-compose.yml**

Requirements for every vehicle service:

```yaml
extra_hosts:
  - "host.docker.internal:host-gateway"
volumes:
  - ./logs/<service-name>:/logs
  - ./params/ap-logging.parm:/params/ap-logging.parm:ro   # AP only
restart: unless-stopped
profiles: ["sitl"]
```

Service matrix:

| service | image | SYSID | INSTANCE | OUT_PORT |
|---------|-------|------:|---------:|---------:|
| ap-1..ap-5 | ap | 1..5 | 0..4 | 14550 |
| px4-11..px4-15 | px4 | 11..15 | 0..4 | 14560 |
| ap-companion-20 | ap | 20 | 10 | 14540 |
| px4-companion-21 | px4 | 21 | 10 | 14542 |

Do **not** publish conflicting host UDP binds for five MAVProxy pairs unless needed for debugging; Node-RED on the host listens on 14550/14560/14540/14542.

Use YAML anchors or `x-ap` / `x-px4` extension fields to keep the file readable.

- [ ] **Step 2: Config validation**

Run: `docker compose -f sitl/docker-compose.yml --profile sitl config`  
Expected: exit 0, 12 services listed

- [ ] **Step 3: Commit**

```bash
git add sitl/docker-compose.yml
git commit -m "feat(sitl): compose twelve-vehicle sitl profile"
```

---

### Task 5: Retarget examples to PX4 `14560/14561`

**Files:**
- Modify: `examples/sitl/04-mode-tables.json`
- Modify: `examples/sitl/05-px4-param-union.json`
- Modify: `examples/sitl/06-mission-fence-rally.json`
- Modify: `examples/sitl/10-dual-stack-ten.json`
- Modify: `examples/CATALOG.md` (all `14555` → `14560`, remotes → `14561`)
- Modify: `examples/sitl/README.md` (Docker pointer + port table)
- Align `examples/12-ebony-and-ivory.json` if already on 14560 — ensure remote `14561` and comments match

**Interfaces:**
- Consumes: port map from spec
- Produces: every shipped example that talks PX4 GCS uses bind `14560` / remote `14561`

- [ ] **Step 1: Replace ports in the four sitl JSON files**

In each file: `bindPort` `14555` → `14560`; set `remotePort` to `14561` where a PX4 remote is configured; update comment `info` strings the same way.

- [ ] **Step 2: Update CATALOG.md and examples/sitl/README.md**

Port table in README must match the spec. Add “prefer Docker lab: see `/sitl/README.md`” near the top.

- [ ] **Step 3: Grep gate**

Run: `rg -n '14555' examples docs README.md DESIGN.md || true`  
Expected: no hits outside historical notes in the lab spec decisions log (spec may mention 14555 as the old value — OK)

- [ ] **Step 4: Commit**

```bash
git add examples examples/CATALOG.md
git commit -m "fix(examples): retarget PX4 SITL ports to 14560/14561"
```

---

### Task 6: Companion SITL example flows

**Files:**
- Create: `examples/sitl/15-companion-ap.json` (sysid 20, bind 14540/14541)
- Create: `examples/sitl/16-companion-px4.json` (sysid 21, bind 14542/14543)
- Modify: `examples/sitl/README.md` index table
- Modify: `examples/CATALOG.md`

**Interfaces:**
- Consumes: companion identity pattern from `examples/20-companion-origination.json` (`role: companion`, shared sysid, compid 191)
- Produces: two importable flows for the companion containers

- [ ] **Step 1: Author 15-companion-ap.json**

Clone structure from `20-companion-origination.json`:

- identity: `role: companion`, `sourceSystemId: 20`, `sourceComponentId: 191`
- vehicle: ardupilot, `defaultTargetSystem: 20`
- connection: bind `127.0.0.1:14540`, remote `127.0.0.1:14541`
- Include State or In showing peer sysid 20 + companion component; a harmless Param read or heartbeat watch is enough

- [ ] **Step 2: Author 16-companion-px4.json**

Same with sysid 21, firmware px4, dialect common, bind `14542`, remote `14543`.

- [ ] **Step 3: Catalog + sitl README index rows**

- [ ] **Step 4: Commit**

```bash
git add examples/sitl/15-companion-ap.json examples/sitl/16-companion-px4.json examples/sitl/README.md examples/CATALOG.md
git commit -m "feat(examples): companion SITL flows for sysid 20/21"
```

---

### Task 7: Optional `nodered` profile + operator docs + DESIGN pointer

**Files:**
- Modify: `sitl/docker-compose.yml` (add `nodered` service, profile `nodered`)
- Create: `sitl/nodered/package.json` or document `npm install --install-links` from mounted repo
- Modify: `sitl/README.md` (full operator guide)
- Modify: `README.md` (short SITL lab link)
- Modify: `DESIGN.md` §13 (one paragraph + link)
- Modify: `docs/superpowers/specs/2026-07-29-sitl-docker-lab-design.md` status → Implemented (when done)

**Interfaces:**
- Consumes: compose from Task 4, flows from Tasks 5–6
- Produces: `docker compose --profile sitl --profile nodered up -d` brings vehicles + Node-RED; `sitl/README.md` is sufficient for an end user

- [ ] **Step 1: nodered service**

```yaml
nodered:
  profiles: ["nodered"]
  image: nodered/node-red:4.0
  ports: ["1880:1880"]
  volumes:
    - ../:/data/modules/node-red-contrib-mavlink:ro
    - nodered-data:/data
  # entrypoint installs with --install-links then starts; keep script under sitl/nodered/
```

Do not break host-Node-RED users; profile is opt-in.

- [ ] **Step 2: Write full sitl/README.md**

Must include: port/sysid table, MAVProxy ELI5 (3–4 sentences), `compose up`, how to import examples, `docker compose logs`, `./check-logs.sh --expect-armed ap-1`, troubleshooting port conflicts, note that CI does not run this rig.

- [ ] **Step 3: Root README + DESIGN §13 pointer**

DESIGN addition (near the rig paragraph):

```markdown
**Docker lab.** A Compose harness that launches this rig (plus companion sysids 20/21)
lives under [`sitl/`](sitl/README.md). Operator instructions stay there — this section
defines the rig; `sitl/README.md` is how to run it.
```

- [ ] **Step 4: Commit**

```bash
git add sitl README.md DESIGN.md
git commit -m "docs(sitl): operator README, nodered profile, DESIGN pointer"
```

---

### Task 8: Integration smoke (manual / best-effort in agent env)

**Files:** none required (runbook only; record results in PR body)

- [ ] **Step 1: Bring up sitl profile**

Run: `docker compose -f sitl/docker-compose.yml --profile sitl up -d --build`  
Expected: 12 running containers (or document env limits if images cannot build here)

- [ ] **Step 2: Confirm HEARTBEATs**

With host Node-RED or the `nodered` profile, import `examples/sitl/10-dual-stack-ten.json` — peers 1–5 and 11–15 appear.

- [ ] **Step 3: Arm one AP + check logs**

Arm `ap-1` via example flow; run:

```bash
./sitl/check-logs.sh --logs-root sitl/logs --expect-armed ap-1
```

Expected: exit 0; `docker compose logs ap-1` shows arm

- [ ] **Step 4: Companion flow smoke**

Import `15-companion-ap.json` / `16-companion-px4.json` — peers 20/21 visible

- [ ] **Step 5: Final commit if README needed tweaks after bring-up**

```bash
git add sitl/README.md
git commit -m "docs(sitl): record measured bring-up notes"
```

---

## Spec coverage checklist

| Spec requirement | Task |
|------------------|------|
| 12 one-container vehicles | 4 |
| Port/sysid map | 4, 5, 6 |
| host.docker.internal | 4 |
| Arm-only flight logs + compose logs + check-logs | 1, 2, 3, 8 |
| Example retarget 14555→14560 | 5 |
| Companion flows 20/21 | 6 |
| Compose profiles sitl + nodered | 4, 7 |
| sitl/README.md primary docs | 7 |
| DESIGN §13 pointer | 7 |
| No full SITL in CI | (global) |
| PR ≤ 50 files | split 5–6 if needed |

## Self-review notes

- No TBD steps; PX4 exact mavlink start line is “fill from pinned version” inside Task 3 with README documentation — acceptable because it must match the pin chosen at implement time.
- Checker tests do not require Docker.
- Image builds may be too heavy for the cloud agent; Task 8 documents that without blocking merge of Dockerfiles/compose/examples.
