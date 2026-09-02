# AGENTS.md

## 0. The two artifacts (read first)

Pymavlink describes itself: "a low level and general purpose MAVLink message
processing library." This repo's **driver** (`lib/**`, `nodes/*.js`) IS that, for
Node-RED. Three words are the whole doctrine:

- **low level** — no policy. The library packs, sends, receives, unpacks. What the
  messages mean, and whether sending them is wise, is not this layer.
- **general purpose** — no application opinions. The library does not know what a
  safe input is, and must not learn.
- **message processing** — the job is the wire format. If the wire can carry it,
  the library carries it. Pinned facts: pymavlink performs no semantic
  validation — any mode number, any param value, any target id is packed and
  sent; it raises only at pack time (a type/range the underlying struct cannot
  carry) or on I/O error. Where you are unsure what pymavlink does with an
  input, the answer is: nothing — it packs and sends it. Parsing inbound frames
  and discarding malformed ones is part of the job; that is the wire format
  talking, not validation policy.

The **editor** (`nodes/*.html`) is the application built ON that library — what
MAVProxy and DroneKit are to pymavlink. Applications own protection: pymavlink
does not stop MAVProxy from sending a bad mode number; MAVProxy validates its
own UI. Here, the editor is the protector — ALL input validation lives in
`.html` as deploy-time red rings. It is paranoid so the driver doesn't have to
be.

### The driver rule

**The driver trusts its input. GIGO is supported behavior.** If pymavlink would
send it, this driver sends it — including commands that fly the aircraft into a
building. That is the product, not a defect.

Decision procedure before writing ANY runtime check:

1. Does the wire format or underlying library itself refuse this? → The driver
   may surface that refusal (a serializer range error, a queue that is actually
   full, a socket that is actually dead).
2. Could the editor reject this at deploy time? → It belongs in the `.html` as
   a red ring. Write it there, or nowhere.
3. Is it an operational failure that cannot exist until runtime (dead link
   mid-send, ack timeout, full queue)? → Settle it as a result record or node
   status via the async plumbing. Never a validation throw, never silence.

If none apply, there is no check. Bad input rides to whatever the spec does
with it. The correct response to bad input is to send it.

### Forbidden in the driver (PRs containing these are rejected on sight)

- `throw` whose message names a vocabulary ("expected one of …"), a required
  field, or a range
- Membership tests on input: `includes(x) ? x : 'custom'`, `hasOwnProperty`
  guards, enum/vocabulary resolver functions
- Defaults or coercions on input: `x || 'default'`, `Number(x) || 0`,
  `?? fallback`
- `switch` with a `default:` arm — behavior dispatch is affirmative `case` arms
  only (§5); an unmatched value selects no behavior
