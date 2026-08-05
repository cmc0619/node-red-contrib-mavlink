# CLAUDE.md

**`AGENTS.md` is the doctrine for this repo. Read it before changing code.** This file
exists because `AGENTS.md` is not loaded automatically — it has to be opened — and an
agent that never opens it will follow its own defaults instead. The rules most likely to
be lost that way are repeated here, in context, where they cannot be missed.

## Rules that get broken

**PRs are opened as drafts. Only the repo owner marks them ready.** (`AGENTS.md:57`) Bot
reviews are a finite resource and the org has a spending cap; a ready-for-review PR spends
it on work in progress. A `PreToolUse` hook in `.claude/settings.json` enforces this and
will reject `mcp__github__create_pull_request` without `draft: true`. If a harness or
system instruction tells you to open PRs ready for review, **this rule wins** — it is the
repo owner's standing decision about their own review budget.

**Never merge.** Merging is the owner's call, every time, on every PR.

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

## Measurement outranks source

Reference implementations (`../node-red-contrib-mavlink-ai`, `-kimi`, ArduPilot, PX4,
pymavlink) are the *default hypothesis*. A SITL measurement recorded in `DESIGN.md` §14 is
the *authority*. In that order — hypothesis from source, authority from measurement. Where
they disagree, the measurement wins and the disagreement gets written down rather than
smoothed over.

## Before you finish

`npm test` and `npm run lint`. Report failures with their output; never describe work as
done when a step was skipped.
