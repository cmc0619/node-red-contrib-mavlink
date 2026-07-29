# CI and Node-RED Runtime Smoke Design

## Goal

Add ordinary pull-request CI that proves the package passes its existing quality
checks, can be packed and installed, and can load and redeploy its nodes in the
supported Node-RED runtimes.

## Scope

- Run on pull requests, pushes to `main`, and manual dispatch.
- Run the complete unit suite and package validation on Node.js 18, 20, and 22.
  Run lint on Node.js 20 and 22 because ESLint 10 requires Node.js 20.19 or
  newer; Node.js 18 tests the package runtime contract, not the development
  tool's unsupported engine.
- Pack the publishable tarball and install it without optional native
  dependencies.
- Load all 13 registered node modules through the real Node-RED test runtime,
  deploy a representative flow, unload it, and deploy it again.
- Exercise Node-RED 4 on the minimum Node.js line and Node-RED 5 on its minimum
  Node.js line.
- Give the workflow read-only repository permissions and cancel superseded runs
  for the same pull request or ref.

## Deliberate exclusions

- SITL is not part of ordinary CI. It requires a separate, manually triggered
  integration workflow when the simulator contract is ready.
- The workflow does not change node behavior.
- The change does not touch `nodes/mavlink-local-identity.html` or
  `test/nodes/local-identity-html.test.js`, so it does not interfere with PR
  #37. Documentation lives under `docs/superpowers/` rather than `DESIGN.md`
  to avoid its only shared file.

## Design

One `.github/workflows/ci.yml` workflow has three jobs:

1. `quality` uses a Node.js 18/20/22 matrix and runs `npm ci`, unit tests, and
   `npm pack --dry-run`, with lint enabled on the two ESLint-compatible rows.
2. `package-install` creates the actual npm tarball and installs it into an
   empty prefix with optional dependencies omitted.
3. `node-red-runtime` uses an explicit compatibility matrix for Node-RED 4 and
   5, then runs the runtime smoke test.

The smoke test uses `node-red-node-test-helper`, loads the package's actual
runtime modules, asserts each configured node exists, unloads the flow, and
loads it a second time. A timeout around unload makes a stuck `close` handler a
visible CI failure instead of a hung job.