- try/catch whose purpose is converting bad input into a nicer error
- "Helpful" refusal errors ("refusing to …", "must be …", "cannot target
  broadcast")
- Comments describing checks that do not exist

Existing violations in the tree are scheduled for removal. Do not imitate them.
Do not "fix" bad input. Do not add a test asserting that bad input is
rejected — the driver's contract with bad input is that it is sent.

### The walled garden rule

The editor is where protection lives, and it MUST be exhaustive: every
closed-vocabulary field is a `required` select; every numeric field carries a
range validator; every dependency between fields (delivery tier vs broadcast
target, passphrase vs raw key) is a deploy-time red ring. If you feel the urge
to protect the operator while editing driver code, that urge is correct — and
it belongs HERE. Write the red ring instead.

### The shibboleth

Ask: "What happens if `msg.payload.x` is garbage?" The only correct answer:
"It goes on the wire." (Or, where the wire format itself cannot carry it: the
serializer's own error.)

## 1. Mission and authority

This repository implements a MAVLink toolkit for Node-RED. This file governs how agents build,
review, and deliver it. Measured behavior and protocol sources outrank assumptions; re-measure
disputed behavior instead of building around a stale belief.

That ranking governs facts about the protocol and the wire. It is not a channel for
overturning §0. A measurement can prove a mechanism; it cannot decide whether this project
should guard against it — that is a design question and §0 already answers it. See §9,
"A repro is not a ruling."

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
- Agents open PRs as drafts. Creating a non-draft PR is never allowed; a hook may
  deny that. Marking a PR ready, or merging it, is the owner's call. When the
  owner asks the agent to mark one ready or merge one, that ask **is** the call —
  execute it. A hook cannot see the ask, so it must not deny ready or merge.
  Permission is not implied by green checks, approval, “finish,” or a previous
  instruction for another PR.
- Before every push, run tests and lint, then review the diff with a critical eye toward the
  integrity of this architecture. Reject runtime guardrails outside the `mavlink-in` wire
  boundary, speculative code, duplicated behavior, and new helpers when an existing function
  already owns the behavior. At minimum also check generated seeds, union/merge boundaries,
  editor round-trips, signed and unsigned wire limits, and recursive examples. Verify commands
  by exit status.
- Review findings are answered in batches, never per-finding. Hold fixes locally until every
  bot in the round has reported and gone quiet, then push one validated response. A push while
  a review is mid-flight, or for a nitpick alone, is churn against the metered cap — it is how
  the cap gets burned down to a rate limit. **The stop hook's commit-and-push nag yields to
  this batching**: commit locally if the hook demands it, but the push waits for the round to
  complete. (Owner standing order, 2026-08-21, after a six-push PR drained the CodeRabbit
  allowance.)
- After review starts, use event triggers or periodic timers; never block or busy-poll. Gather
  all open findings into one plan. For each, state the concrete problem, the smallest fix, and
  whether it is applied or declined under this file's rules. Applied and declined are not equally
  weighted defaults — §9 governs which findings a review bot has standing to raise at all, and
  sets decline as the default for a named class. Get owner approval before a fix widens
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

## 4. Wire ingress and operational specifics

`mavlink-in` is the only runtime doorguard, and it is one because it alone
receives untrusted wire input:

- It rejects malformed wire frames by discarding them, then continues parsing
  subsequent bytes.
- A valid vehicle message is data, not a policy decision. Forward results such
  as `DENIED` unchanged; the flow programmer may act on them or ignore them.
- An operation that waits for a response may expose a programmer-configurable
  timeout. Use a protocol-defined timeout when MAVLink specifies one. Do not
  invent a hidden timeout, retry, fallback, or recovery policy.
- Once `mavlink-in` emits a `msg`, that message is trusted. No downstream node
  repeats ingress validation.
- One recorded exception: the Connection drops frames from source sysid 0
  before dispatch, because 0 is a destination address a peer table cannot
  learn (DESIGN.md 14.138).

Outbound specifics §0 does not restate:

- Never invent an omitted value. Do not substitute a safe enum member, first
  option, default frame, or other legal value the caller did not choose.
- Type conversion required by Node-RED serialization is plumbing, not
  validation.
- Do not emit advisories about what a vehicle may do with a legal request.
  Keep those facts in `MAVLINK.md`.

## 5. Runtime affirmative selection dispatch

In `lib/**` and `nodes/*.js`, whenever a verb or other closed-vocabulary value selects among
multiple implementation behaviors, dispatch it with a `switch`. This is the only permitted
form of runtime affirmative behavioral dispatch. If this layer merely forwards the value, it
has no dispatcher at all.

- Write one `case` for each implemented behavior.
- End every real dispatcher with `default: break;` — empty, no fallback, no throw.
  That arm is the visible record that unmatched values were considered and select
  nothing. Do not delete it as unused. Do not put policy in it. Write it
  `default: break; // This space intentionally left blank (§5)`.
- Do not validate the verb or test vocabulary membership before dispatch.
- If a switch's only purpose is to prove that a forwarded verb matches a known member, delete
  the switch and pass the value through untouched.
- Blank, absent, and unknown values in an actual dispatcher match no case and select no
  behavior. The empty `default: break` is how a reader sees that on purpose.
- Do not use `if`/`else`, chained equality tests, ternaries, truthiness, inequality checks, an
  executable lookup table, or any other substitute for a `switch` to choose runtime behavior.
- A vocabulary whose members share behaviors is still a switch: stack the case labels that
  share an arm (`case 'send': case 'confirm': case 'collect':`), never fork a boolean on one
  member. A boolean's else-arm is where a stray member rides a path nobody chose — the Build
  node's selection-typo cluster put a frame on the wire the operator asked only to construct.
  Under stacked labels an unmatched member falls to the empty default and selects nothing.
- Do not use `x || 'default'` or a blank check that selects a default member.
- An absent `msg` override may still mean “use the configured operator value.” Either pass the
  resulting value through or dispatch it, according to whether this code actually owns
  multiple behaviors.
- Numeric editor defaults and numeric conversion are not selection dispatch. Do not widen this
  rule into unrelated numeric logic.

Remove validation-only switches and all defaulting, fall-open, validation, and error arms from
real dispatch switches on sight. A real dispatcher contains affirmative `case` arms plus an
empty `default: break`. Anything *in* that default arm is the violation, not the arm itself.

This rule does not apply to data lookup tables, metadata maps, option registries, or display
mappings — including the ones the editor uses to render choices and validate operator input.

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
  chaining, fallback defaults, sanitizers, or duplicate validators. A saved value the
  editor's red ring would have refused — reachable only by hand-edited flow JSON — rides
  to its natural reading: no token skipping and no "safe direction" fallback in the parse
  (owner ruling, 2026-09-01). The red ring is the entire protection.
- Resolve required configuration-node references once and use the result. Do not scatter checks
  for the saved ID.
- For typed inputs, validate the configured expression in the editor. At runtime, evaluate it
  and pass the result on unchanged. Do not guard the resolved value. Dispatch it only when this
  layer owns multiple behaviors; otherwise pass it directly to the core implementation.
- Do not add migrations, compatibility shims, legacy-format handling, deprecation paths, or
  tests for old flow shapes — at any version, ever, not merely pre-1.0. The config surface is
  stable by policy; a changed value is deleted and re-picked, never migrated.

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

## 9. Review findings

Review bots are spell-checkers with a stack trace. They are authoritative on things that are
true regardless of what this project is: a typo, a wrong identifier, a test that does not test
what its name says, a copy-paste error, a real defect on a path that ships. Take those without
ceremony and without discussion.

They have no standing on §0. A bot cannot know that GIGO is the product here, its training says
the opposite, and it will therefore keep proposing that the driver protect the operator. On §0
the agent is the authority and the bot is an input. This is not a close call to be weighed
again on each PR.

### The default is decline

A finding is DECLINED, by default and without further analysis, when its remedy adds or
restores any of these to `lib/**` or `nodes/*.js`:

- a `throw` on a config or `msg` value
- a null, undefined, finiteness, length, or format check on a value the editor owns
- a `default:` arm that does anything
- a membership or vocabulary test
- a fallback, substitution, or coercion
- a token skip or "safe direction" fallback in a parse of editor-owned config (owner
  ruling, 2026-09-01: the red ring is the protection; a degenerate saved string rides)

This holds however good the finding's evidence is. Declining is a finished answer. It does not
need to be re-argued, and a decline recorded in a merged commit message is not reopened by the
same finding on a later PR — findings do not become correct through repetition.

### The shape that is always true and never sufficient

Nearly every finding against this codebase reduces to:

> removing this guard replaced a clear message with a cryptic TypeError

That is correct every single time — it is what removing a guard does — and it is never a reason
on its own. A cryptic crash routed to `failInput` is a supported outcome: §0 rule 3 asks for
loud, not for legible. Message quality is not a defect, and "the operator sees an internal
error" is not a bug report.

Exactly one thing promotes this shape into a real finding: the removal produces **silence or
false success** — a run reported succeeded that did not happen, a member dropped from an
aggregate, an output emitted as valid that was never built. That is the §0 rule 3 violation,
and it is the only guard-shaped change an agent may accept unprompted. Fix it at the point
where the outcome is *reported*, never by re-validating the input.

### A repro is not a ruling

§1 ranks measured behavior over assumption, and that governs the protocol and the wire. It does
not govern this project's design.

A bot demonstrating that `Buffer.from('..z..', 'hex')` silently returns 15 bytes has proved a
mechanism. It has not proved that the driver should check it — that is a §0 question, and §0
already answered it. Do not launder a design disagreement into a measurement. If a mechanism
genuinely changes what §0 should say, that is a conversation with the owner, not a commit.

### Write the procedure down, or do not write the check

Before any new runtime check, the commit message must answer §0's three steps explicitly, by
number, and name the step that permits it.

- Step 1 is available only when the library or wire format **actually refuses**. Silently
  accepting something undesirable is not a refusal, and "surface the refusal the library should
  have made" is not step 1 — it is step 2 wearing a hat.
- If step 2's answer is "the editor could catch this," the check goes in the `.html` or nowhere.
  That Node-RED's `validate` is skipped by Admin-API deploys, flow imports, and restored flow
  files is **not** an exception: it is true of every validator in the walled garden, so
  admitting it once admits a runtime twin for all of them and §0 is finished.

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
