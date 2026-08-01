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

**Greenfield: merge liberally to `main`.** This repo is early build-out, not a guarded
production release train. Once a PR's quorum bots have finished and Critical/Important
findings are handled (or declined), merge to `main` and keep building — do not stockpile
long-lived feature branches waiting for perfection or for optional bots.

**PRs are opened ready for review (not draft)** so bot reviewers run immediately. After push,
wait for a **quorum of finished bots** — enough completed reviews to act on, not every
configured bot. Today that means **CodeRabbit and Greptile both finished** (check
success/failure and read their findings). Codex (`chatgpt-codex-connector`) is not required
for quorum: it often ignores `@codex review` from `cursor[bot]`. If Codex (or a human) does
leave findings, handle them; do not stall waiting for a bot that never starts.

Do not treat the implementation as finished until the quorum's Critical/Important findings
are addressed or explicitly declined per DESIGN.md §2 (with a §14 note when a belief was
displaced). Prefer a Cursor Automation on GitHub **CI completed** (see below) over
busy-polling — this agent cannot create that automation itself.

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

## Custom Node Development: Configuration Trust and Defensive-Code Rules

These rules apply when creating or modifying custom Node-RED palette nodes. They are the
runtime-trust half of one policy; the editor-side half — use the stock platform mechanism for
each job, never a parallel one — is the platform ruleset in `DESIGN.md` §2.

A custom Node-RED node normally has two distinct parts:

- an editor definition in an `.html` file; and
- a runtime implementation in a `.js` file.

The editor definition controls static configuration, defaults, validation, form behavior, and
serialization into the flow. The runtime implementation receives validated configuration and
processes messages, connections, devices, and other dynamic data.

Treat these as different trust boundaries.

The editor definition is the schema and source of truth for static node configuration. Runtime
code MUST trust guarantees established by:

- `defaults`;
- `required`;
- `validate`;
- configuration-node `type` declarations;
- typed-input configuration;
- `oneditprepare`;
- `oneditsave`; and
- other editor lifecycle code.

The normal supported path is:

1. A user adds the custom node from the palette.
2. The user configures it through the Node-RED editor.
3. The editor validates the configuration.
4. The user deploys the flow.
5. The runtime constructor receives the deployed configuration.

Manually corrupted flow JSON, incomplete imports, and deployments forced despite editor errors
are unsupported unless the task explicitly requires supporting them.

### Inspect both halves of the custom node

Before changing runtime configuration handling, inspect both the `.html` and `.js` definitions
of the node.

Do not add a runtime guard for `config.<property>` without first checking:

- whether the property appears in `defaults`;
- whether it has a default `value`;
- whether it is marked `required`;
- whether it has a `validate` function;
- whether it references a configuration node through `type`;
- whether it is populated by a normal editor input;
- whether custom editor lifecycle code modifies or saves it;
- whether it is a typed input with a companion type property; and
- whether it is a credential rather than a normal configuration property.

Never infer configuration nullability from the runtime JavaScript alone.

### Classify every configuration property

Every static configuration property MUST belong to one of these categories:

1. Required and editor-validated.
2. Optional with an editor-defined default.
3. Optional without a default because absence has defined behavior.
4. Conditionally required and conditionally editor-validated.
5. A configuration-node reference.
6. A typed or dynamic input whose configured expression is static but whose resolved value may
   be dynamic.
7. A credential.
8. A documented legacy property handled by an explicit compatibility path.

If a property does not fit one of these categories, clarify its contract before writing runtime
handling.

### Required editor-validated properties

For a property whose editor definition guarantees presence and validity:

- Runtime code MUST use the property directly.
- Runtime code MUST NOT check whether it is null, undefined, blank, or missing.
- Runtime code MUST NOT provide a second default or fallback.
- Runtime code MUST NOT use optional chaining merely to tolerate an editor-invalid
  configuration.
- Runtime code MUST NOT add an error message or recovery branch for a state rejected by the
  editor.
- Runtime tests MUST NOT manufacture configurations that the editor rejects.

Forbidden runtime redundancy:

```js
// Forbidden when targetSystem is required and editor-validated
if (config.targetSystem == null) {
    node.error("Target system is required");
    return;
}
// Forbidden when timeout already has an editor default
const timeout = config.timeout ?? 5000;
// Forbidden speculative tolerance
const mode = config.profile?.mode || "default";
```

Use the established configuration contract:

```js
node.targetSystem = config.targetSystem;
node.timeout = Number(config.timeout);
node.mode = config.profile.mode;
```

Type conversion is allowed when Node-RED serializes an editor value in a different
representation than the runtime needs. Type conversion is not permission to invent a fallback
for a missing required value.

For example:

```js
node.timeout = Number(config.timeout);
node.enabled = config.enabled === true;
```

### Defaults belong in the editor definition

Static defaults MUST be declared once in the custom node's `defaults` definition.

Example:

```js
defaults: {
    timeout: {
        value: 5000,
        required: true,
        validate: RED.validators.number()
    }
}
```

Do not repeat that default in the runtime:

