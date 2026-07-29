# MAVLink dialect seed

`mavlink.seed.gz` is a **single** gzipped JSON blob: MIT notice, provenance
manifest (commit + `stamp` like `2026-07-28-de1e078`), and every precompiled
dialect bundle. The runtime gunzips it once (`lib/metadata/bundled.js`).

Regenerate:

```bash
npm run generate-seed
# or offline from a mavlink checkout:
node scripts/generate-seed.js --source-dir /path/to/mavlink
```

A weekly GitHub Action (`.github/workflows/refresh-mavlink-seed.yml`) refreshes
the blob from `mavlink/mavlink` and opens a PR when the upstream commit moves.
