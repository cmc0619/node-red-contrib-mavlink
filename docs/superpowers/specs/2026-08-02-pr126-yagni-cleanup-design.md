# PR126 YAGNI Cleanup Design

## Goal

Build draft PR126 as a conservative cleanup of the post-PR123 tree: remove
unreachable recovery, UI latency machinery, dead code, and duplicated defaults
without changing supported MAVLink behavior or the nodes' two-output contract.

## Baseline and merge

PR126 starts directly from merged PR123. None of PR125's conflicting
implementation is carried forward; approved cleanup is reimplemented against
current `main`.

The Command coordinate-metadata state is currently poisoned when dialect
resolution throws: the resolved flag is set before the lookup succeeds. The
flag moves after successful resolution, with a regression test covering two
consecutive inputs after a failed lookup.

## Node-RED lifecycle and failure contracts

Direct Connection configuration-node references are resolved once when a node
is deployed. Per-message `RED.nodes.getNode(config.connection)` recovery is
removed because Node-RED recreates direct consumers when configuration nodes
change.

The existing output contract remains intact: terminal failures still produce
the documented status record on output 1 and call `done(err)`. PR125's changes
that suppressed output 1 for a missing Connection are not carried forward. Operational
timeouts, protocol results, queue bounds, transport teardown, signing, replay,
and dynamic message validation are unchanged.

## Editor catalogs

MAVLink message, command, and enum catalogs are generated from XML already
installed on the Raspberry Pi. The shared browser loader performs a fresh
admin request when the dialog needs data. Per-key result caches, in-flight
waiter queues, and duplicate-request coalescing are removed. A single request
sequence remains so an older response cannot repaint a newer selection.

Command preset caching in the editor is removed for the same reason. This is a
human-facing local request, not a runtime hot path.

## Parameter definitions

Parameter definitions are separate from MAVLink dialect XML. They are optional
editor enrichment: Param read, set, and list continue to work without them, so
the package does not need a parameter-definition seed.

The Vehicle Profile's `paramDefsUrl` is an optional update source. An empty URL
stays empty; the runtime does not invent an ArduPilot URL.

The parameter-definition workflow mirrors the XML catalog at its useful
boundary:

- ordinary editor GET requests read only the local holding file;
- an explicit authenticated Update action downloads the configured URL;
- downloaded JSON is parsed and validated before replacing the holding file;
- a failed update leaves the previous local file intact;
- corrupt local JSON fails loudly and never triggers a network fallback;
- the in-process definition cache and cache-reset test API are deleted; and
- definitions are parsed from the local file on demand.

The XML catalog class itself is not reused. Its include traversal, Git commit
pinning, multi-file snapshots, dialect compilation, and seed comparison do not
apply to a single parameter JSON document. The parameter implementation reuses
the route/auth/storage conventions and the smallest existing atomic-write
primitive, if one is already suitable.

The local holding file is tied to the Vehicle Profile rather than derived from
the URL, so changing or clearing the update source does not make a successfully
downloaded local copy unreachable.

## Dead-code and packaging cleanup

The pass deletes only statically proven dead or redundant surfaces:

- unused `lib/metadata/dts.js` recovery;
- unused metadata naming helpers;
- unused payload helper functions and public exports;
- identity wrappers with one pass-through call;
- an unused command test stub class;
- duplicated runtime defaults already guaranteed by editor definitions; and
- test-only files currently included in the npm package.

No speculative catch/fallback rewrite is included. Broader action-node exception
classification requires its own behavior contract and PR.

## Validation

Tests cover the failed-dialect second-input regression, local-only parameter
reads, explicit updates, preservation after a failed update, corrupt-local-file
failure, empty update URLs, editor request sequencing without caching, package
contents, and preserved output-1 failure behavior.

Required verification is lint, all non-SITL tests, Node-RED runtime smoke,
Node-RED package validation, package dry-run inspection, diff checks, and a
fresh defect-first review. Windows cannot execute the Bash-dependent SITL shell
tests; the existing GitHub Linux matrix remains the authority for those tests.

The PR remains draft after push, as requested, and must stay below the
repository's 50-file cap.
