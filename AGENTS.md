# AGENTS.md

## Mission

This repository is the build target for `DESIGN.md`: implement the complete
**"MAVLink for Node-RED"** toolkit described there. `DESIGN.md` is the working specification —
a direction, not a bible. It has had many hands in it and may contain incorrect information.
Its code principles (§2), UI rules (§6), build order (§12), testing plan (§13), and ground
truth (§14) are the default authority, not infallible law: when code and spec disagree, the
spec wins until proven wrong; when the spec and measured reality disagree, re-measure (§14)
and update the spec in the same PR. When you find a stale or incorrect statement in
`DESIGN.md`, fix it there rather than working around it.

**Session lessons belong in files, not in chat.** Toolkit lessons — every displaced belief,
measured fact, or working reference that changes how the toolkit must be built — are written
into the affected `DESIGN.md` section plus a §14 ground-truth entry. MAVLink protocol lessons
go into `MAVLINK.md` (create it if absent), and **only when sure**: phone a friend first —
form the hypothesis from the reference implementations (pymavlink, MAVSDK, the GCS codebases,
and above all the ArduPilot and PX4 source trees) — then confirm it against the dialect XML or
measured on-wire behavior (§14) before writing the entry. Write entries before the PR is
considered ready. The next agent will not see this conversation.

**Reference implementations: trusted starting points, not ground truth.** pymavlink, MAVSDK,
and the GCS codebases (Mission Planner, QGroundControl, MAVProxy) are established,
battle-tested ecosystem software — consult them for how things are done: framing, sequencing,
command and parameter protocols, edge cases. Their behavior is the default hypothesis, almost
certainly more right than anything reasoned from first principles, LLM or human. The
ArduPilot and PX4 source trees sit a level higher: they are what real vehicles actually fly,
the true references for on-wire behavior. But no implementation is this toolkit's ground
truth — they disagree with each other, and with the spec, often enough that copying any one
wholesale imports its bugs. Final authority stays with `DESIGN.md` and §14 — the dialect XML
and measured reality.

