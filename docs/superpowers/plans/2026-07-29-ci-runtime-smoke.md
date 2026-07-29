# CI and Node-RED Runtime Smoke Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add automatic quality, packaging, and real Node-RED lifecycle checks to every pull request and push to `main`.

**Architecture:** A single GitHub Actions workflow separates fast cross-version quality checks, tarball installation, and Node-RED runtime compatibility. A focused integration test loads all published node modules through `node-red-node-test-helper`, unloads them, and loads them again.

**Tech Stack:** GitHub Actions, npm, Node.js test runner, Node-RED 4/5, `node-red-node-test-helper`

## Global Constraints

- Preserve the package contract of Node.js `>=18.5` and Node-RED `>=4.0.0`.
- Do not add SITL to ordinary pull-request CI.
- Use read-only GitHub token permissions.
- Do not modify PR #37's runtime/editor files.
- Keep the pull request below the repository's 50-file cap.

---

### Task 1: Real Node-RED lifecycle smoke

**Files:**
- Create: `integration/node-red-smoke.test.js`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: the 13 runtime module paths declared under `package.json#node-red.nodes`
- Produces: `npm run test:runtime`, a process that exits non-zero if registration, deployment, teardown, or redeployment fails

- [ ] **Step 1: Add the smoke test before its dependency wiring**

Create a Node.js test that imports all 13 runtime modules, deploys a
representative configuration plus palette-node flow using the real Node-RED
helper, asserts every node ID resolves, unloads, and repeats the deployment.

- [ ] **Step 2: Run the smoke test to verify the missing harness fails**

Run: `node --test integration/node-red-smoke.test.js`

Expected: non-zero exit because `node-red-node-test-helper` is not installed.

- [ ] **Step 3: Add the runtime-test dependencies and script**

Add `node-red@^4.1.11` and `node-red-node-test-helper@^0.3.6` to
`devDependencies`, add `"test:runtime": "node --test
integration/node-red-smoke.test.js"` to `scripts`, and regenerate the lockfile
with `npm install`.

- [ ] **Step 4: Run the runtime smoke test**

Run: `npm run test:runtime`

Expected: both deploy cycles pass and the process exits zero.

### Task 2: GitHub Actions workflow

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `npm run lint`, `npm test`, `npm run test:runtime`, and npm packing/install commands
- Produces: required-quality evidence for pull requests and pushes to `main`

- [ ] **Step 1: Add the workflow**

Create jobs for:

- Node.js `18.20.8`, `20.19.0`, and `22.13.0`: install, unit tests, and pack
  dry-run; lint the Node.js 20 and 22 rows because ESLint 10 does not support
  Node.js 18.
- Node.js `22.13.0`: create and install the tarball with optional dependencies
  omitted, then deploy that installed artifact through Node-RED.
- Node.js `18.20.8` + Node-RED `4.1.11`, and Node.js `22.13.0` + Node-RED
  `5.0.1`: install the selected runtime without changing the lockfile and run
  `npm run test:runtime`.

Use the action SHAs already pinned by the repository, `contents: read`, and
per-ref concurrency cancellation.

- [ ] **Step 2: Validate workflow structure locally**

Parse `.github/workflows/ci.yml` and confirm the three job IDs, event triggers,
permissions, and matrices are present.

### Task 3: Complete verification and publication

**Files:**
- Verify all files changed by Tasks 1 and 2

**Interfaces:**
- Consumes: the finished branch
- Produces: a ready-for-review pull request that can be merged without PR #37

- [ ] **Step 1: Run complete local verification**

Run:

```bash
npm run lint
npm test
npm run test:runtime
npm pack --dry-run
```

Then install the generated tarball into an empty temporary prefix with
`--omit=optional`.

- [ ] **Step 2: Test both Node-RED runtime versions**

Run the smoke suite once with Node-RED 4.1.11 and once with Node-RED 5.0.1,
using Node.js versions available locally and relying on Actions for the exact
minimum-version matrix.

- [ ] **Step 3: Confirm PR #37 isolation**

Fetch current `main` and PR #37, confirm the changed-file sets do not overlap
except that this branch deliberately avoids `DESIGN.md`, and merge PR #37 into
the CI branch locally to prove the combined tree passes.

- [ ] **Step 4: Commit and publish**

Commit the verified files, push `codex/ci-runtime-smoke`, open a ready-for-review
pull request, wait for CI/review quorum, address Critical/Important findings,
and merge using the repository's accepted method.
