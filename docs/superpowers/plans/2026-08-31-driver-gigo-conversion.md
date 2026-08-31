# Driver GIGO Conversion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove runtime policy and dead implementation layers so the MAVLink driver forwards caller data to the existing wire machinery without guards, repairs, or substitutes.

**Architecture:** Work by ownership boundary. Outbound builders lose caller-input policy while preserving their wire representations; connection code retains only wire-ingress and operational outcome handling; metadata keeps only failures caused by external documents and storage. Editor HTML owns static configuration validation.

**Tech Stack:** Node.js, Node-RED, node-mavlink, ESLint.

**Spec:** `docs/superpowers/specs/2026-08-31-driver-gigo-conversion-design.md`

## Global Constraints

- Work only on `codex/driver-gigo-conversion`; push that branch to `origin` as
  progress is committed, but do not open or convert it into a PR.
- Runtime input is trusted: remove defaults, substitutions, membership checks, range/format checks, normalization, and friendly rejection of editor-owned or `msg` values.
- Preserve only malformed-frame handling in `mavlink-in`, plus serializer, queue, device/socket, and protocol outcome reporting.
- Keep every real dispatcher as `default: break; // This space intentionally left blank (§5)`.
- Use paired `.html` files for static configuration rules; runtime does not duplicate them.
- Do not add, repair, or preserve tests. A later test run is used only to identify tests whose sole purpose is a removed guardrail; delete those tests.
- Do not touch a file owned by another task.

---

### Task 1: Outbound builders and command palette nodes

**Files:**
- Modify: `lib/addressing/*.js`, `lib/codec/*.js`, `lib/command/*.js`, `lib/delivery/*.js`, `lib/move/*.js`, `lib/payload/index.js`, `lib/param/index.js`
- Modify: `nodes/mavlink-build.js`, `nodes/mavlink-command.js`, `nodes/mavlink-move.js`, `nodes/mavlink-out.js`, `nodes/mavlink-param.js`, `nodes/mavlink-payload.js`, `nodes/mavlink-mission.js`, `nodes/mavlink-state.js`
- Modify only when a removed runtime static-config rule needs an editor owner: the matching `nodes/mavlink-*.html` files

**Consumes:** validated editor configuration and caller-owned `msg` payloads.

**Produces:** existing MAVLink envelopes, delivery context, status records, and asynchronous result records.

- [ ] Remove only branches that reject, repair, default, coerce, or reinterpret caller-owned configuration or message values.
- [ ] Preserve branch logic that selects an explicitly requested behavior; retain empty default-break dispatcher arms verbatim.
- [ ] Preserve MAVLink wire-layout conversion and outcome records generated after serializer, queue, or protocol events.
- [ ] Remove a helper only when every caller can use its existing owner directly; remove the helper's comments and unreachable support code with it.
- [ ] Run `npx eslint lib/addressing lib/codec lib/command lib/delivery lib/move lib/payload lib/param nodes/mavlink-build.js nodes/mavlink-command.js nodes/mavlink-move.js nodes/mavlink-out.js nodes/mavlink-param.js nodes/mavlink-payload.js nodes/mavlink-mission.js nodes/mavlink-state.js --max-warnings=0` and record its exit status.

### Task 2: Connection, identities, ingress, and topology nodes

**Files:**
- Modify: `lib/connection/*.js`, `lib/connection/transport/*.js`, `lib/identity/*.js`, `lib/vehicle/*.js`, `lib/fanout/index.js`, `lib/formation/index.js`, `lib/state/index.js`
- Modify: `nodes/mavlink-connection.js`, `nodes/mavlink-in.js`, `nodes/mavlink-local-identity.js`, `nodes/mavlink-vehicle.js`, `nodes/mavlink-fanout.js`, `nodes/mavlink-formation.js`, `nodes/mavlink-health.js`
- Modify only when a removed runtime static-config rule needs an editor owner: the matching `nodes/mavlink-*.html` files

**Consumes:** configuration-node objects, outbound envelopes, and inbound transport bytes.

**Produces:** transport writes, decoded ingress messages, peer/state events, and operational status/error records.

- [ ] Remove static-config and outbound-input guardrails, fallback values, duplicate option normalization, and wrapper-only helpers.
- [ ] Leave `mavlink-in` as the sole malformed-frame discard boundary and forward valid frames without downstream revalidation.
- [ ] Keep real serializer, queue-capacity, connection-loss, socket/device, and protocol-timer outcome handling; do not replace it with input validation.
- [ ] Preserve non-policy dispatchers and their exact empty default-break arms.
- [ ] Run `npx eslint lib/connection lib/identity lib/vehicle lib/fanout lib/formation lib/state nodes/mavlink-connection.js nodes/mavlink-in.js nodes/mavlink-local-identity.js nodes/mavlink-vehicle.js nodes/mavlink-fanout.js nodes/mavlink-formation.js nodes/mavlink-health.js --max-warnings=0` and record its exit status.

### Task 3: Metadata, parameter-definition, and static editor cleanup

**Files:**
- Modify: `lib/metadata/*.js`, `lib/param/defs.js`, `lib/param/seed.js`
- Modify only matching editor files needed to carry static validation for `mavlink-param` or `mavlink-vehicle`

**Consumes:** external XML/JSON documents, seed files, remote responses, and editor-created profile configuration.

**Produces:** dialect and parameter catalog data consumed by the existing nodes.

- [ ] Preserve parse, filesystem, network, and malformed external-document failures because those inputs exist outside the editor and wire contract.
- [ ] Remove config-derived defaulting, compatibility shims, redundant value validation, dead catalog adapters, and wrappers with no independent behavior.
- [ ] Keep catalog display/metadata lookup tables; they are data, not runtime behavior dispatch.
- [ ] Run `npx eslint lib/metadata lib/param/defs.js lib/param/seed.js --max-warnings=0` and record its exit status.

### Task 4: Whole-branch dead-code sweep and stale-test deletion

**Files:**
- Modify only production files revealed by Task 1–3 call-site tracing.
- Delete only test files or assertions that fail solely because they require a removed guard, fallback, coercion, or refusal.

**Consumes:** the completed Task 1–3 branch diff and the repository test output.

**Produces:** a smaller production tree with no remaining unused runtime bindings reported by ESLint and no stale guardrail tests.

- [ ] Search every production export and its call sites; inline/remove only exports with no call sites or a single identity-forwarding caller.
- [ ] Run `npm.cmd test` once. For each failure, delete the test assertion only when it requires behavior forbidden by the Global Constraints; do not repair production code or add a replacement test.
- [ ] Run `npx eslint lib nodes --max-warnings=0` and record its exit status.
- [ ] Review `git diff --check` and report separate runtime additions/deletions for `lib/**/*.js`, `nodes/*.js`, and `nodes/*.html`.
