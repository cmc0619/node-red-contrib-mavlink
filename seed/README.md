# MAVLink dialect seed

One stamped gzip blob plus a tiny pointer:

```text
seed/active.json                              → { "file": "mavlink-YYYY-MM-DD-<sha>.seed.gz", "stamp": "…" }
seed/mavlink-2026-07-29-de1e078.seed.gz       → gunzip → JSON (NOTICE, manifest, all bundles)
```

Runtime reads `active.json`, then gunzips that file once (`lib/metadata/bundled.js`).

Regenerate:

```bash
npm run generate-seed
# or offline from a mavlink checkout:
node scripts/generate-seed.js --source-dir /path/to/mavlink
```

A weekly GitHub Action (`.github/workflows/refresh-mavlink-seed.yml`) refreshes
from `mavlink/mavlink` and opens a PR when the stamp moves.
