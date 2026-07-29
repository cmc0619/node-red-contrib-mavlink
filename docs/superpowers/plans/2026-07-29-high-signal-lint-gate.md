# High-Signal Lint Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ordinary CI enforce high-signal JavaScript, Node.js, Promise, inline Node-RED editor, and Node-RED package checks.

**Architecture:** Replace the current small CommonJS flat config with an ESM flat config containing separate Node/CommonJS, editor/browser, and codec scopes. A real ESLint API coverage check proves that integration JavaScript and inline HTML JavaScript remain linted, while the existing CI matrix continues to separate development-tool support from Node.js 18 runtime compatibility.

**Tech Stack:** ESLint 10, @eslint/js 10, eslint-plugin-n 18, eslint-plugin-promise 7, eslint-plugin-html 8, globals 17, node:test, node-red-dev 0.1.

## Global Constraints

- Preserve the package contract of Node.js `>=18.5` and Node-RED `>=4.0.0`.
- Keep runtime compatibility testing on Node.js 18 even when development tools require a newer Node.js release.
- Keep lint rules focused on correctness, compatibility, and package integrity.
- Do not add formatting, Prettier, stylistic, SonarJS, or JSDoc enforcement.
- Preserve the codec-specific prohibition on bitwise operators.
- Ordinary CI must remain deterministic and use read-only GitHub permissions.
- SITL remains outside ordinary pull-request CI.
- Open a draft pull request and do not merge it.

---

### Task 1: Prove missing lint coverage

**Files:**
- Create: `test/tooling/lint-coverage.check.js`
- Modify: `package.json`

**Interfaces:**
- Consumes: ESLint's public `ESLint#lintText(code, { filePath })` API and the repository flat config.
- Produces: `npm run test:lint-config`, which exits non-zero if integration JavaScript or inline node HTML JavaScript is not checked by `no-undef`.

- [ ] **Step 1: Add the coverage check**

Create `test/tooling/lint-coverage.check.js`:

```js
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { ESLint } = require('eslint');

async function lintText(code, filePath) {
  const eslint = new ESLint();
  const [result] = await eslint.lintText(code, { filePath });
  return result;
}

function assertRuleReported(result, ruleId) {
  assert.equal(result.ignored, false);
  assert.ok(
    result.messages.some((message) => message.ruleId === ruleId),
    `expected ${ruleId}; received ${JSON.stringify(result.messages)}`
  );
}

test('integration JavaScript receives correctness rules', async () => {
  const result = await lintText(
    'missingIntegrationGlobal();\n',
    'integration/lint-coverage-probe.js'
  );
  assertRuleReported(result, 'no-undef');
});

test('Node-RED HTML inline JavaScript receives correctness rules', async () => {
  const result = await lintText(
    '<script type="text/javascript">missingEditorGlobal();</script>\n',
    'nodes/lint-coverage-probe.html'
  );
  assertRuleReported(result, 'no-undef');
});
```

Add this package script without adding the check to the Node.js 18 unit-test glob:

```json
"test:lint-config": "node --test test/tooling/lint-coverage.check.js"
```

- [ ] **Step 2: Run the check against the old config**

Run: `npm run test:lint-config`

Expected: FAIL because `integration/**/*.js` and `nodes/**/*.html` do not match the old flat configuration.

- [ ] **Step 3: Commit the red coverage check**

Commit only `test/tooling/lint-coverage.check.js` and the new package script with message:

```text
test: expose lint coverage gaps
```

### Task 2: Expand the ESLint gate

**Files:**
- Delete: `eslint.config.js`
- Create: `eslint.config.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify only files with genuine new lint errors discovered by the completed configuration.

**Interfaces:**
- Consumes: the package's `engines.node` value of `>=18.5`.
- Produces: `npm run lint`, covering `lib/**/*.js`, `nodes/**/*.js`, `scripts/**/*.js`, `test/**/*.js`, `integration/**/*.js`, `eslint.config.mjs`, and inline JavaScript in `nodes/**/*.html`.

- [ ] **Step 1: Install pinned-major lint dependencies**

Run:

```bash
npm install --save-dev \
  @eslint/js@^10.0.1 \
  eslint-plugin-n@^18.2.2 \
  eslint-plugin-promise@^7.3.0 \
  eslint-plugin-html@^8.1.4 \
  globals@^17.8.0
