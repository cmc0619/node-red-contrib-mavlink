'use strict';

/**
 * The lint gate of DESIGN.md §13: high-signal correctness rules only, no
 * formatting, no style churn. Scope is `lib/`, `nodes/`, `test/`, and this
 * config itself. `no-bitwise` applies to the field codec directory only —
 * masks there are built arithmetically (§5).
 *
 * Node globals are declared explicitly rather than imported from the
 * `globals` package: the list is short, it documents exactly what this
 * codebase reaches for outside its own modules, and the gate stays
 * dependency-free. All `readonly` except `module` and `exports`.
 */

const nodeGlobals = {
  require: 'readonly',
  module: 'writable',
  exports: 'writable',
  __dirname: 'readonly',
  __filename: 'readonly',
  Buffer: 'readonly',
  console: 'readonly',
  process: 'readonly',
  URL: 'readonly',
  fetch: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
};

const rules = {
  'no-undef': 'error',
  'no-unused-vars': [
    'error',
    {
      caughtErrors: 'all',
      ignoreRestSiblings: true,
      varsIgnorePattern: '^_',
      argsIgnorePattern: '^_',
    },
  ],
  'no-unreachable': 'error',
};

module.exports = [
  {
    files: ['lib/**/*.js', 'nodes/**/*.js', 'test/**/*.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: nodeGlobals,
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    rules,
  },
  {
    files: ['lib/codec/**/*.js'],
    rules: {
      'no-bitwise': 'error',
    },
  },
];
