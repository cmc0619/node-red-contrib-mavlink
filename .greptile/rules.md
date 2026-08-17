# Review rules for this repository

Standing context for automated review. These are not style preferences — they are
the rules this codebase is actually held to, and a finding that ignores them costs
more to decline than it would have cost to skip.

**Both review bots read this file.** The path is `.greptile/` only because that is
where Greptile looks; nothing here is Greptile-specific. CodeRabbit is pointed at
the same file by `.coderabbit.yaml`. Edit the rules here — there is one copy on
purpose, so the two reviewers cannot drift apart.

The long-form versions live in `AGENTS.md` — especially §0 (the two-artifact
doctrine, which rule 3 below restates) and §9 (which findings a review bot has
standing to raise at all) — and in `DESIGN.md` §2 (code principles), §6 (UI
rules) and §14 (ground truth). Where this file and those disagree, they win.

---

## 1. Prove reachability before reporting

The question is never "does this branch handle input X." It is "can anything in
this repository produce X."

Before filing a finding of the form *"if a caller passes X, this breaks"*, find
the caller. Grep for the producer. Check `examples/` for a flow that configures
it. If the only path to X is a human hand-typing a value into an editor field
that nothing writes, X is hypothetical and the guard for it is dead code.

Say what you found. *"`lib/foo.js:12` constructs this with `mode: 'raw'`"* is a
finding. *"a caller could pass null"* is not.

Also check whether the behaviour you are flagging is **new**. If the same input
produced the same result before the diff, it is pre-existing behaviour, not a
regression this PR introduced, and it belongs in a separate conversation.

## 2. YAGNI is a hard constraint, not a preference

Do not suggest caching, retries, fallbacks, migrations, compatibility shims,
extra validation, defensive null handling, or new abstraction unless there is a
**demonstrated failure in this deployment**.

Every suggestion should carry three things: the concrete user-visible problem,
why the existing code cannot handle it, and the smallest change that fixes it.
A suggestion missing any of the three will be declined.

Net code length is a budget. A five-line guard is not free because it is small —
it is five lines someone has to read, test, and keep true forever.

## 3. Fail loud; do not repair silently

**Low level drivers don't have pretty error messages.** That is the whole rule.
Everything below is elaboration.

This toolkit builds Node-RED flows. Collect correct data in the editor, deploy
it, and let the runtime fail loudly when inputs or the environment are wrong.

So: do **not** suggest swallowing an error, substituting a default for bad
input, or "gracefully degrading" past a broken deploy. A crash that names the
problem is the correct behaviour, and several are deliberate. Suggesting a
try/catch around one is a downgrade.

**"Fail loudly" means it CRASHES.** Stack traces, brokenness, the whole nine
yards. `TypeError: Cannot read properties of undefined` in the Node-RED log,
with a stack, is not a defect to be dressed up — it is the specified behaviour
and it is what this rule is asking for.

It does **not** mean the driver inspects its input and raises a tidy validation
error. That is the opposite of this rule, and it is the single most common way a
finding gets it backwards. An unresolved value dereferenced as `undefined`, a
NaN the serializer refuses, a null config node hit at `.send()` — those *are*
the loud failure. They are correct as they stand. Nothing about them needs a
nicer message.

Nor is the crash swallowed on the way out: `failInput` passes the real `Error`
to `done(err)`, so Node-RED logs it with its stack and hands it to Catch nodes
intact. The status badge and record carry `err.message` *in addition*, never
instead. "It only surfaces as a cryptic internal error" describes the design.

This is the same rule as `AGENTS.md` §0, stated in shorthand, and §0 is the long
form:

- The **driver** (`lib/**`, `nodes/*.js`) is pymavlink for Node-RED — low level,
  general purpose, no policy. It trusts its input. GIGO is supported behaviour:
  if the wire can carry it, the driver carries it, including commands that fly
  the aircraft into a building. The shibboleth is "what happens if
  `msg.payload.x` is garbage?" and the only correct answer is "it goes on the
  wire."
- The **editor** (`nodes/*.html`) is the application on top, and *all* input
  validation lives there, as deploy-time red rings.

So do **not** suggest any of these in `lib/**` or `nodes/*.js`. They are declined
on sight, and re-proposing one costs more to decline than it would have cost to
skip:

