#!/usr/bin/env node
'use strict';

/**
 * Logic-only diff counts, for the `AGENTS.md` §2 diff report.
 *
 *   npm run count            # against origin/main
 *   npm run count -- <base>  # against any ref
 *
 * "Logic" means what is left after removing `//` lines, `/* *\/` blocks,
 * `/** jsdoc *\/` blocks, and blank lines. This codebase carries more comment
 * than code on new work, so a raw `git diff --numstat` roughly doubles every
 * number and buries the delta the net-code-budget rule governs. The editor's
 * own diff view has the same problem — it counts everything.
 *
 * Counted two ways on purpose, because they cross-check each other:
 *
 *   - total logic lines in each file, before and after. A direct count; it
 *     cannot be inflated by a bad differ.
 *   - a unified diff of the stripped files, giving additions and deletions.
 *
 * If the two nets disagree, the stripper is wrong — do not report either
 * number until they agree. An agent reported runtime −65 for the change that
 * added this script; the real figure was −13, because deleted comment blocks
 * were being scored as logic. Both methods now say −13.
 */

const { execFileSync } = require('node:child_process');

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28 });

/**
 * @param {string} text
 * @returns {string[]} the lines that are logic
 */
function logicLines(text) {
  const out = [];
  let inBlock = false;
  for (const raw of text.split('\n')) {
    let s = raw.trim();
    if (inBlock) {
      const end = s.indexOf('*/');
      if (end === -1) continue;
      inBlock = false;
      s = s.slice(end + 2).trim();
    }
    while (s.startsWith('/*')) {
      const end = s.indexOf('*/', 2);
      if (end === -1) { inBlock = true; s = ''; break; }
      s = s.slice(end + 2).trim();
    }
    // A jsdoc continuation line that reached here has no opener to match.
    if (inBlock || !s || s.startsWith('//') || s.startsWith('*')) continue;
    out.push(s);
  }
  return out;
}

/** Longest-common-subsequence add/delete counts between two line arrays. */
function addDel(before, after) {
  const n = before.length;
  const m = after.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i][j] = before[i] === after[j]
        ? lcs[i + 1][j + 1] + 1
        : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const common = lcs[0][0];
  return { add: m - common, del: n - common };
}

function groupOf(file) {
  if (file.startsWith('test/') || file.includes('/test/')) return 'tests';
  if (file.startsWith('resources/')) return 'editor';
  if (file.endsWith('.html')) return 'editor';
  if (file === 'eslint.config.mjs' || file.startsWith('scripts/')) return 'tooling';
  return 'runtime';
}

function fileAt(rev, path) {
  try {
    return git('show', `${rev}:${path}`);
  } catch {
    return '';
  }
}

const base = process.argv[2] || 'origin/main';
const head = process.argv[3] || 'HEAD';

const files = git('diff', '--name-only', `${base}...${head}`)
  .split('\n')
  .filter((f) => f && (f.endsWith('.js') || f.endsWith('.mjs') || f.endsWith('.html')));

const groups = new Map();
for (const file of files) {
  const before = logicLines(fileAt(base, file));
  const after = logicLines(fileAt(head, file));
  const { add, del } = addDel(before, after);
  const key = groupOf(file);
  const g = groups.get(key) || { before: 0, after: 0, add: 0, del: 0, files: [] };
  g.before += before.length;
  g.after += after.length;
  g.add += add;
  g.del += del;
  g.files.push({ file, before: before.length, after: after.length });
  groups.set(key, g);
}

const sign = (n) => (n > 0 ? `+${n}` : String(n));

console.log(`${base}...${head}   LOGIC LINES ONLY — no //, no /* */, no /** jsdoc */, no blanks`);
console.log();
console.log('group     before   after       net    +add   -del   net(diff)  agree');
console.log('-'.repeat(70));

let ok = true;
for (const key of ['runtime', 'editor', 'tests', 'tooling']) {
  const g = groups.get(key);
  if (!g) continue;
  const netTotal = g.after - g.before;
  const netDiff = g.add - g.del;
  const agree = netTotal === netDiff;
  if (!agree) ok = false;
  console.log(
    `${key.padEnd(9)} ${String(g.before).padStart(6)} ${String(g.after).padStart(7)} `
    + `${sign(netTotal).padStart(9)} ${String(g.add).padStart(7)} ${String(g.del).padStart(6)} `
    + `${sign(netDiff).padStart(11)}   ${agree ? 'yes' : 'NO'}`
  );
}
console.log('-'.repeat(70));

const runtime = groups.get('runtime');
if (runtime) {
  console.log();
  console.log('runtime, per file (before -> after):');
  for (const f of runtime.files.sort((a, b) => (a.after - a.before) - (b.after - b.before))) {
    console.log(`  ${String(f.before).padStart(5)} -> ${String(f.after).padStart(5)}  `
      + `${sign(f.after - f.before).padStart(6)}   ${f.file}`);
  }
}

if (!ok) {
  console.log();
  console.log('The two methods disagree — the stripper is wrong. Do not report either number.');
  process.exitCode = 1;
}
