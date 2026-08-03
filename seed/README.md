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
