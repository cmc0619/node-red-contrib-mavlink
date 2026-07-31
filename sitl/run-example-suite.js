'use strict';

/**
 * Deploy each examples/sitl/*.json into the lab Node-RED (host :1880), fire
 * injects, scrape debug/error lines, and write a JSON report for testing.md.
 *
 * Usage: node sitl/run-example-suite.js [--only 01,17] [--out /tmp/sitl-results.json]
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SITL_DIR = path.join(ROOT, 'examples', 'sitl');
const NR_HOST = process.env.NR_HOST || '127.0.0.1';
const NR_PORT = Number(process.env.NR_PORT || 1880);

const ONLY = (() => {
  const i = process.argv.indexOf('--only');
  if (i < 0) return null;
  return new Set(
    process.argv[i + 1]
      .split(',')
      .map((s) => s.trim().replace(/\.json$/, ''))
  );
})();

const OUT =
  process.argv.includes('--out')
    ? process.argv[process.argv.indexOf('--out') + 1]
    : path.join(ROOT, 'sitl', 'example-suite-results.json');

/** @type {Record<string, {waitMs: number, expect: string, notes?: string, prep?: string, afterInject?: Function}>} */
const PROFILE = {
  '01-completion-takeoff': {
    waitMs: 45000,
    expect: 'takeoff complete / altitude reached',
    prep: 'ap-guided-1',
  },
  '02-completion-timeout': {
    waitMs: 20000,
    expect: 'completion timeout (status names timeout; intentional)',
  },
  '03-temporarily-rejected': {
    waitMs: 25000,
    expect: 'arm eventually accepted (TEMPORARILY_REJECTED only on fresh boot)',
    notes: 'once:true inject fires at deploy; GPS already locked → may skip reject',
  },
  '04-mode-tables': {
    waitMs: 15000,
    expect: 'AP GUIDED + PX4 mode set accepted',
  },
  '05-px4-param-union': {
    waitMs: 15000,
    expect: 'param set+read echo confirmed',
  },
  '06-mission-fence-rally': {
    waitMs: 40000,
    expect: 'AP mission/fence/rally ok; PX4 fence fails loud',
  },
  '07-mission-failloud': {
    waitMs: 45000,
    expect: 'good upload ok; bad upload fails; good plan survives',
  },
  '08-swarm-sequential-five': {
    waitMs: 25000,
    expect: 'dry-run then live sequential arm ×5',
  },
  '09-swarm-member-expires': {
    waitMs: 20000,
    expect: 'aggregate reports one failed after mid-run kill',
    prep: 'kill-ap-3-mid',
  },
  '10-dual-stack-ten': {
    waitMs: 25000,
    expect: 'broadcast arm AP 1–5 and PX4 11–15',
  },
  '11-broadcast-vs-sequential': {
    waitMs: 30000,
    expect: 'sequential + broadcast arm confirmed',
  },
  '12-signing': {
    waitMs: 15000,
    expect: 'signed arm attempt (setup-dependent; may warn/fail without matching SITL key)',
    notes: 'dry-run template; lab SITL typically does not verify signatures',
  },
  '13-param-defs-live': {
    waitMs: 45000,
    expect: 'read / set / list param defs against AP',
  },
  '14-command-mission-basics': {
    waitMs: 40000,
    expect: 'arm sysid1; mission up/down sysid2',
    prep: 'ap-guided-1',
  },
  '15-companion-ap': {
    waitMs: 10000,
    expect: 'NVF sent on companion 20',
  },
  '16-companion-px4': {
    waitMs: 10000,
    expect: 'NVF sent on companion 21',
  },
  '17-int-carrier-goto': {
    waitMs: 55000,
    expect: 'arm+takeoff+INT goto accepted; ~150 m north',
    prep: 'px4-home-ready',
  },
};

function req(method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const r = http.request(
      {
        hostname: NR_HOST,
        port: NR_PORT,
        path: urlPath,
        method,
        headers: {
          'Content-Type': 'application/json',
          'Node-RED-API-Version': 'v2',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
          ...headers,
        },
      },
      (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve({ status: res.statusCode, body: b }));
      }
    );
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function sh(cmd, timeoutMs = 15000) {
  const r = spawnSync('bash', ['-c', cmd], {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
  });
  return {
    code: r.status,
    out: `${r.stdout || ''}${r.stderr || ''}`,
  };
}

