# High-Signal Lint Gate Design

## Goal

Strengthen pull-request linting for `node-red-contrib-mavlink` so CI checks
runtime JavaScript, tests, integration tests, scripts, and the JavaScript
embedded in Node-RED editor HTML files.

## Constraints

- Preserve the package contract of Node.js `>=18.5` and Node-RED `>=4.0.0`.
- Keep runtime compatibility testing on Node.js 18 even when development tools
  require a newer Node.js release.
- Keep lint rules focused on correctness, compatibility, and package integrity.
- Do not add formatting, Prettier, stylistic, SonarJS, or JSDoc enforcement.
- Preserve the codec-specific prohibition on bitwise operators.
- Ordinary CI must remain deterministic and use read-only GitHub permissions.
- SITL remains outside ordinary pull-request CI.

## Approach

Keep ESLint's flat configuration and expand it into explicit environments:

1. CommonJS runtime and tooling files use ESLint's recommended correctness
   rules plus `eslint-plugin-n` and `eslint-plugin-promise`.
2. Node-RED `nodes/**/*.html` files use `eslint-plugin-html` to lint their
   inline browser-side JavaScript with explicit `RED`, jQuery, and browser
   globals.
3. Tests and integration tests receive Node/test globals and are linted without
   applying browser assumptions.
4. Generated artifacts and dependency directories remain ignored.
5. `lib/codec/**/*.js` retains `no-bitwise: error`.

The Node.js plugin must use the package's declared engine range when checking
syntax, built-ins, and dependencies. Test-only imports may use devDependencies;
published runtime code may not rely on undeclared or development-only modules.

Promise rules will catch malformed chains and missing terminal handling where
static JavaScript analysis can do so. They will not attempt type-aware analysis
or replace lifecycle tests for Node-RED's `send` and `done` behavior.

## Node-RED package validation

Add the official `node-red-dev validate` scorecard check as a separate npm
script and CI step. This complements, rather than replaces, the existing
`npm pack --dry-run`, packed-install smoke, and Node-RED 4/5 lifecycle tests.

## CI behavior

The quality matrix continues to run unit tests and package dry-runs on Node.js
18, 20, and 22. Lint and Node-RED package validation run on supported
development-tool rows rather than weakening the package's Node.js 18 runtime
claim.

CI must fail on any lint warning by running ESLint with
`--max-warnings=0`.

## Coverage guard

Add a focused tooling test or equivalent deterministic assertion proving that:

- an invalid `integration/**/*.js` fixture is subject to the configured
  correctness rules; and
- invalid inline JavaScript in a `nodes/**/*.html` fixture is detected.

This prevents future configuration edits from silently dropping either area.

## Verification

Before opening the pull request:

- run the lint coverage guard;
- run the full lint command with zero warnings;
- run the complete unit suite;
- run the Node-RED runtime smoke;
- run `node-red-dev validate`;
- run `npm pack --dry-run`;
- inspect the packed contents; and
- verify the workflow still covers Node.js 18/20/22 and Node-RED 4/5.

The pull request will be opened as a draft and will not be merged.
