import js from '@eslint/js';
import html from 'eslint-plugin-html';
import nodePlugin from 'eslint-plugin-n';
import promise from 'eslint-plugin-promise';
import globals from 'globals';

const nodeFiles = [
  'lib/**/*.js',
  'nodes/**/*.js',
  'scripts/**/*.js',
  'test/**/*.js',
  'integration/**/*.js',
];

const unusedVariables = [
  'error',
  {
    caughtErrors: 'all',
    caughtErrorsIgnorePattern: '^_',
    ignoreRestSiblings: true,
    varsIgnorePattern: '^_',
    argsIgnorePattern: '^_',
  },
];

const promiseRules = {
  'promise/no-new-statics': 'error',
  'promise/no-return-in-finally': 'error',
  'promise/no-return-wrap': 'error',
  'promise/valid-params': 'error',
};

const correctnessRules = {
  ...js.configs.recommended.rules,
  ...promiseRules,
  // NUL stripping is intentional in MAVLink's fixed-width string fields.
  'no-control-regex': 'off',
  'no-empty': ['error', { allowEmptyCatch: true }],
  'no-unused-vars': unusedVariables,
};

const nodeRules = {
  'n/no-deprecated-api': 'error',
  'n/no-extraneous-require': 'error',
  'n/no-missing-require': [
    'error',
    {
      // `sockopt` is optional and may be absent on unsupported platforms;
      // `mavlink-mappings` is provided by node-mavlink and resolved at runtime.
      allowModules: ['sockopt', 'mavlink-mappings'],
    },
  ],
  'n/no-unsupported-features/es-builtins': 'error',
  'n/no-unsupported-features/es-syntax': 'error',
  'n/no-unsupported-features/node-builtins': [
    'error',
    {
      // node:test is stable on the Node >=20 floor (since 20.0.0), so it needs
      // no exemption. `fetch` is a different case: it stays marked experimental
      // until Node 21, and lib/metadata/xml-catalog.js and lib/param/defs.js
      // both use it — this flag is what keeps them passing. Only genuinely
      // newer modules (node:sqlite and friends) should fail this rule.
      allowExperimental: true,
    },
  ],
};

export default [
  {
    ignores: [
      'node_modules/**',
      'coverage/**',
      '.nyc_output/**',
      '*.tgz',
    ],
  },
  {
    files: nodeFiles,
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
        ...globals.nodeBuiltin,
      },
    },
    plugins: {
      n: nodePlugin,
      promise,
    },
    settings: {
      node: {
        version: '>=20',
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      ...correctnessRules,
      ...nodeRules,
    },
  },
  {
    files: ['integration/**/*.js'],
    rules: {
      'n/no-unsupported-features/node-builtins': [
        'error',
        {
          allowExperimental: true,
        },
      ],
    },
  },
  {
    files: ['nodes/**/*.html'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        RED: 'readonly',
        $: 'readonly',
        jQuery: 'readonly',
      },
    },
    plugins: {
      html,
      promise,
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    rules: correctnessRules,
  },
  {
    // Shared editor helpers run in the browser like the node HTML scripts.
    files: ['resources/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        RED: 'readonly',
        $: 'readonly',
        jQuery: 'readonly',
      },
    },
    plugins: {
      promise,
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    rules: correctnessRules,
  },
  {
    files: ['eslint.config.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.nodeBuiltin,
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': unusedVariables,
    },
  },
  {
    files: ['lib/codec/**/*.js'],
    rules: {
      'no-bitwise': 'error',
    },
  },
];
