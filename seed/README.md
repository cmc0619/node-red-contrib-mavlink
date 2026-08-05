# MAVLink dialect seed

One stamped gzip blob plus a tiny pointer:

```text
seed/active.json                              → { "file": "mavlink-YYYY-MM-DD-<sha>.seed.gz", "stamp": "…" }
seed/mavlink-2026-07-29-de1e078.seed.gz       → gunzip → JSON (NOTICE, manifest, XML sources)
```

Runtime reads `active.json`, gunzips that file once, and compiles the dialects a
profile actually uses (`lib/metadata/bundled.js`). The blob ships XML, not compiled
bundles: XML is ~10x smaller, because every bundle would otherwise embed its own copy
of `common.xml`.

Compiled dialects are cached under `<userDir>/mavlink/compiled/`. Nothing expires on
its own — **Rebuild dialect** in the Vehicle editor is the only thing that replaces an
entry, so a newer seed never silently changes a deployed profile.

Regenerate:

```bash
npm run generate-seed
# or offline from a mavlink checkout:
node scripts/generate-seed.js --source-dir /path/to/mavlink
```

A weekly GitHub Action (`.github/workflows/refresh-mavlink-seed.yml`) refreshes
from `mavlink/mavlink` and opens a PR when the stamp moves.

---

# Parameter-definition seed

The same shape, a second payload:

```text
seed/params-active.json                       → { "file": "param-defs-YYYY-MM-DD-<hash>.seed.gz", "stamp": …, "sources": […] }
seed/param-defs-2026-08-05-c86294e.seed.gz    → gunzip → JSON, firmware → vehicle → { ID: def }
```

Runtime reads the pointer, gunzips once on first lookup, and keys on the Vehicle
Profile's **firmware** and **vehicleFamily** (`lib/param/seed.js`). The same
parameter id genuinely differs between stacks — `RC1_MIN` is microseconds
800–1500 on PX4 and PWM 800–2200 on ArduPilot — so serving one firmware's
metadata under the other is a wrong answer, not a near miss. An unknown or
generic vehicle gets the union of every document for that firmware: listing a
parameter the vehicle lacks costs a failed read, while hiding one it has cannot
be recovered from inside the editor.

Each upstream document is stored exactly as parsed — no deduplication. The six
ArduPilot vehicles do overlap almost entirely (6649 of 6827 ids are identical
everywhere), but folding them would save ~670 KB gzipped at the cost of two
shapes to reason about, and the package is not tight enough for that trade.

The seed is a **baseline**, not an authority. A profile that has downloaded its
own definitions overrides it id by id, because that download came from the
firmware actually being flown. Nothing expires on its own — a newer seed arrives
only with a new release.

Regenerate:

```bash
npm run generate-param-seed
```

Sources: ArduPilot's per-vehicle `apm.pdef.json` (autotest.ardupilot.org) and
PX4's `parameters.xml` (artifacts.px4.io). PX4's `parameters.json` exists only
as an `.xz` archive, which this project refuses by name rather than decoding.