```js
// Forbidden duplication
node.timeout = config.timeout ?? 5000;
```

Use:

```js
node.timeout = Number(config.timeout);
```

A default is not defensive runtime behavior. It is part of the custom node's editor contract.

### Validation belongs in the editor when configuration is static

Use editor validation for static configuration requirements:

- `required: true` for mandatory values;
- `RED.validators.number()` for numeric values;
- `RED.validators.regex()` for supported formats;
- custom `validate` functions for ranges and cross-field rules;
- configuration-node `type` declarations for references; and
- conditional validation when requirements depend on another configured field.

Runtime code MUST NOT duplicate validation already performed by the editor.

Do not use truthiness to validate numbers or Booleans:

```js
// Incorrect because 0 and false may be valid
if (!config.retryCount) {
    // ...
}
```

The editor validator must define the actual valid range or values.

### Custom editor controls must preserve the contract

If a property uses a custom editor widget rather than an automatically managed input:

- `oneditprepare` MUST initialize the widget correctly.
- `oneditsave` MUST save the value into the declared property.
- `oneditcancel` and `oneditdelete` MUST clean up editor resources when necessary.
- The saved property MUST still be represented in `defaults`.
- Validation MUST reflect the value the widget actually saves.
- Runtime fallbacks MUST NOT compensate for a broken editor widget.

If the editor fails to save a required field, fix the editor. Do not bloat the runtime to
tolerate the editor defect.

### Conditional configuration

If a field is required only for a particular mode, transport, command, or option, express that
requirement in editor validation.

For example, if `serialPort` is required only when `transport` is `serial`, the editor validator
should enforce that relationship.

Do not duplicate the same condition in the runtime merely to check whether the user completed
the form.

Runtime code may still branch on the selected mode to perform the requested behavior:

```js
if (config.transport === "serial") {
    openSerialTransport(config.serialPort);
} else {
    openNetworkTransport(config.host, Number(config.port));
}
```

That behavioral branch is legitimate. An additional check that `serialPort` exists is redundant
when the editor already guarantees it.

### Typed inputs and dynamic properties

Typed inputs require special treatment because the editor validates the configured source, but
it may not be able to validate the value resolved from a runtime message.

For a typed input:

- The configured value property and its companion type property MUST be declared correctly.
- The editor MUST validate static configured values.
- Runtime code MUST validate a value resolved from `msg`, flow context, global context,
  environment variables, or another dynamic source when that value is required for the
  operation.
- Runtime code MUST NOT revalidate a literal value already validated by the editor.

Example distinction:

```js
if (config.targetType === "num") {
    // The editor validates the configured literal.
    target = Number(config.target);
} else {
    // The editor can validate the property expression,
    // but only runtime can determine whether the message contains it.
    target = RED.util.evaluateNodeProperty(
        config.target,
        config.targetType,
        node,
        msg
    );
    if (target == null) {
        node.error("The configured target could not be resolved", msg);
        return;
    }
}
```

Validate the dynamic result, not the already-validated editor field that describes where to
obtain it.

### Message input is a runtime boundary

Properties received through `msg` are dynamic runtime input and may require validation.

Runtime validation is appropriate for:

- required message properties;
- dynamically selected property paths;
- payload types;
- numeric ranges;
- MAVLink command arguments;
- buffers and binary data;
- externally supplied identifiers; and
- values resolved from context or environment variables.

Validate only the message properties the operation actually requires.

Do not create a generic message-normalization framework merely because arbitrary malformed
messages are theoretically possible.

### Configuration-node references

A configuration-node property has two related but distinct concepts:

1. the configured reference ID; and
2. the live configuration-node object or resource.

If the editor marks the reference as required, runtime code MUST NOT repeatedly check whether
the reference ID is missing.

Example editor definition:

```js
defaults: {
    connection: {
        value: "",
        type: "mavlink-connection",
        required: true
    }
}
```

The runtime may resolve it once:

```js
node.connection = RED.nodes.getNode(config.connection);
```

Do not scatter checks for `config.connection` throughout the runtime.

A live connection, socket, serial port, or device owned by the configuration node may still
disconnect or fail after valid configuration. Handle those real operational failures where they
occur.

Validate connection readiness, connection state, and I/O failures. Do not repeatedly revalidate
the editor-owned reference ID.

If the project intentionally supports flows with deleted, missing, or unavailable configuration
nodes, handle that once at the configuration-node resolution boundary and document why that
unsupported editor state is being accepted.

### Credentials

Credentials are different from ordinary configuration because they may be omitted from exported
flows or become unavailable after an import.

Credential handling MAY validate that required secrets are available at runtime when their
absence is a supported operational possibility.

Credential checks MUST:

- occur once at the credential boundary;
- explain the legitimate path by which the credential may be absent;
- avoid logging or exposing the credential;
- produce a useful Node-RED status or error; and
- avoid repeated checks throughout message-processing code.

Do not treat every normal configuration property like a credential merely because credentials
require special handling.

### Runtime validation is appropriate only at real runtime boundaries