**Every report of a diff includes the runtime-logic line count, and the count is code, not
prose** (owner standing orders, 2026-08-10 and 2026-08-14). Additions/deletions across
`lib/**/*.js` + `nodes/*.js`, with tests and editor `.html` broken out separately. Raw
`git diff --numstat` is the wrong instrument on its own: this codebase carries more comment
than code on new work (measured on #303: +410 code against +552 comment in one runtime diff),
so numstat roughly doubles every number and buries the delta the net-code-budget rule
governs. Report the **comment-and-blank-stripped** count as the headline; numstat may ride
alongside, labeled. A diff line whose content starts with `//`, `*`, `/*`, `*/` or is blank
is prose, not code — strip both added and removed sides before netting.

**PR size cap: 50 files.** Do not push a pull request whose diff touches more than 50 files.
Split by module boundary (`lib/<module>`, `nodes/<node>`, matching tests) into sequential PRs
when a layer would exceed the cap. Count is `git diff --name-only <base>...HEAD | wc -l`.

**`DESIGN.md` and `AGENTS.md` are written straight to `main`, never through a PR.** A PR
carries code and its tests. Docs in the branch re-churn the diff on every review round — a
§14 entry gets rewritten each time a finding lands, and reviewers re-read a file that was
never the thing under review. Commit them directly instead, in their own commit, with the
reasoning in the message.

This also lands the ruling immediately, which is the point: §14 is what the review bots read,
so a decision recorded there stops the next bot re-raising it *during* the PR rather than
after it merges.

Two consequences to accept. A §14 entry on `main` can briefly describe behaviour whose code is
still in flight — that self-corrects on merge, and needs pulling back out if the PR is
abandoned. And if the branch already touched those files before you noticed, leave the history
alone: a force-push to tidy a doc nobody reviews commit-by-commit is worse than the untidiness.

**Merges to `main` are human-only.** An agent never merges a pull request — not when checks
are green, not when the work looks finished, not when reviewers approve. Push the branch, keep
the PR current, and stop. The repo owner reviews the code and merges when satisfied.

**PRs are opened as drafts — only the repo owner marks them ready.** Bot reviews are a finite
resource; never spend them on work-in-progress. Open every PR as a draft and keep pushing to
it while iterating. The boundary is absolute: an agent never flips a PR to ready-for-review —
not when the work looks done, not when tests are green, not when told to "wrap up." The owner
flips it when they're satisfied, and that flip is what triggers the reviewers. **The flip also
reverses the push rule** (owner, 2026-08-14: *"you can push while the PR is in draft. Just use
local after it undrafts. That's the actual rule"*): while the PR is a draft, push freely — drafts
don't spend reviews (CodeRabbit answers a draft push with "Review skipped: Draft detected"), and
unpushed commits live only in an ephemeral container. Once the PR is ready-for-review, commits
stay **local** until the owner says push, because every post-flip push spends a metered bot round.
A stop hook that nags about unpushed commits is not the owner and never overrides this.
(Reviewer roster measured on #296,
2026-08-13: **CodeRabbit**, **Codex** (`chatgpt-codex-connector`), **Sourcery**, **Gitar**,
**Codacy** and **DeepSource** all review, and sometimes **GitHub Advanced Security** / CodeQL
inline comments — Greptile is gone).

**Run the bot gauntlet locally before you push.** (owner standing order, 2026-08-13) Every push to
a reviewed branch re-runs all six reviewers against an org spending cap CodeRabbit has already hit
this week, so the review they would give is one you owe yourself first: re-read your own diff
wearing their lenses, fix what you find, and let the push spend one round instead of three.
`npm test` and `npm run lint` are the floor, not the gauntlet — `/code-review` at high effort is
the local stand-in for the reading. The lenses that have actually caught things here:

- **Generated artifacts go stale silently.** A parser that learns a new field leaves every
  committed blob under `seed/` without it. #296 shipped a bitmask picker that could never render
  on a fresh install — 30,938 definitions, zero `bits` — until the seed was regenerated.
- **Union and merge boundaries.** New metadata that *acts* must be listed where "whichever
  document came first wins" is a wrong answer, not just where it is parsed (`unionSafe()`).
- **Editor round-trips, not just the happy click.** Every field the operator can *type* into has a
  hand-edited state, an out-of-range state, and a stale-widget state. All three were findings.
- **Wire limits in both spellings.** int32/uint8 edges, and the signed and unsigned readings of
  the same bits.

The target is a first bot round that finds nothing. Three pushed rounds on #296 were all findable
from the repo alone.

**Bot feedback is event-driven or timer-driven, never blocking.** After the owner marks a PR
ready, do not sit waiting for reviewers and do not busy-poll. If the environment supports
GitHub triggers — for example Claude's GitHub integration, or the Cursor automation described
below — the trigger wakes the agent when CI completes or a review is submitted. Absent
triggers, set a timer and check the PR periodically for new bot reviews. When feedback
arrives, collect all open findings and form one plan — apply or decline each against DESIGN.md
§2, with a §14 note when a belief was displaced. Agents chronically forget the YAGNI
constraint when reacting to review findings, so every planned fix must restate the concrete
problem it solves and the smallest change that solves it; a finding whose fix cannot be
justified that way is declined, not indulged. Share the plan with the owner before pushing
whenever a fix grows scope, adds code, or reaches beyond the finding's own lines; trivial
in-place fixes may be applied directly and reported in the plan. Do not treat the
implementation as finished until Critical/Important findings are addressed or explicitly
declined. If a human leaves findings, handle those too.

**Resolve review threads as they are handled.** When a finding is fixed (or declined with a
DESIGN.md / §14 reason), mark its GitHub review thread Resolved — do not leave fixed threads
open for the next passer-by.

**Issues labelled `sitl-results` are records, not work — skip them.** They hold SITL suite
measurements, kept as issues deliberately so every agent can read the same numbers. The label
is the filter. Do not count them as outstanding work, do not include them when triaging or
proposing what to do next, and above all do not offer to close one as stale because the `main`
it references has moved on — being pinned to a commit is the point. The *rulings* a run
produces still go to `DESIGN.md` §14; the issue is the raw evidence behind them.

**GitHub → Cursor wake-up (owner setup).** Create a private automation at
https://cursor.com/automations (or `/automate` in the Agents Window) on this repo with
triggers: **CI completed** (covers CodeRabbit check completion) and **PR review submitted**
(covers Codex and human reviews). Prompt should: identify the open PR, collect inline comments
from CodeRabbit / Codex / GitHub Advanced Security, form a plan that applies or declines each
finding against DESIGN.md while restating the concrete problem and smallest fix per the YAGNI
section, then push fixes under the 50-file cap and reply on the threads. Without a trigger
like this, the fallback is the periodic timer check above — agents otherwise only learn
reviews finished when a human pings them.

## Simplicity: YAGNI is a hard constraint

Favor the simplest code that directly serves the real Node-RED workflow. Treat YAGNI as a hard
constraint: do not add caching, retries, fallbacks, migrations, compatibility shims, extra
validation, abstractions, or defensive handling unless there is a demonstrated failure in this
deployment.

This UI builds flows; collect correct data in the editor, deploy it, and let the core runtime
fail loudly when inputs or environment are wrong. Do not silently repair bad data or hide
operational errors. Prefer deleting dead code and duplicate state over adding "just in case"
logic.

For every proposed change, state the concrete user-visible problem, why existing code cannot
handle it, and the smallest possible fix. If that evidence is absent, do not make the change.

**Net code length is a budget.** A change that is not adding a new feature should leave the
codebase the same size or smaller — deletion and simplification are the default shape of
maintenance work. If a non-feature change nets positive in code size, the PR must explain
concretely why the growth is necessary: what it buys, and why the existing code could not
absorb the change. Without that justification, rework the change to be smaller.

The node-specific application of this rule is the Configuration Trust ruleset further down:
that section is this principle worked out per configuration-property category, not a separate
policy.

## We are building two things: a driver and a protector (owner ruling, 2026-08-12)

Read this before writing a line of runtime code. Nearly every guardrail this project has had to
delete came from missing it.

**Thing one is a driver.** `lib/**` and `nodes/*.js` together are a MAVLink driver — call it a
framework, an SDK, a wrapper, whatever. It exposes the protocol's full expressive power. The
benchmark is pymavlink: **if you can fly a drone into the ground at 500 mph with pymavlink, you
can — and *should* be able to* — do it with this code.** A driver that second-guesses its caller
is a worse driver.

**Thing one never refuses a value you gave it. It coerces and sends.** Not "refuses only
dangerous things", not "refuses only impossible things" — never. There is no value or
combination of values that makes runtime code throw on the way to the wire. A field with no slot
in the message being built is ignored, not rejected. An out-of-range number, a `NaN`, a heading
of 4000° — all of it rides. Whatever comes out the other side is what the vehicle gets to judge.

**Thing one also never invents a value you did not give it** (owner ruling, 2026-08-14: *"if a
flow sends nonsense then it deserves to fail"*, *"if I don't correctly set a variable don't
default it to something"*, *"we want a nice big crater sized hole if we don't put the right data
in"*). Not refusing and not inventing are the same discipline, not opposite ones: both say the
caller decides and the driver does not substitute its own judgement. Coercing a value is
obeying; conjuring one is guessing.

So a **missing** required input, or a token that is not a member of its enum, **throws** — loud,
at the point where the meaning was lost, naming what was expected. It does not fall back to a
"safe" member, a "frame that works everywhere", or the first option in a list. Those defaults do
not fail safe; they fail *silently*, and the wire carries a legal message nobody asked for. The
worked example is `frameForAltRef`: a typo'd `msg.payload.altRef` of `'MSL'` used to coerce to
above-home and fly the entire goto at the wrong altitude datum — hundreds of metres — with a
clean `ACCEPTED` ack and nothing in any log (`DESIGN.md` §14, 2026-08-14).

The benchmark holds on both halves. pymavlink's generated `*_send()` methods take positional
arguments: pass a garbage frame number and it packs it without comment; omit the argument and
Python raises `TypeError`. Neither is second-guessing the caller.

If bad data reaches thing one, **that is still a bug, and the job is to hunt it down and stomp
on it at its source** — in the editor, in the flow, in our own wiring. The crater is how you
find the source; it is not a licence to add a *value* check at the point where the bad data
surfaced. Adding that check hides the bug and costs code.

**Thing two is a protector.** `nodes/*.html` — the editor dialog — is the *only* place that
protects the user from a dumb decision. It validates operator input at configure time: field
requirements, ranges, cross-field rules, options that cannot legally combine. When something
must be stopped, it is stopped here, before deploy, where the operator can see and fix it. The
Configuration Trust ruleset below is this sentence worked out property by property.

That is the whole architecture. Editor validates; driver obeys.

### What this does not mean

- **Decoding is not refusing.** The codec parsing bytes off the wire is the *receive* direction,
  not the send path. A malformed frame failing to parse is a parse failure, and it stays. This
  ruling governs data flowing out: config → node runtime → `lib/**` → wire.
- **Operational failure is not refusing.** A dropped connection, a timeout, an ack that never
  comes, a vehicle answering `DENIED` — real conditions, reported where they occur.
- **Type conversion is not refusing.** Turning a saved string into a number is plumbing.

### Advisories are dead

The warn-but-still-send layer — `advisoryFor` and anything like it, emitting "PX4 ignored
BODY_OFFSET_NED in measurement (§14); sent as configured" — is **removed**. A driver does not
editorialise about what the vehicle will do with a legal message. The §14 measurements behind
those strings stay in `DESIGN.md`, where they are documentation rather than runtime weight.

### Enforcement

Going forward, plus **remove on sight**: any guardrail you encounter in `lib/**` or `nodes/*.js`
while working on something else is deleted in that change, along with its tests, error strings,
helpers and comments. A full audit of the existing surface comes at the end; until then, seeing
one and leaving it is not an option.

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
- Runtime code MUST handle a typed input that does not *resolve at all* — the configured
  property is absent from `msg`, context, or the environment — when the operation requires it.
  That is a missing lookup, not a distrusted value: report it and stop, rather than continuing
  with `undefined`.
- Runtime code MUST NOT then validate the resolved value's type, range, or shape. Once the
  lookup succeeds the value is trusted like any other `msg` content (see "`msg` is trusted").
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

### Three kinds of input, three treatments (owner ruling, 2026-08-12)

This is the driver/protector split above, applied to where a value came from. The governing
sentence is still "editor validates; driver obeys" — this table only says which door each value
came through. Naming the category is most of the decision, and only one of the three is checked
in the runtime:

| Input | Trusted? | Checked where |
|---|---|---|
| **Operator UI entry** — what a person types into a node's dialog | **No** | **The editor.** `defaults`, `required`, `validate`, `oneditsave`. Never re-checked at runtime. |
| **`msg`** — what arrives from upstream nodes | **Yes** | **Nowhere.** Use it. |
| **External input** — bytes and answers from outside the flow | **No** | **The boundary that receives it**, once: codec, transport, parser, API client. |

**`msg` is trusted** because it is the flow author's own intermediate state — the output of
nodes the same user wired together, not hostile input crossing a security boundary. Guarding
it is the same guardrail as guarding `config`, one hop further along, and the net-code budget
applies just as hard:

```js
// Forbidden — msg is trusted, and a bad value here is the flow author's bug to see
if (!Number.isFinite(Number(msg.payload.yaw))) {
    throw new Error('yaw must be a number');
}
```

Let it through and let the core runtime fail loudly if it is wrong. That is the same rule the
YAGNI section states for configuration, and it is why a `msg`-shaped guard cannot be justified
by "the value could be anything" — so could every value in every program.

**External input is not trusted**, and this is the distinction that makes the ruling workable
rather than reckless. MAVLink frames off the wire, serial bytes, file contents, HTTP and API
responses, device data: none of it was produced by the user's flow, none of it is covered by
"trust the flow author", and all of it is parsed rather than assumed. That work belongs at the
boundary that receives it — the codec fails loudly on a malformed frame by design — and it
happens **once**, there, not re-checked by every node downstream. The moment external data has
been decoded and put on a `msg`, it is `msg`: trusted from then on.

Operational failure is a fourth thing and not an input check at all. A connection that drops,
a timeout, an ack that never comes, a vehicle that answers `DENIED` — real conditions, handled
where they occur.

*Superseded:* this section previously read "Message input is a runtime boundary" and listed
`msg` properties, payload types, numeric ranges and MAVLink command arguments as appropriate
targets for runtime validation. That is the belief this ruling displaces. It cost a guard in
`lib/move/index.js` refusing a non-numeric `msg.payload.yaw` (#283, reverted) — written in
good faith against the old wording, which is why the wording is gone rather than annotated.

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

- a typed input that does not resolve at all (the lookup, not the value — see above);
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