```

- [ ] **Step 2: Replace the flat config**

Create an ESM `eslint.config.mjs` that:

- imports `@eslint/js`, `eslint-plugin-n`, `eslint-plugin-promise`,
  `eslint-plugin-html`, and `globals`;
- ignores `node_modules/**`, generated coverage, and packed artifacts;
- applies `@eslint/js` recommended rules and Promise recommended rules to
  repository JavaScript;
- applies `n/no-deprecated-api`,
  `n/no-extraneous-require`, `n/no-missing-require`,
  `n/no-unsupported-features/es-builtins`,
  `n/no-unsupported-features/es-syntax`, and
  `n/no-unsupported-features/node-builtins` to published runtime files;
- uses `settings.node.version = ">=18.5"`;
- preserves the existing underscore-aware `no-unused-vars` configuration;
- declares Node globals for CommonJS files;
- declares browser globals plus readonly `RED`, `$`, and `jQuery` for
  `nodes/**/*.html`;
- registers `eslint-plugin-html` for HTML files;
- retains `no-bitwise: error` for `lib/codec/**/*.js`; and
- reports unused disable directives as errors.

Update the lint script to:

```json
"lint": "npm run test:lint-config && eslint . --max-warnings=0"
```

- [ ] **Step 3: Run the coverage check**

Run: `npm run test:lint-config`

Expected: PASS, two tests and zero failures.

- [ ] **Step 4: Run the expanded lint gate**

Run: `npm run lint`

Expected: FAIL only for genuine issues exposed in existing files. Fix those issues minimally or disable a rule only with a documented repository-specific reason when the rule is structurally incompatible with valid Node-RED code.

- [ ] **Step 5: Re-run the lint gate**

Run: `npm run lint`

Expected: PASS with zero warnings and zero errors.

- [ ] **Step 6: Commit the lint gate**

Commit the config, dependency lock changes, and any narrow correctness fixes with message:

```text
ci: strengthen lint coverage
```

### Task 3: Add Node-RED package validation to CI

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: the local npm package metadata and publishable file list.
- Produces: `npm run validate:node-red` and a Node.js 22 CI step that fails when the official Node-RED scorecard validator rejects the package.

- [ ] **Step 1: Install the validator and add its script**

Run:

```bash
npm install --save-dev node-red-dev@^0.1.6
```

Add:

```json
"validate:node-red": "node-red-dev validate"
```

- [ ] **Step 2: Run validator before CI wiring**

Run: `npm run validate:node-red`

Expected: PASS. If it reports package defects, fix only defects directly required for a valid Node-RED package and rerun.

- [ ] **Step 3: Add the CI validation step**

In the `quality` job after package contents, add:

```yaml
      - name: Node-RED package validation
        if: matrix.node_version == '22.13.0'
        run: npm run validate:node-red
```

- [ ] **Step 4: Parse the workflow**

Run a YAML parser against `.github/workflows/ci.yml` and assert the quality,
package-install, and node-red-runtime jobs remain present.

Expected: PASS.

- [ ] **Step 5: Commit package validation**

Commit `package.json`, `package-lock.json`, and `.github/workflows/ci.yml`
with message:

```text
ci: validate Node-RED package metadata
```

### Task 4: Full verification and publication

**Files:**
- Verify every file changed since `main`.
- Do not modify unrelated source.

**Interfaces:**
- Consumes: the completed branch.
- Produces: a verified draft pull request targeting `main`.

- [ ] **Step 1: Run fresh full verification**

Run:

```bash
npm run lint
npm test
npm run test:runtime
npm run validate:node-red
npm pack --dry-run
```

Expected: every command exits zero; lint has zero warnings; the unit and runtime
suites report zero failures.

- [ ] **Step 2: Verify the diff and package contents**

Run:

```bash
git status -sb
git diff --check main...HEAD
git diff --stat main...HEAD
npm pack --json --dry-run
```

Expected: no whitespace errors, only intended lint/CI/spec/plan files and narrow
lint fixes, and no development-only tooling included in the package tarball.

- [ ] **Step 3: Request review**

Review the completed diff against the approved design. Fix Critical and
Important findings, then rerun Step 1.

- [ ] **Step 4: Push and open the pull request**

Push `agent/strengthen-lint-gate` and open a draft PR targeting `main` titled:

```text
ci: strengthen Node-RED lint gate
```

The PR body must summarize the expanded scopes, Node/Promise/HTML checks,
Node-RED scorecard validation, any source fixes, and all verification commands.

- [ ] **Step 5: Stop without merging**

Report the PR URL and current checks. Do not enable auto-merge and do not merge.
