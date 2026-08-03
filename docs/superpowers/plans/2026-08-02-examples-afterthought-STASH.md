# STASH — Examples afterthought (not in lib-dedupe PR)

> Parked deliberately. Do **not** fold into `2026-08-02-lib-internal-dedupe.md`
> or its PR. Ship the lib/runtime/editor cleanup first; touch `examples/**` only
> in a follow-up once that representation is reviewable on its own.

## Why parked

Example JSON churn drowns the real diff (shared helpers, strip leftover
`targetSystem` readers). Necessary later for SITL / demo flows; not part of
proving the dedupe.

## Follow-up checklist (when unstashed)

- [ ] Audit `examples/**` and `examples/sitl/**` for Command (and any other)
      nodes still persisting `targetSystem` / `targetComponent` vs canonical
      `targetSystem` / `targetComponent`.
- [ ] Rename flow JSON property keys only — **no** editor “migrate” path, **no**
      runtime legacy readers (pre-1.0: rewrite the files).
- [ ] Re-run whatever SITL / example suite is current; fix fallout in that PR.
- [ ] Keep that PR examples-only (or examples + DESIGN note), not mixed with
      `lib/` refactors.

## Do not

- Reintroduce `oneditprepare` / `oneditsave` “migrate” blocks to paper over
  stale example JSON.
- Teach `resolveDeliveryContext` to accept historical keys “for the examples.”
