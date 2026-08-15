# AGENTS.md

## 1. Mission and authority

This repository implements a MAVLink toolkit for Node-RED. This file governs how agents build,
review, and deliver it. Measured behavior and protocol sources outrank assumptions; re-measure
disputed behavior instead of building around a stale belief.

Record durable lessons in the repository before work is considered ready. Engineering rules
belong in `AGENTS.md`; protocol rulings and measurements belong in `MAVLINK.md`. Form protocol
hypotheses from pymavlink, MAVSDK, Mission Planner, QGroundControl, MAVProxy, and especially the
ArduPilot and PX4 source trees, then confirm them against dialect XML or measured wire behavior.
Reference implementations are strong starting points; the XML and measured reality are final
authority.

## 2. Delivery rules

- Every diff report gives separate additions and deletions for runtime code in `lib/**/*.js`
  and `nodes/*.js`, excluding comments and blank lines. It also gives additions and deletions
  for `nodes/*.html`, including markup, styles, and scripts but excluding comments and blank
  lines. Do not report test counts.
- A PR may touch at most 50 files. Count with
  `git diff --name-only <base>...HEAD | wc -l` and split larger work by module boundary.
- Commit `AGENTS.md` and `MAVLINK.md` directly to `main`, in their own documented commit,
  rather than carrying them in a code PR. If a branch already touched them, do not rewrite
  history merely to move them.
- Agents open PRs as drafts and do not merge them. An agent may mark a specific PR ready or
  merge it only when the repository owner explicitly requests that action. Permission is not
  implied by green checks, approval, “finish,” or a previous instruction for another PR.
- Before every push, run tests and lint, then review the diff with a critical eye toward the
  integrity of this architecture. Reject runtime guardrails outside the `mavlink-in` wire
  boundary, speculative code, duplicated behavior, and new helpers when an existing function
  already owns the behavior. At minimum also check generated seeds, union/merge boundaries,
  editor round-trips, signed and unsigned wire limits, and recursive examples. Verify commands
  by exit status.
- After review starts, use event triggers or periodic timers; never block or busy-poll. Gather
  all open findings into one plan. For each, state the concrete problem, the smallest fix, and
  whether it is applied or declined under this file's rules. Get owner approval before a fix widens
  scope, adds code, or reaches beyond the finding. Resolve handled review threads.
- Issues labeled `sitl-results` are measurement records, not work. Exclude them from triage and
  never close them as stale. Put confirmed protocol lessons in `MAVLINK.md`.

**GitHub → Cursor wake-up (owner setup).** Create a private automation at
https://cursor.com/automations (or `/automate` in the Agents Window) on this repo with
triggers: **CI completed** (covers CodeRabbit check completion) and **PR review submitted**
(covers Codex and human reviews). Prompt should: identify the open PR, collect inline comments
from CodeRabbit / Codex / GitHub Advanced Security, form a plan that applies or declines each
finding against this file while restating the concrete problem and smallest fix per the YAGNI
section, then push fixes under the 50-file cap and reply on the threads. Without a trigger
like this, the fallback is the periodic timer check above — agents otherwise only learn
reviews finished when a human pings them.

## 3. YAGNI and code budget

Build only what a demonstrated Node-RED workflow needs. Do not add caching, retries, fallbacks,
extra validation, abstractions, advisory layers, or handling for hypothetical failures.

Every proposed change must name:

1. the concrete user-visible problem;
2. why existing code cannot handle it; and
3. the smallest fix.

Without that evidence, do not make the change. A maintenance change should leave runtime code
the same size or smaller. A positive net runtime delta must explain exactly what the added code
buys and why existing code could not absorb the change.

Delete dead code and duplicate state. When removing a guard, also remove its dedicated tests,
messages, helpers, comments, fallbacks, and dead branches. If the remaining helper merely calls
another function, inline it; documentation is not a reason to preserve an identity wrapper.

Before adding a function, find the existing owner of that behavior and reuse it. Do not copy
logic, create a parallel helper, or add an abstraction when an existing function can do the job.

Comments describe the code as it exists. Do not leave archaeology such as what changed, what
used to happen, why an old approach was removed, or which PR caused the current implementation.
That history belongs in Git and repository documentation, not source comments.

