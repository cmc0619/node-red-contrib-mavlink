# SITL live results — moved to GitHub Issues

Per-run SITL suite results are **not** kept in this file (or in a tracked JSON
blob). Updating either on every lab run churns review bots without changing
product code.

**Where results live:** open GitHub Issues labeled `sitl-results`.

- Latest: search
  [issues?q=label%3Asitl-results+is%3Aopen](https://github.com/cmc0619/node-red-contrib-mavlink/issues?q=label%3Asitl-results+is%3Aopen)
- After each suite run: open a new issue with the curated table, attach or paste
  the harness JSON summary, then **close the previous** `sitl-results` issue.

**How to run:** see [`sitl/AGENTS.md`](sitl/AGENTS.md).

```bash
node sitl/run-example-suite.js --out /tmp/sitl-example-suite-results.json
```

Do not commit `/tmp/…` or `sitl/example-suite-results.json`.