function listExampleFiles() {
  return fs
    .readdirSync(SITL_DIR)
    .filter((f) => /^\d+-.*\.json$/.test(f))
    .sort();
}

function enableConsoleDebug(flows) {
  for (const n of flows) {
    if (n && n.type === 'debug') n.console = true;
  }
  return flows;
}

function nrLogSince(seconds) {
  return sh(`docker logs --since ${seconds}s nrc-nodered 2>&1`).out;
}

function extractDebugBlocks(log) {
  const lines = log.split('\n');
  const blocks = [];
  let cur = null;
  for (const line of lines) {
    const m = line.match(/\[(debug:[^\]]+|error)\]\s*(.*)$/);
    if (m && (m[1].startsWith('debug:') || m[1] === 'error')) {
      if (cur) blocks.push(cur);
      cur = { tag: m[1], head: m[2] || '', body: [] };
      continue;
    }
    if (cur) {
      cur.body.push(line);
      if (line === '}') {
        blocks.push(cur);
        cur = null;
      }
    }
  }
  if (cur) blocks.push(cur);
  return blocks;
}

function summarizeBlocks(blocks) {
  const debug = [];
  const errors = [];
  for (const b of blocks) {
    const text = `${b.head}\n${b.body.join('\n')}`;
    if (b.tag === 'error' || /\[error\]/.test(b.tag)) {
      errors.push(text.trim().slice(0, 500));
      continue;
    }
    const result = (text.match(/result:\s*'([^']+)'/) || [])[1];
    const command = (text.match(/command:\s*'([^']+)'/) || [])[1];
    const detail = (text.match(/detail:\s*'([^']+)'/) || text.match(/detail:\s*([^\n,]+)/) || [])[1];
    debug.push({
      tag: b.tag,
      result: result || null,
      command: command || null,
      detail: detail || null,
      excerpt: text.trim().slice(0, 400),
    });
  }
  return { debug, errors };
}

