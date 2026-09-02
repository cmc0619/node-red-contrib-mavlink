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
  // The SITL measurement scripts and the repo hooks are Node programs too;
  // unlisted, they were linted with no rules at all (found 2026-09-02).
  'sitl/**/*.js',
  '.cursor/**/*.js',
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

// The codebase was written in 2026 and reads that way (owner ruling,
// 2026-09-02): block scoping, arrow callbacks, shorthand, template strings,
// strict equality. One gate — this file — says so, so a second linter's
// opinion on the same points is noise, and there is nothing for a reviewer to
// argue about that `eslint --fix` cannot settle. `eqeqeq` ignores `== null`:
// that idiom is the deliberate "null or undefined" test, not a slip.
const styleRules = {
  'no-var': 'error',
  'prefer-const': 'error',
  'prefer-arrow-callback': 'error',
  'arrow-body-style': ['error', 'as-needed'],
  'object-shorthand': 'error',
  'prefer-template': 'error',
  'prefer-rest-params': 'error',
  'prefer-spread': 'error',
  'no-else-return': 'error',
  'dot-notation': 'error',
  eqeqeq: ['error', 'always', { null: 'ignore' }],
};

const correctnessRules = {
  ...js.configs.recommended.rules,
  ...promiseRules,
  ...styleRules,
  // NUL stripping is intentional in MAVLink's fixed-width string fields.
  'no-control-regex': 'off',
  'no-empty': ['error', { allowEmptyCatch: true }],
  'no-unused-vars': unusedVariables,
  // AGENTS.md §5 affirmative dispatch, made mechanical (owner ruling,
  // 2026-08-16). The rule bans a default arm that *does* something; an empty
  // one is inert and states that the author did not forget the case, so both
  // of these are now required rather than merely tolerated:
  //
  //   default: break;   // This space intentionally left blank (§5)
  //   return undefined; // nothing matched: no behavior selected (§5)
  //
  // Enforced here rather than left to DeepSource so the gate that has to pass
  // is the repo's own. `consistent-return` is the load-bearing half: it is
  // what stops a resolver quietly growing an implicit undefined tail beside
  // explicit returns, and it forces the author to say which unresolved value
  // the wire gets — NaN on a float field, undefined on an object.
  'default-case': 'error',
  'consistent-return': 'error',
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
  {
    // AGENTS.md §0 / §9, made mechanical (owner ruling, 2026-08-17).
    //
    // §9 requires the §0 decision procedure written down before any new
    // runtime check. Left as prose that is a promise, and a persuasive commit
    // message can launder a guardrail past it — which is exactly how three
    // came back in one session. A missing disable directive cannot be
    // persuaded, and a present one sits in the diff next to the code with its
    // §0 rule number, where a reviewer sees it.
    //
    // Constructing a refusal is what is banned. `throw err` re-raises
    // something already caught and is plumbing, so it stays legal.
    //
    // Scope is the message path — where §0 bites. lib/metadata, param
    // defs/seed and the test helpers are catalog and harness code, and
    // lib/connection + lib/codec are the wire boundary, where a refusal is
    // rule 1 by construction and the annotation would say nothing.
    files: [
      'lib/addressing/**/*.js',
      'lib/command/**/*.js',
      'lib/delivery/**/*.js',
      'lib/fanout/**/*.js',
      'lib/formation/**/*.js',
      'lib/identity/**/*.js',
      'lib/mission/**/*.js',
      'lib/move/**/*.js',
      'lib/payload/**/*.js',
      'lib/vehicle/**/*.js',
      'lib/param/index.js',
      'nodes/**/*.js',
    ],
    ignores: ['lib/**/test/**'],
    rules: {
      'no-restricted-syntax': ['error', {
        selector: "ThrowStatement > NewExpression[callee.name='Error']",
        message: 'AGENTS.md §0: the driver does not refuse its input. Keep this only if it '
          + 'is a real wire/library refusal (rule 1) or an operational failure that cannot '
          + 'exist until runtime (rule 3), and say which with an eslint-disable naming the '
          + 'rule. Otherwise the check belongs in the .html (rule 2), or nowhere.',
      }],
    },
  },
];
