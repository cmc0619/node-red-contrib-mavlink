# Review rules for this repository

Standing context for automated review. These are not style preferences — they are
the rules this codebase is actually held to, and a finding that ignores them costs
more to decline than it would have cost to skip.

The long-form versions live in `AGENTS.md` and `DESIGN.md` §2 (code principles),
§6 (UI rules) and §14 (ground truth). Where this file and those disagree, they win.

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

This toolkit builds Node-RED flows. Collect correct data in the editor, deploy
it, and let the runtime fail loudly when inputs or the environment are wrong.

So: do **not** suggest swallowing an error, substituting a default for bad
input, or "gracefully degrading" past a broken deploy. A crash that names the
problem is the correct behaviour, and several are deliberate. Suggesting a
try/catch around one is a downgrade.

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
UDP labs use — "all channels" is every learned peer endpoint, and a single
datagram to the configured remote reaches nobody. See `DESIGN.md` §14.

## 8. Voice

Findings are read by people. Be specific about the failure, name the file and
line, and skip the severity theatre. A finding that cannot describe how it
breaks is a question, and questions are welcome as questions.