function verdictFrom(profile, summary, log) {
  const results = summary.debug.map((d) => d.result).filter(Boolean);
  const errText = summary.errors.join('\n');
  const expect = profile.expect || '';

  if (/timeout \(status names timeout/.test(expect)) {
    if (results.includes('timed-out') || /timeout/i.test(log) || results.includes('unconfirmed')) {
      return { status: 'PASS', reason: 'timeout path observed as designed' };
    }
  }
  if (/fails loud|expect fail/i.test(expect)) {
    const hasFail = results.some((r) => /fail|error|refused/i.test(r)) || /does not support|fail/i.test(log);
    const hasOk = results.some((r) => /success|accepted|succeeded/i.test(r));
    if (hasFail || (hasOk && /px4/i.test(log))) {
      return { status: hasFail || /does not support fence/i.test(log) ? 'PASS' : 'PARTIAL', reason: 'mixed AP ok / PX4 fail expected' };
    }
  }
  if (/signing/i.test(expect) || /setup-dependent/i.test(profile.notes || '')) {
    if (results.length || summary.errors.length || /sign/i.test(log)) {
      return {
        status: summary.errors.length && !results.includes('accepted') ? 'SKIP/FAIL' : 'PARTIAL',
        reason: 'signing template against unsigned SITL',
      };
    }
  }
  if (/INT goto|150 m/i.test(expect)) {
    if (results.includes('accepted') && /DO_REPOSITION|INT goto/i.test(log)) {
      return { status: 'PASS', reason: 'INT goto accepted' };
    }
  }
  if (/one failed|member expires/i.test(expect)) {
    if (/failed|expired/i.test(log)) return { status: 'PASS', reason: 'failed/expired member observed' };
  }

  const bad = results.filter((r) =>
    /fail|timed-out|unconfirmed|error|denied/i.test(r)
  );
  const good = results.filter((r) =>
    /accepted|succeeded|success|dry_run|ok/i.test(r)
  );

  if (good.length && !bad.length && !summary.errors.length) {
    return { status: 'PASS', reason: `results: ${[...new Set(good)].join(', ')}` };
  }
  if (good.length && (bad.length || summary.errors.length)) {
    return {
      status: 'PARTIAL',
      reason: `good=${[...new Set(good)].join('|') || 'none'}; bad=${[...new Set(bad)].join('|') || 'none'}; errors=${summary.errors.length}`,
    };
  }
  if (summary.errors.length && !good.length) {
    return { status: 'FAIL', reason: summary.errors[0].slice(0, 200) };
  }
  if (!results.length && !summary.errors.length) {
    return { status: 'UNKNOWN', reason: 'no debug/error payloads captured' };
  }
  return {
    status: bad.length ? 'FAIL' : 'UNKNOWN',
    reason: `results=${results.join(',') || 'none'}`,
  };
}

async function setApGuided(sysid = 1) {
  // Run out-of-band so Node-RED is not holding 14550.
  const script = `
    const { Connection, BAND } = require(${JSON.stringify(path.join(ROOT, 'lib/connection'))});
    const { loadBundled } = require(${JSON.stringify(path.join(ROOT, 'lib/metadata'))});
    const { buildCommandLong } = require(${JSON.stringify(path.join(ROOT, 'lib/command/carrier'))});
    const resolveIdentity = (i) => ({ identityId: i.defaultIdentityId, source: 'default' });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    (async () => {
      const bundle = loadBundled('ardupilotmega');
      const conn = new Connection({
        transport: { mode: 'udp', bindAddress: '0.0.0.0', bindPort: 14550, remoteAddress: '127.0.0.1', remotePort: 14551 },
        vehicle: { targetSysid: ${sysid}, targetCompid: 1, bundle, firmware: 'ardupilot', autopilot: 3 },
        identities: [{ id: 'gcs', sysid: 255, compid: 190, heartbeat: { type: 6, autopilot: 8, systemStatus: 4, baseMode: 0, customMode: 0, mavlinkVersion: 3 }, heartbeatIntervalMs: 500 }],
        defaultIdentityId: 'gcs', boundIdentityIds: ['gcs'],
        signing: { linkId: 0, signOutbound: false, requireSigned: false, acceptInvalid: false, hasKey: false },
        heartbeat: { staleMs: 5000, expireMs: 15000 },
      }, { resolveIdentity, logger: { info() {}, warn() {}, error() {} } });
      await conn.start();
      await sleep(2000);
      const t = { sysid: ${sysid}, compid: 1 };
      conn.send(buildCommandLong(176, ${sysid}, 1, [1, 4, 0, 0, 0, 0, 0], 0), { band: BAND.CONTROL, target: t });
      await sleep(800);
      conn.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 400);
    })().catch(() => process.exit(1));
  `;
  sh(`node -e ${JSON.stringify(script)}`, 20000);
}

async function prep(kind) {
  if (kind === 'ap-guided-1') {
    await setApGuided(1);
  }
  if (kind === 'px4-home-ready') {
    sh('docker exec nrc-px4-11 /opt/px4/bin/px4-commander disarm -f >/dev/null 2>&1 || true');
    await sleep(1500);
  }
}

async function afterInjectHook(fileBase, startedAt) {
  if (fileBase === '09-swarm-member-expires') {
    await sleep(2500);
    console.log('  killing nrc-ap-3 mid-run…');
    sh('docker stop nrc-ap-3 >/dev/null');
  }
}

async function cleanupAfter(fileBase) {
  if (fileBase === '09-swarm-member-expires') {
    console.log('  restarting nrc-ap-3…');
    sh('docker start nrc-ap-3 >/dev/null');
    await sleep(8000);
  }
  // Disarm fleets after arming examples
  if (/01|08|10|11|14|17|03/.test(fileBase.slice(0, 2))) {
    sh(
      `for c in nrc-ap-1 nrc-ap-2 nrc-ap-3 nrc-ap-4 nrc-ap-5; do docker exec $c bash -c 'echo "mode GUIDED; arm throttle" >/dev/null' 2>/dev/null; done; true`
    );
    for (const c of [
      'nrc-px4-11',
      'nrc-px4-12',
      'nrc-px4-13',
      'nrc-px4-14',
      'nrc-px4-15',
    ]) {
      sh(`docker exec ${c} /opt/px4/bin/px4-commander disarm -f >/dev/null 2>&1 || true`);
    }
  }
}

async function runOne(file) {
  const fileBase = file.replace(/\.json$/, '');
  const profile = PROFILE[fileBase] || { waitMs: 20000, expect: 'exercise flow' };
  const full = path.join(SITL_DIR, file);
  const flows = enableConsoleDebug(JSON.parse(fs.readFileSync(full, 'utf8')));
  const tab = (flows.find((n) => n.type === 'tab') || {}).label || fileBase;
  const injects = flows.filter((n) => n.type === 'inject');

  console.log(`\n=== ${file} (${tab}) ===`);
  if (profile.prep) await prep(profile.prep);

  const mark = Math.floor(Date.now() / 1000);
  const deploy = await req('POST', '/flows', { flows }, { 'Node-RED-Deployment-Type': 'full' });
  if (deploy.status >= 300) {
    return {
      file,
      tab,
      status: 'FAIL',
      reason: `deploy HTTP ${deploy.status}: ${deploy.body.slice(0, 200)}`,
      expect: profile.expect,
    };
  }

  // Let connections bind + learn peers
  await sleep(4000);

  const injectResults = [];
  for (const inj of injects) {
    if (inj.once) {
      injectResults.push({ id: inj.id, name: inj.name, skipped: 'once (deploy)' });
      continue;
    }
    const r = await req('POST', `/inject/${inj.id}`);
    injectResults.push({ id: inj.id, name: inj.name, http: r.status, body: r.body.slice(0, 80) });
    console.log(`  inject ${inj.name || inj.id} → ${r.status}`);
    await afterInjectHook(fileBase, mark);
    // small gap between multi-inject flows
    await sleep(1500);
  }

  await sleep(profile.waitMs);

  const log = nrLogSince(Math.max(5, Math.ceil(profile.waitMs / 1000) + 10));
  const blocks = extractDebugBlocks(log);
  const summary = summarizeBlocks(blocks);
  const verdict = verdictFrom(profile, summary, log);

  await cleanupAfter(fileBase);

  // Clear flows to idle so next bind is free
  await req(
    'POST',
    '/flows',
    {
      flows: [{ id: 'idle-tab', type: 'tab', label: 'idle', disabled: false }],
    },
    { 'Node-RED-Deployment-Type': 'full' }
  );
  await sleep(1500);

  return {
    file,
    tab,
    expect: profile.expect,
    notes: profile.notes || null,
    status: verdict.status,
    reason: verdict.reason,
    injects: injectResults,
    debug: summary.debug.slice(0, 30),
    errors: summary.errors.slice(0, 15),
  };
}

async function main() {
  const files = listExampleFiles().filter((f) => {
    if (!ONLY) return true;
    const base = f.replace(/\.json$/, '');
    const num = base.slice(0, 2);
    return ONLY.has(base) || ONLY.has(num) || ONLY.has(f);
  });

  console.log(`Running ${files.length} SITL examples → ${OUT}`);
  const started = new Date().toISOString();
  const results = [];
  for (const f of files) {
    try {
      results.push(await runOne(f));
    } catch (err) {
      results.push({
        file: f,
        status: 'FAIL',
        reason: String(err && err.stack ? err.stack : err),
      });
      // best-effort unlock binds
      try {
        await req(
          'POST',
          '/flows',
          { flows: [{ id: 'idle-tab', type: 'tab', label: 'idle', disabled: false }] },
          { 'Node-RED-Deployment-Type': 'full' }
        );
      } catch {
        /* ignore */
      }
    }
  }

  const report = {
    started,
    finished: new Date().toISOString(),
    host: `${NR_HOST}:${NR_PORT}`,
    results,
  };
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(`\nWrote ${OUT}`);
  const counts = results.reduce((a, r) => {
    a[r.status] = (a[r.status] || 0) + 1;
    return a;
  }, {});
  console.log('Summary', counts);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
