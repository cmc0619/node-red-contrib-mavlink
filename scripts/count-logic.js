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
 * Runtime is `lib/**` and `nodes/*.js` (AGENTS.md §2); editor is `nodes/*.html`
 * and `resources/`; everything else that is not a test is tooling. A rename
 * counts as a delete plus an add, which nets to the lines that changed.
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
  if (file.startsWith('test/')) return 'tests';
  if (file.startsWith('resources/') || /^nodes\/[^/]+\.html$/.test(file)) return 'editor';
  if ((file.startsWith('lib/') && file.endsWith('.js')) || /^nodes\/[^/]+\.js$/.test(file)) return 'runtime';
  return 'tooling';
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

const files = git('diff', '--name-only', '--no-renames', `${base}...${head}`)
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
console.log('group     before   after       net    +add   -del');
console.log('-'.repeat(50));

for (const key of ['runtime', 'editor', 'tests', 'tooling']) {
  const g = groups.get(key);
  if (!g) continue;
  console.log(
    `${key.padEnd(9)} ${String(g.before).padStart(6)} ${String(g.after).padStart(7)} `
    + `${sign(g.after - g.before).padStart(9)} ${String(g.add).padStart(7)} ${String(g.del).padStart(6)}`
  );
}
console.log('-'.repeat(50));

const runtime = groups.get('runtime');
if (runtime) {
  console.log();
  console.log('runtime, per file (before -> after):');
  for (const f of runtime.files.sort((a, b) => (a.after - a.before) - (b.after - b.before))) {
    console.log(`  ${String(f.before).padStart(5)} -> ${String(f.after).padStart(5)}  `
      + `${sign(f.after - f.before).padStart(6)}   ${f.file}`);
  }
}