## 4. Driver, editor, and failure boundary

The architecture is one sentence:

> The editor validates configuration; `mavlink-in` guards the wire; the driver obeys.

`nodes/*.html` validates static node configuration before deploy. Runtime receives that
configuration and assumes it is correct. `nodes/*.js` and `lib/**` form a training-wheels-free
driver with the same expressive power and outbound failure boundary as pymavlink. `mavlink-in`
is the only runtime doorguard because it alone receives untrusted wire input.

| Input | Treatment |
|---|---|
| Static node configuration | The editor validates it before deploy. Runtime assumes it is correct and never checks it again. |
| MAVLink wire input | `mavlink-in` parses it. Discard malformed frames and keep receiving. Forward every valid message unchanged. |
| `msg`, flow context, and node context | Trust them, including messages emitted by `mavlink-in`. Pass them directly to the driver without type, range, shape, or safety checks. If the underlying operation rejects them, it crashes. |

### 4.1 Outbound driver rules

- Pass configured and `msg` values directly into the driver operation. Do not preflight,
  validate, normalize, clamp, or reject them because they are dangerous, unusual, out of range,
  `NaN`, or likely to be ignored by a vehicle.
- Never invent an omitted value. Do not substitute a safe enum member, first option, default
  frame, or other legal value the caller did not choose.
- If the equivalent pymavlink call accepts the values, send them. If it crashes, this driver
  crashes too. Do not catch, translate, default, retry, recover, downgrade to a warning/status,
  or continue past that failure. There are no pymavlink guardrails here.
- Type conversion required by Node-RED serialization is plumbing, not validation.
- Do not emit advisories about what a vehicle may do with a legal request. Keep those facts in
  `MAVLINK.md`.

`msg` and the runtime driver are training-wheels-free. Bad flow data is fixed at its source—the
flow or wiring—after the unmodified failure exposes it. Outside the `mavlink-in` wire boundary,
remove runtime guardrails in `lib/**` or `nodes/*.js` on sight, including their supporting tests
and scaffolding.

### 4.2 Ingress and operational results

- `mavlink-in` is the only runtime validation boundary. It rejects malformed wire frames by
  discarding them, then continues parsing subsequent bytes.
- A valid vehicle message is data, not a policy decision. Forward results such as `DENIED`
  unchanged; the flow programmer may act on them or ignore them.
- An operation that waits for a response may expose a programmer-configurable timeout. Use a
  protocol-defined timeout when MAVLink specifies one. Do not invent a hidden timeout, retry,
  fallback, or recovery policy.
- Once `mavlink-in` emits a `msg`, that message is trusted. No downstream node repeats ingress
  validation.

## 5. Runtime affirmative selection dispatch

In `lib/**` and `nodes/*.js`, whenever a verb or other closed-vocabulary value selects among
multiple implementation behaviors, dispatch it with a `switch`. This is the only permitted
form of runtime affirmative behavioral dispatch. If this layer merely forwards the value, it
has no dispatcher at all.

- Write one `case` for each implemented behavior. Do not add a `default` arm.
- Do not validate the verb or test vocabulary membership before dispatch.
- If a switch's only purpose is to prove that a forwarded verb matches a known member, delete
  the switch and pass the value through untouched.
- Blank, absent, and unknown values in an actual dispatcher match no case and select no
  behavior.
- Do not use `if`/`else`, chained equality tests, ternaries, truthiness, inequality checks, an
  executable lookup table, or any other substitute for a `switch` to choose runtime behavior.
- Do not use `x || 'default'` or a blank check that selects a default member.
- An absent `msg` override may still mean “use the configured operator value.” Either pass the
  resulting value through or dispatch it, according to whether this code actually owns
  multiple behaviors.
- Numeric editor defaults and numeric conversion are not selection dispatch. Do not widen this
  rule into unrelated numeric logic.

Remove validation-only switches and all defaulting, fall-open, validation, and error arms from
real dispatch switches on sight. A real dispatcher contains affirmative `case` arms only.

