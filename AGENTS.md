# AGENTS.md

## Mission

This repository is the build target for `DESIGN.md`: implement the complete
**"MAVLink for Node-RED"** toolkit described there. `DESIGN.md` is the authoritative
specification — its code principles (§2), UI rules (§6), build order (§12), testing plan (§13),
and ground truth (§14) are binding, not suggestions. When code and spec disagree, the spec wins;
when the spec and measured reality disagree, re-measure (§14) and update the spec in the same PR.

**Session lessons belong in `DESIGN.md`, not in chat.** Every displaced belief, measured fact,
or working reference that changes how the toolkit must be built is written into the affected
section plus a §14 ground-truth entry before the PR is considered ready. The next agent will
not see this conversation.

**PR size cap: 50 files.** Do not push a pull request whose diff touches more than 50 files.
Split by module boundary (`lib/<module>`, `nodes/<node>`, matching tests) into sequential PRs
when a layer would exceed the cap. Count is `git diff --name-only <base>...HEAD | wc -l`.

**PRs are opened ready for review (not draft)** so bot reviewers run immediately. After push,
wait for **all** of: CodeRabbit, Greptile, and Codex (`chatgpt-codex-connector`). Do not treat
the implementation as finished until those reviews are read and Critical/Important findings
are addressed or explicitly declined per DESIGN.md §2 (with a §14 note when a belief was
displaced). Prefer a Cursor Automation on GitHub **CI completed** + **PR review submitted**
(see below) over busy-polling — this agent cannot create that automation itself.

**Codex re-review is manual.** CodeRabbit and Greptile re-run on push; Codex does not.
After pushing review fixes, post a top-level PR comment exactly: `@codex review`.

**Resolve review threads as they are handled.** When a finding is fixed (or declined with a
DESIGN.md / §14 reason), mark its GitHub review thread Resolved — do not leave fixed threads
open for the next passer-by.

**GitHub → Cursor wake-up (owner setup).** Create a private automation at
https://cursor.com/automations (or `/automate` in the Agents Window) on this repo with
triggers: **CI completed** (covers CodeRabbit / Greptile check completion) and **PR review
submitted** (covers Codex and human reviews). Prompt should: identify the open PR, collect
inline comments from CodeRabbit / Greptile / Codex, apply or decline each finding against
DESIGN.md, push fixes under the 50-file cap, and reply on the threads. Without this, agents
only learn reviews finished when a human pings them.

**PRs are opened ready for review, not as drafts.** After push, mark the PR ready and **wait
for bot reviewers** (CodeRabbit, Greptile, and any other configured checks) to finish before
treating the change as done or stacking more work that depends on their feedback. Address
Critical/Important findings before moving on.

## Implementation workflow: use sub-agents (repo-owner directive)

The repo owner wants implementation parallelized with sub-agents, with agent capability matched
to task difficulty. When executing any multi-module chunk of the build, do this rather than
writing everything serially in one context:

### How to split the work

- **Respect the §12 dependency order between layers, parallelize within a layer.** The metadata
  pipeline (§4) and the field codec (§5) are mutually independent — the codec takes compiled
  metadata as an *argument* and imports nothing above it — so they are the canonical first
  parallel pair. Config nodes, then Connection, then palette nodes follow; sibling palette nodes
  (Command, Move, Param, Payload, State) are independent of each other once Connection's
  subscription/queue contracts exist.
- **One owner per file/directory.** Never have two concurrent sub-agents writing the same file.
  Split by module boundary (`lib/<module>`, `nodes/<node>`, matching tests), which `DESIGN.md`
  §2 already requires of the code itself.
- **Self-contained briefs.** A sub-agent cannot see this conversation. Each brief must name the
  exact `DESIGN.md` sections that govern its module, the files it owns, the contracts it consumes
  and exposes, and the tests it must ship (tests are the deliverable for the codec — §5).
- **Integrate and verify centrally.** The dispatching agent reviews every sub-agent's output
  against the spec, runs the full lint/test suite after integration, and owns the final result.
  A sub-agent's claim of passing tests is checked, not trusted.

### Matching skill level to the task

Use the appropriately skilled agent for the task at hand. Judge each task's difficulty at
dispatch time and pick the sub-agent capability to match — subtle, correctness-critical work
gets a stronger agent; mechanical or repetitive work gets a faster, lighter one. No fixed
module-to-tier mapping; the dispatching agent decides per task.

## Cursor Cloud specific instructions

### Toolchain and environment

- Target runtime is Node.js (Node-RED node package). The VM has Node 22, `npm`, `pnpm`, and
  `yarn` on `PATH`.
- The startup update script installs dependencies **only if a manifest exists** (guarded on
  lockfile/`package.json`), so it works both before and after the project is scaffolded.
- Until the first implementation PR lands there is no `package.json`, source, tests, lint, or
  runnable app at HEAD — do not hunt for one.

### Standard commands (per `DESIGN.md`; do not invent alternatives)

- Dependencies: `node-mavlink` and `mavlink-mappings` (the ArduPilot line — verified: no
  `node-mavlink-mappings` package exists), an XML parser, and `serialport` as an **optional**
  dependency (§3). UDP/TCP installs must work without `serialport`.
- Lint: the small ESLint gate of §13 (`no-undef`, `no-unused-vars`, `no-unreachable`,
  `no-bitwise` in the codec directory only) scoped to `lib/`, `nodes/`, `test/`. Lint passing is
  never reported as verification.
- Tests: fixture-based suites run in CI/this VM. SITL-backed tests (§13) need ArduPilot/PX4 SITL
  instances, which are **not** provisioned here; treat them as out of scope unless the user
  provides a rig.
- Run: this is a Node-RED node package — "running" it means installing it into a local Node-RED
  instance (e.g. `npm install <path>` into a Node-RED user dir, then start Node-RED) and
  exercising the nodes in the editor, not launching a standalone server.
