'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { ESLint } = require('eslint');

const projectRoot = path.resolve(__dirname, '..', '..');

const probes = [
  {
    filePath: 'integration/lint-coverage-probe.js',
    source: 'module.exports = lintCoverageMissingGlobal;\n',
  },
  {
    filePath: 'nodes/lint-coverage-probe.html',
    source: [
      '<script type="text/javascript">',
      'RED.nodes.registerType("lint-coverage-probe", {',
      '  category: lintCoverageMissingGlobal',
      '});',
      '</script>',
    ].join('\n'),
  },
];

for (const probe of probes) {
  test(`lint covers ${probe.filePath}`, async () => {
    const eslint = new ESLint({ cwd: projectRoot });
    const [result] = await eslint.lintText(probe.source, {
      filePath: path.join(projectRoot, probe.filePath),
    });

    assert.ok(
      result.messages.some((message) => message.ruleId === 'no-undef'),
      `expected no-undef for ${probe.filePath}, got ${JSON.stringify(result.messages)}`,
    );
  });
}
