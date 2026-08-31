# Driver GIGO Conversion Design

## Goal

Make the Node-RED MAVLink driver smaller and lower level: it carries caller
data to the wire and reports actual operational outcomes. It does not validate,
repair, default, substitute, or politely reject caller input. The editor owns
all deploy-time protection.

## Scope

The conversion audits every production JavaScript file in `lib/` and every
runtime/editor pair in `nodes/`. It is split into independent changes of no
more than 50 touched files each. The editor is changed only when it must own a
static configuration rule currently duplicated by runtime code.

Tests are not a compatibility contract for this work. Do not add tests, repair
tests, or retain a runtime branch because a test expects it. After a code slice
is complete, run the suite once only to locate stale assertions. Delete an
assertion or test file when its purpose is to require a removed runtime guard,
default, coercion, fallback, or refusal. Do not delete tests that demonstrate
an independently meaningful wire, I/O, queue, or outcome-record contract.

## Runtime boundary

The production path classifies each branch by the origin of the value or event:

1. Editor-owned static configuration is used directly. Runtime code does not
   check it for blankness, vocabulary membership, ranges, format, or missing
   configuration-node IDs; it does not default or normalize it.
2. Data supplied on `msg` is forwarded to the existing builder, encoder, or
   transport. The driver neither sanitizes it nor invents a replacement.
3. `mavlink-in` remains the sole wire ingress guard. It discards malformed
   frames and continues parsing; valid frames are forwarded unchanged.
4. Serializer refusal, a full queue, socket/device failure, and protocol
   timeout remain operational outcomes. They are surfaced through the existing
   status/result/error plumbing, not converted into input validation or a
   fallback.

Every actual behavior dispatcher retains the exact form:

```js
default: break; // This space intentionally left blank (§5)
```

The default arm selects no behavior. It does not validate, throw, default, or
otherwise handle unmatched input.

## Simplification rules

- Remove guard-only branches and the messages, comments, fallback values, and
  helper functions that exist solely to support them.
- Inline an identity wrapper and remove duplicate state only after tracing all
  call sites and confirming an existing owner already performs the work.
- Preserve conversions required solely by Node-RED serialization or wire
  layout. They carry a representation; they do not judge a value.
- Keep parsing/transport checks that can be reached only from external bytes,
  remote documents, filesystem data, or actual resource state. Do not extend
  those checks to caller input.
- Keep editor validation exhaustive for static selects, numeric ranges, field
  dependencies, and required configuration. Correct editor persistence rather
  than tolerating a broken editor in the runtime.

## Delivery slices

1. **Outbound construction:** audit codec, addressing, command, move, payload,
   param, vehicle, and their node runtimes. Remove caller-input policy while
   retaining wire representation and outcome records.
2. **Connection and ingress:** audit connection runtime/transports and
   `mavlink-in`. Preserve malformed-wire handling plus real queue, serializer,
   and I/O outcomes; remove configuration and outbound-input guardrails.
3. **Metadata and definitions:** audit metadata and parameter-definition paths.
   Retain failures from external file/network/document input, while removing
   duplicated static-config validation and dead compatibility layers.
4. **Cross-cutting reduction:** trace exports and call sites across all slices,
   remove dead functions, identity wrappers, duplicate state, obsolete comments,
   and tests that only enforce deleted policy.

Each slice reports production-code additions and deletions separately for
`lib/**/*.js`, `nodes/*.js`, and `nodes/*.html`. No test count is reported.

## Verification

Review each diff against this design and AGENTS.md. Run lint only as a static
unused-variable/unreachable-code check. Run tests only after a slice to find
stale guardrail assertions eligible for deletion; failures do not authorize
restoring driver guardrails.