Runtime code SHOULD validate data or operations the editor cannot guarantee, including:

- `msg` properties;
- dynamic typed-input results;
- network responses;
- file contents;
- serial data;
- device data;
- API responses;
- MAVLink messages;
- mutable node, flow, or global context;
- environment-dependent values;
- credentials legitimately absent after import;
- connection establishment;
- connection loss;
- timeouts;
- resource exhaustion; and
- documented legacy flow formats.

These are genuine runtime conditions. Static required editor fields are not.

### Proof-of-possibility rule

Every new defensive branch MUST answer:

> What supported execution path can reach this state?

The answer must identify a real path through:

- normal custom-node operation;
- dynamic message input;
- an external system;
- a documented import or credential behavior;
- a documented legacy flow format; or
- an actual resource or connection failure.

If no supported path exists, do not add the guard.

The following are not supported paths unless the task explicitly says otherwise:

- manually corrupted flow JSON;
- forced deployment despite editor validation errors;
- missing required fields rejected by the editor;
- impossible combinations rejected by editor validation;
- hypothetical future requirements;
- "just in case";
- "for robustness" without a concrete failure path; and
- making unit tests pass when those tests construct impossible configurations.

### Backward compatibility

When an existing flow created by an older version of the custom node may legitimately lack a
newly introduced property:

- Handle it through one explicit migration or compatibility boundary.
- Identify the version or historical flow shape being supported.
- Add a focused compatibility test.
- Do not scatter `??`, `||`, optional chaining, or missing-field checks throughout the runtime.
- Remove the compatibility path when that legacy format is no longer supported.

A hypothetical old flow is not sufficient justification. Confirm that the older published custom
node actually produced that flow shape.

### Failure behavior

Do not silently repair violated internal invariants.

If an invariant can genuinely be violated because of a programming defect, fail clearly at the
nearest appropriate boundary.

Do not add permissive fallback behavior throughout the custom node that hides:

- an editor defect;
- a serialization defect;
- an incorrect property name;
- a missing declaration in `defaults`;
- a broken `oneditsave`;
- an incorrect configuration-node type; or
- a programming error.

Fix the source of the invariant violation.

### Testing boundaries

Editor-focused tests should verify:

- required fields;
- default values;
- custom validators;
- conditional validation;
- typed-input configuration;
- custom widget persistence; and
- correct configuration-node references.

Runtime tests should begin with valid static node configuration and exercise:

- valid message processing;
- missing or malformed dynamic message values;
- connection failures;
- unavailable devices;
- external protocol errors;
- timeouts;
- invalid API responses;
- MAVLink errors; and
- other demonstrated runtime conditions.

Runtime constructor tests MUST NOT omit required editor-validated properties unless testing a
documented compatibility path.

Do not retain tests whose only purpose is protecting impossible configurations.

A test does not prove that an invalid state must be supported when the test itself bypasses the
Node-RED editor contract.

### Bloat prevention

Do not create helpers, normalizers, fallback objects, custom errors, wrappers, logging branches,
or abstractions solely to handle states prohibited by the custom node's editor contract.

Do not add:

- a generic configuration sanitizer;
- a second copy of editor validation;
- fallback defaults in multiple runtime functions;
- optional chaining throughout the runtime;
- defensive copies of required scalar configuration;
- compatibility code without an identified legacy version; or
- speculative recovery code for hypothetical malformed flows.

When removing a redundant guard, also remove its dedicated:

- tests;
- error messages;
- helper functions;
- comments;
- fallback values; and
- dead branches.

**Re-read what the removal left behind.** A helper whose body *was* the guard does not survive the
guard. After deleting a branch, look at the remaining function: if the body is a single
pass-through call — `f(a, b)` whose body is `b(a)` — it is an identity wrapper. Delete it and
inline the call at every site.

Two rationalisations to refuse by name, because both feel like diligence:

- *"The wrapper still carries the documented contract."* A JSDoc paragraph is not a reason for a
  function to exist. Move the contract to whatever still enforces it — a lint, a source-scan
  test, or a comment at the call sites — and delete the function.
- *"Changing its signature is the tidy fix."* Rewriting an identity wrapper's callers to keep it
  is strictly more churn than deleting it, and it preserves the indirection the removal was
  supposed to eliminate. If the callers are being touched anyway, they are being touched to
  delete it.

Prefer the smallest custom-node implementation that handles:

1. valid editor-produced configuration;
2. required dynamic message validation; and
3. demonstrated external or operational failures.

Do not build infrastructure for imaginary failures.

### Controlling rule

Every defensive branch must name a supported execution path that can reach it.

"The required custom-node editor field might somehow be null" is not a supported execution path.

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
  provides a rig. When running the Docker lab, follow [`sitl/AGENTS.md`](sitl/AGENTS.md)
  (prebuilt AP binary — do not waf-compile).
- Run: this is a Node-RED node package — "running" it means installing it into a local Node-RED
  instance (e.g. `npm install <path>` into a Node-RED user dir, then start Node-RED) and
  exercising the nodes in the editor, not launching a standalone server.
