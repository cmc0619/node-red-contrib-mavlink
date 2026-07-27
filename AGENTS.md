# AGENTS.md

## Cursor Cloud specific instructions

### Current state of this repository

This repo is **specification-only**. The tracked files are `DESIGN.md`, `LICENSE`, and
`.gitignore`. There is **no application code, `package.json`, lockfile, tests, lint config, or
build** yet. `DESIGN.md` is the authoritative build specification for a planned
**"MAVLink for Node-RED"** toolkit (a Node.js / Node-RED node package).

Consequences for setup:

- There is nothing to install, lint, test, build, or run at HEAD. Any "run the app" request
  cannot be satisfied until the package described in `DESIGN.md` is actually implemented.
- Do not scaffold the whole project as part of environment setup — implementing the package is
  a development task driven by `DESIGN.md` (see its §12 build order), not an env-setup step.

### Toolchain

- Target runtime is Node.js (Node-RED package). The VM already has Node 22, `npm`, `pnpm`, and
  `yarn` on `PATH`; no version manager juggling is needed.
- The startup update script installs dependencies **only if a manifest exists** (guarded), so it
  is a no-op today and will "just work" once a `package.json`/lockfile is added.

### When code is added, where the standard commands live

`DESIGN.md` already pins the intended tooling; use it as the source of truth instead of
inventing commands:

- Dependencies: `node-mavlink` and `mavlink-mappings` (the ArduPilot line), an XML parser, and
  `serialport` as an **optional** dependency (§3). UDP/TCP installs must work without
  `serialport`.
- Lint: a small, high-signal ESLint gate (`no-undef`, `no-unused-vars`, `no-unreachable`, and
  `no-bitwise` in the codec directory only) scoped to `lib/`, `nodes/`, `test/` (§13). Lint is
  not a substitute for tests.
- Tests: fixture-based unit tests (field codec, XML compile, param rendering, etc.) plus
  SITL-backed integration tests requiring ArduPilot/PX4 SITL instances (§13). SITL is **not**
  provisioned in this VM; fixture-only tests are what run without external simulators.
- Run: this is a Node-RED node package, so "running" it means loading the nodes inside a
  Node-RED instance, not launching a standalone server.

### Verified ground truth (matches `DESIGN.md` §14)

- `node-mavlink@2.3.0` resolves and declares `github.com/ArduPilot/node-mavlink` as its repo.
- `mavlink-mappings` is a real package; `node-mavlink-mappings` does **not** exist on npm.
