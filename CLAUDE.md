# CLAUDE.md

**`AGENTS.md` is the doctrine for this repo. Read it before changing code.** This file
exists because `AGENTS.md` is not loaded automatically — it has to be opened — and an
agent that never opens it will follow its own defaults instead. The rules most likely to
be lost that way are repeated here, in context, where they cannot be missed.

## Rules that get broken

**Every report of a diff includes the runtime-logic line count, counted as code, not prose**
(owner standing orders, 2026-08-10 and 2026-08-14): additions/deletions across `lib/**/*.js`
+ `nodes/*.js`, tests and editor `.html` broken out separately, **with comment and blank
lines stripped from both sides before netting** — this codebase carries more comment than
code on new work, so raw `git diff --numstat` roughly doubles every number and buries the
delta the net-code-budget rule (`AGENTS.md`) governs. Numstat may ride alongside, labeled.

**Run the bot gauntlet locally before you push.** (`AGENTS.md:66`, owner standing order,
2026-08-13) Every push to a reviewed branch re-runs six review bots against a metered org cap. The
churn is the cost: self-review the diff with their lenses *first* — regenerated `seed/` artifacts,
union/merge boundaries where new metadata acts, editor hand-edit and out-of-range and stale-widget
paths, wire limits in both spellings — and fix what you find before pushing, not after. `npm test`
and `npm run lint` are the floor, not the gauntlet. Target a first bot round that finds nothing.

**PRs are opened as drafts.** Creating a ready-for-review PR is never allowed
(`AGENTS.md` delivery rules). A hook may deny that. The owner decides when a
specific PR is ready or merged; asking the agent to mark it ready or merge it
**is** that decision — do it. A hook must not deny ready or merge: it cannot
see the ask. Green checks, approval, “finish,” or a previous PR do not imply
permission. The `.claude/settings.json` `PreToolUse` hook and
`.cursor/hooks/pr-gate.js` exist to block **create without draft**, not to
refuse an owner ask.

**`DESIGN.md` and `AGENTS.md` are committed straight to `main`, never through a PR.**
(`AGENTS.md:38`) In their own commit, with the reasoning in the message. A §14 ruling on
`main` is what the review bots read, so landing it immediately stops the next bot
re-raising a settled question.

**PR size cap: 50 files.** (`AGENTS.md:34`) `git diff --name-only <base>...HEAD | wc -l`.

**YAGNI is a hard constraint, not a preference.** Pre-1.0 and unpublished: no migrations,
no compatibility shims, no aliases for renamed things. Delete and re-pick.

**The editor validates; the runtime trusts the saved config.** Runtime code must not
duplicate validation the editor already performed. When a saved value is unreadable
anyway, the parse falls back to the safe direction — it does not fall open and it does not
grow a second deploy-time error path.

**Asked why something was removed or why it behaves that way, read `DESIGN.md` §14 before
answering.** The CHANGELOG says *what* changed and compresses hard; §14 says *why*, and
carries the measurement. They routinely disagree in emphasis — §6 can call a frame
"unmeasured" while §14 holds a SITL run that settles half the question. Three times in one
session (2026-08-13) an answer about the Move redesign was reasoned from the CHANGELOG and
was wrong each time: a deletion called a rig-blocked deferral when the rig predated it by
nine days, and a frame twice mis-assessed while its measurement sat in §14. `grep` §14 for
the thing being asked about first. It is a fast search and it is the authority.

## Measurement outranks source

Reference implementations (`/workspace/node-red-contrib-mavlink-ai`, `-kimi`, ArduPilot, PX4,
pymavlink) are the *default hypothesis*. A SITL measurement recorded in `DESIGN.md` §14 is
the *authority*. In that order — hypothesis from source, authority from measurement. Where
they disagree, the measurement wins and the disagreement gets written down rather than
smoothed over.

## Before you finish

`npm test` and `npm run lint`. Report failures with their output; never describe work as
done when a step was skipped.