- a `throw` on a config or `msg` value
- a null / undefined / finiteness / length / format check on a value the editor
  owns
- a `default:` arm that does anything, a membership or vocabulary test
- a fallback, substitution, or coercion

Substituting a default deserves its own line, because it is *worse* than the
guard it replaces: it invents a value the caller did not choose (`AGENTS.md` §4),
so the vehicle acts on a number nobody asked for and nothing says why. A guard
that throws at least fails loud. Replacing one with a silent fallback is a
downgrade in both directions.

"Removing this guard replaced a clear message with a cryptic TypeError" is not a
finding. It is a description of the intended result, restated as a complaint —
true every time a guard is removed, because that is what removing a guard does.
The cryptic crash is the win. Do not file it, and do not file "the diagnostic
regressed" or "the operator sees an internal error" either; message quality is
not a defect here.

"A hand-edited flow or an Admin-API deploy skips the editor" is true of *every*
validator in the walled garden, so it argues for a runtime twin of all of them
and is not an exception.

One thing does promote a guard-shaped finding into a real one, and it is the
half of "fail loud" that gets missed: the removal makes a failure **quiet**, or
reports it as success — a run reported succeeded that did not happen, a member
dropped from an aggregate, an output emitted as valid that was never built.
Report those. The fix belongs where the outcome is *reported*, never at the
input.

## 4. Pre-1.0: no migrations, no compatibility shims

There are no released versions to be compatible with. Canonical config keys
only — no readers for leftover or renamed keys, no dual-read paths, no version
detection. A flow saved against an older shape is expected to break loudly and
be re-saved.

## 5. Hidden is not honored (editor nodes)

When the editor hides a form row, the runtime must not read the config value
behind it — it derives the value instead. Do not file findings that assume a
hidden field's stored value is still meaningful; that inversion is the rule,
documented in `DESIGN.md` §6.

Relatedly: the editor does not carry stale typed values across a selection
change. Switching topic or verb clears the field values on purpose. "The user's
input is lost" is intended.

## 6. `DESIGN.md` §14 is settled ground truth

§14 records displaced beliefs and measured facts — each entry names the wrong
belief, the fact that replaced it, and where to check. Read it before filing.

Several §14 entries exist specifically because a reviewer raised the point
before and it was measured and closed. Re-raising one without new measurement
is noise. If you believe a §14 entry is wrong, say which entry and what
measurement contradicts it.

`TODO.md` is the companion file: work that is understood and deliberately
deferred, with the reason. A finding that restates a `TODO.md` entry is already
known.

## 7. The MAVLink spec is the authority on protocol semantics

For anything on the wire — field meanings, addressing, command semantics,
sequencing — cite the source. In descending order of authority:

1. The dialect XML in this repo, and behaviour measured on the wire (§14)
2. The ArduPilot and PX4 source trees — what real vehicles actually fly
3. <https://mavlink.io> and the reference implementations (pymavlink, MAVSDK,
   QGroundControl, MAVProxy)

Reference implementations are trusted starting points, not ground truth; they
disagree with each other often enough that copying one wholesale imports its
bugs. `MAVLINK.md` holds the protocol lessons already confirmed here.

**Addressing, since it recurs.** Per the MAVLink routing rules, `target_system`
and `target_component` omitted or set to `0` mean *broadcast* — intended for all
systems and all components. The forwarding rule that follows from it is the one
that matters for transport code:

> Broadcast messages are forwarded to all channels that haven't seen the
> message. Addressed messages are resent on a new channel *iff* the system has
> previously seen a message from the target on that channel.

So on a shared medium, one write serves a broadcast; on a star — where each
vehicle dials in and owns its own return path, which is what this project's
UDP labs use — "all channels" is every learned peer endpoint.

The configured remote is a legitimate *pre-peer* path and is still used when no
peer has been heard from. What it cannot do is stand in for the fan-out: in the
lab it reached zero vehicles, because `udpclient` vehicles send from ephemeral
source ports and nothing listens on the configured port at all. See
`DESIGN.md` §14.

## 8. Voice

Findings are read by people. Be specific about the failure, name the file and
line, and skip the severity theatre. A finding that cannot describe how it
breaks is a question, and questions are welcome as questions.