This rule does not apply to data lookup tables, metadata maps, option registries, or display
mappings. The GUI in `nodes/*.html` is the protector: it may use those structures to render
choices and validate operator input. The runtime driver does not repeat that validation.

## 6. Node-RED configuration contract

Inspect both the `.html` and `.js` halves before changing a node. The editor definition is
the schema for static configuration.

- Declare every property in `defaults` as required, optional with a defined editor default,
  conditionally required, a configuration-node reference, a typed input, or a credential.
- Put static defaults, requirements, ranges, formats, and cross-field rules in the editor using
  `value`, `required`, built-in/custom validators, type declarations, and lifecycle hooks.
- Custom controls must initialize, save, validate, and clean up the value represented in
  `defaults`. Fix broken persistence in the editor; never compensate in runtime code.
- Runtime code uses editor-validated properties directly. Do not add null checks, optional
  chaining, fallback defaults, sanitizers, or duplicate validators.
- Resolve required configuration-node references once and use the result. Do not scatter checks
  for the saved ID.
- For typed inputs, validate the configured expression in the editor. At runtime, evaluate it
  and pass the result on unchanged. Do not guard the resolved value. Dispatch it only when this
  layer owns multiple behaviors; otherwise pass it directly to the core implementation.
- This is a pre-1.0 driver under active development. Do not add migrations, compatibility
  shims, legacy-format handling, deprecation paths, or tests for old flow shapes.

Static configuration is validated in the editor. Runtime code uses the deployed values directly
without checking them.

## 7. Tests

- Editor tests cover defaults, required fields, validators, conditional behavior, typed-input
  configuration, custom-widget persistence, and configuration-node references.
- `mavlink-in` tests prove that malformed frames are discarded without stopping reception and
  that valid vehicle messages are forwarded unchanged.
- Runtime tests start from valid editor-produced configuration and cover valid processing plus
  demonstrated external and operational failures.
- Do not add tests that require guarding trusted `msg` values or impossible configuration.
- When a guard is deleted, delete tests whose only purpose was preserving it.
- Claims of passing tests or lint require the actual command and exit status.

## 8. Implementation workflow

Use sub-agents for multi-module work and match capability to difficulty.

- Respect module dependencies; parallelize only independent work within a layer.
- Give each file or directory one owner. Split work by module and matching tests.
- Brief each sub-agent with the applicable rules from this file, owned files, consumed and
  exposed contracts, and required tests.
- The dispatching agent reviews all output, integrates it, and runs the full suite centrally.
  A sub-agent's verification claim is evidence to recheck, not authority.

## Cursor Cloud specific instructions

### Toolchain and environment

- Target runtime is Node.js (Node-RED node package). The VM has Node 22, `npm`, `pnpm`, and
  `yarn` on `PATH`.
- The startup update script installs dependencies **only if a manifest exists** (guarded on
  lockfile/`package.json`), so it works both before and after the project is scaffolded.
- Until the first implementation PR lands there is no `package.json`, source, tests, lint, or
  runnable app at HEAD — do not hunt for one.

### Standard commands (do not invent alternatives)

- Dependencies: `node-mavlink` and `mavlink-mappings` (the ArduPilot line — verified: no
  `node-mavlink-mappings` package exists), an XML parser, and `serialport` as an **optional**
  dependency. UDP/TCP installs must work without `serialport`.
- Lint: the small ESLint gate (`no-undef`, `no-unused-vars`, `no-unreachable`,
  `no-bitwise` in the codec directory only) scoped to `lib/`, `nodes/`, `test/`. Lint passing is
  never reported as verification.
- Tests: fixture-based suites run in CI/this VM. SITL-backed tests need ArduPilot/PX4 SITL
  instances, which are **not** provisioned here; treat them as out of scope unless the user
  provides a rig. When running the Docker lab, follow [`sitl/AGENTS.md`](sitl/AGENTS.md)
  (prebuilt AP binary — do not waf-compile).
- Run: this is a Node-RED node package — "running" it means installing it into a local Node-RED
  instance (e.g. `npm install <path>` into a Node-RED user dir, then start Node-RED) and
  exercising the nodes in the editor, not launching a standalone server.
