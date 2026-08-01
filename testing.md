# SITL live results — moved to GitHub Issues

Per-run SITL suite results are **not** kept in this file (or in a tracked JSON
blob). Updating either on every lab run churns review bots without changing
product code.

**Where results live:** GitHub Issues labeled `sitl-results`.

Each suite run closes the previous open `sitl-results` issue, publishes the new
curated table in a new `sitl-results` issue, and does not open a results-only PR.

- Latest: search
  [issues?q=label%3Asitl-results+is%3Aopen](https://github.com/cmc0619/node-red-contrib-mavlink/issues?q=label%3Asitl-results+is%3Aopen)

**How to run:** see [`sitl/AGENTS.md`](sitl/AGENTS.md).

```bash
node sitl/run-example-suite.js --out /tmp/sitl-example-suite-results.json
```

Do not commit `/tmp/…` or `sitl/example-suite-results.json`.
