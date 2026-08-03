'use strict';

/**
 * Deploy each examples/sitl/*.json into the lab Node-RED (host :1880), fire
 * injects, scrape debug/error lines, and write a JSON report.
 *
 * Before each non-SKIP example, docker-restarts the vehicle fleet (not
 * Node-RED) so altitude / EKF / arm state cannot leak across tests — force-
 * disarm alone leaves AGL and makes NAV_TAKEOFF DENIED. See sitl/AGENTS.md.
 *
 * Post curated verdicts to a GitHub Issue (label sitl-results), close the prior
 * issue, and keep the JSON out of git — see sitl/AGENTS.md.
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
    : path.join('/tmp', 'sitl-example-suite-results.json');

/** @type {Record<string, {waitMs: number, expect: string, notes?: string, prep?: string, afterInject?: Function}>} */
const PROFILE = {
  '01-completion-takeoff': {
    waitMs: 45000,
    expect: 'takeoff complete / altitude reached',
    prep: 'ap-guided-1',
  },
  '02-completion-timeout': {
    waitMs: 35000,
    expect: 'completion timeout after accepted takeoff',
    prep: 'ap-guided-1',
  },
  '03-temporarily-rejected': {
    waitMs: 30000,
    expect: 'arm eventually accepted (TEMPORARILY_REJECTED only on fresh boot)',
    notes:
      'fleet restart already boots AP-1; TEMPORARILY_REJECTED remains best-effort if GPS/EKF settle before inject',
  },
  '04-mode-tables': {
    waitMs: 20000,
    expect: 'AP GUIDED + PX4 mode set accepted',
    prep: 'px4-mode-ready',
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
  '08-fanout-sequential-five': {
    waitMs: 25000,
    expect: 'dry-run then live sequential arm ×5',
    // confirm-arm needs EKF; fleet restart alone is not enough (see ap-arm-ready-fleet).
    prep: 'ap-arm-ready-fleet',
  },
  '09-fanout-member-expires': {
    waitMs: 20000,
    expect: 'aggregate reports one failed after mid-run kill',
    // Mid-run kill is afterInjectHook; prep only waits for armable AP 1–5.
    prep: 'ap-arm-ready-fleet',
  },
  '10-dual-stack-ten': {
    waitMs: 25000,
    expect: 'broadcast arm AP 1–5 and PX4 11–15',
    // delivery=send does not wait for arm ACKs; still wait so the story is not a no-op.
    prep: 'ap-arm-ready-fleet',
  },
  '11-broadcast-vs-sequential': {
    waitMs: 30000,
    expect: 'sequential + broadcast arm confirmed',
    prep: 'ap-arm-ready-fleet',
  },
  '12-signing': {
    waitMs: 5000,
    expect: 'signed arm attempt (needs Admin signing passphrase)',
    notes: 'Admin API deploy cannot supply signing credentials; skip in default lab',
    skip: true,
  },
  '13-param-defs-live': {
    waitMs: 20000,
    expect: 'read / set / list param defs against AP',
    // Let set echo-confirm finish before request-list floods PARAM_VALUE.
    injectGapMs: 8000,
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
  '18-int-local-vs-global': {
    waitMs: 25000,
    expect: 'GLOBAL_INT accepted both stacks; LOCAL_NED denied AP / accepted PX4',
  },
  '19-ap-int-carrier-goto': {
    waitMs: 55000,
    expect: 'AP arm+takeoff+INT goto accepted',
    prep: 'ap-guided-1',
  },
  '20-move-stream-stop': {
    waitMs: 25000,
    expect: 'move stream then zero-velocity stop',
    prep: 'ap-guided-1',
  },
  '21-param-echo-float32': {
    waitMs: 35000,
    expect: 'AP + PX4 float32 param set/read echo',
  },
  '22-in-build-out': {
    waitMs: 20000,
    expect: 'mavlink-in → build → out composition',
  },
  '23-profile-target-inherit': {
    waitMs: 20000,
    expect: 'command inherits profile target sysid 2',
  },
  '24-companion-receive': {
    waitMs: 15000,
    expect: 'companion receive path sees vehicle traffic',
  },
  '25-tcp-connection': {
    waitMs: 5000,
    expect: 'TCP template — skip unless SITL TCP exposed',
    notes: 'default Compose lab is UDP-only; skip without published :5760',
    skip: true,
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

  if (/completion timeout/i.test(expect)) {
    // Must be the takeoff node's completion timeout — arm/GUIDED timed-out must not PASS.
    const takeoffTimedOut = summary.debug.some((d) => {
      const aboutTakeoff =
        /takeoff/i.test(d.tag) ||
        /NAV_TAKEOFF|MAV_CMD_NAV_TAKEOFF/i.test(d.command || '') ||
        /NAV_TAKEOFF|takeoff/i.test(d.excerpt || '');
      return (
        aboutTakeoff &&
        (d.result === 'timed-out' ||
          d.result === 'unconfirmed' ||
          /timeout/i.test(d.detail || ''))
      );
    });
    if (takeoffTimedOut) {
      return { status: 'PASS', reason: 'takeoff completion timeout observed as designed' };
    }
    return { status: 'UNKNOWN', reason: 'takeoff completion timeout path not observed' };
  }
  if (/NVF|NAMED_VALUE_FLOAT/i.test(expect)) {
    const sentNamedValue = summary.debug.filter((d) =>
      d.result === 'sent' && /NAMED_VALUE_FLOAT/i.test(d.excerpt)
    );
    if (sentNamedValue.length) {
      return { status: 'PASS', reason: `NAMED_VALUE_FLOAT sent (${sentNamedValue.length})` };
    }
  }
  if (/bad upload fails|good upload ok/i.test(expect)) {
    const goodMission = summary.debug.some((d) =>
      d.result === 'succeeded' && /mavlink-mission/.test(d.excerpt)
    );
    const validationFailure = summary.debug.some((d) =>
      d.result === 'failed' && /phase:\s*'validate'/.test(d.excerpt)
    );
    const planSurvives = /operation:\s*'download'[\s\S]*result:\s*'succeeded'[\s\S]*count:\s*2/i.test(log);
    if (goodMission && validationFailure && planSurvives) {
      return { status: 'PASS', reason: 'good mission survived expected validation failure' };
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
    const aggregateFailed = summary.debug.some((d) =>
      d.result === 'failed' && /mavlink-fanout|aggregate|fanout/i.test(d.excerpt)
    );
    const memberFailed = /members:\s*\[[\s\S]*?(?:result:\s*'(?:failed|timed-out|unconfirmed)'|detail:\s*'[^']*(?:timeout|expired|failed))/i.test(log) ||
      /"members"\s*:\s*\[[\s\S]*?(?:"result"\s*:\s*"(?:failed|timed-out|unconfirmed)"|"detail"\s*:\s*"[^"]*(?:timeout|expired|failed))/i.test(log);
    if (aggregateFailed || memberFailed) {
      return { status: 'PASS', reason: 'fan-out aggregate/member failure observed' };
    }
    return { status: 'UNKNOWN', reason: 'fan-out member failure not observed' };
  }
  if (/GLOBAL_INT|LOCAL_NED/i.test(expect)) {
    const apGlobal = summary.debug.some(
      (d) => /ap global/i.test(d.tag) && d.result === 'accepted'
    );
    const apLocalDenied = summary.debug.some(
      (d) => /ap local/i.test(d.tag) && /denied|failed/i.test(d.result || '')
    );
    const px4Global = summary.debug.some(
      (d) => /px4 global/i.test(d.tag) && d.result === 'accepted'
    );
    const px4Local = summary.debug.some(
      (d) => /px4 local/i.test(d.tag) && d.result === 'accepted'
    );
    if (apGlobal && apLocalDenied && px4Global && px4Local) {
      return {
        status: 'PASS',
        reason: 'frame matrix: AP GLOBAL ok / AP LOCAL denied / PX4 both ok',
      };
    }
    if (apGlobal || apLocalDenied || px4Global || px4Local) {
      return {
        status: 'PARTIAL',
        reason: `frame matrix incomplete: apG=${apGlobal} apLden=${apLocalDenied} px4G=${px4Global} px4L=${px4Local}`,
      };
    }
  }
  if (/move stream|stop sent|zero.?velocity/i.test(expect)) {
    const streaming = summary.debug.some(
      (d) => d.result === 'succeeded' && /streaming/i.test(d.detail || d.excerpt || '')
    );
    const zeroOrResent = summary.debug.filter(
      (d) => d.result === 'succeeded' && /streaming|sent/i.test(d.detail || d.excerpt || '')
    ).length;
    if (streaming && zeroOrResent >= 2) {
      return { status: 'PASS', reason: 'move stream then zero-velocity/stop observed' };
    }
  }
  if (/float32 param|param set\/read echo/i.test(expect)) {
    // Require per-stack set success (debug names are AP/PX4-specific) — one
    // stack's set+read pair must not count as two echoes.
    const apSet = summary.debug.some((d) => /ap set/i.test(d.tag) && d.result === 'succeeded');
    const px4Set = summary.debug.some((d) => /px4 set/i.test(d.tag) && d.result === 'succeeded');
    if (apSet && px4Set) {
      return { status: 'PASS', reason: 'AP + PX4 float32 param echoes succeeded' };
    }
    if (apSet || px4Set) {
      return { status: 'PARTIAL', reason: `param echoes: ap=${apSet} px4=${px4Set}` };
    }
  }
  if (/in → build → out|composition/i.test(expect)) {
    if (results.includes('sent') || /mavlink-out|NAMED_VALUE|HEARTBEAT/i.test(log)) {
      return { status: 'PASS', reason: 'in/build/out path exercised' };
    }
  }
  if (/inherits profile target|sysid 2/i.test(expect)) {
    const inheritOk = summary.debug.some((d) => {
      if (d.result !== 'accepted' && d.result !== 'sent') return false;
      return /sysid:\s*2\b/.test(d.excerpt || '') || /target:\s*\{\s*sysid:\s*2\b/.test(d.excerpt || '');
    });
    if (inheritOk) {
      return { status: 'PASS', reason: 'profile target inherit resolved sysid 2' };
    }
    return { status: 'UNKNOWN', reason: 'accepted/sent without resolved target sysid 2' };
  }
  if (/companion receive/i.test(expect)) {
    // Receive proof only — outbound NVF `sent` must not PASS this story.
    const rx = summary.debug.some((d) => {
      if (/nvf/i.test(d.tag)) return false;
      if (/vehicle heartbeat|vehicle statustext|state events/i.test(d.tag)) return true;
      if (/result:\s*'sent'|NAMED_VALUE_FLOAT/i.test(d.excerpt || '')) return false;
      return /sysid:\s*20\b/.test(d.excerpt || '') &&
        (/HEARTBEAT|STATUSTEXT|kind:\s*'transition'|peer-new|heartbeat/i.test(d.excerpt || ''));
    });
    if (rx) {
      return { status: 'PASS', reason: 'companion receive traffic observed (sysid 20)' };
    }
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

function runApControlScript(body, timeoutMs = 20000) {
  // Run out-of-band so Node-RED is not holding 14550.
  // Pass the source as node argv (not bash -c + JSON.stringify): bash double
  // quotes leave `\\n` literal, so `node -e` used to SyntaxError and the old
  // harness ignored the exit code — GUIDED prep never actually ran.
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
        vehicle: { targetSystem: 1, targetComponent: 1, bundle, firmware: 'ardupilot', autopilot: 3 },
        identities: [{ id: 'gcs', sysid: 255, compid: 190, heartbeat: { type: 6, autopilot: 8, systemStatus: 4, baseMode: 0, customMode: 0, mavlinkVersion: 3 }, heartbeatIntervalMs: 500 }],
        defaultIdentityId: 'gcs', boundIdentityIds: ['gcs'],
        signing: { linkId: 0, signOutbound: false, requireSigned: false, acceptInvalid: false, hasKey: false },
        heartbeat: { staleMs: 5000, expireMs: 15000 },
      }, { resolveIdentity, logger: { info() {}, warn() {}, error() {} } });
      await conn.start();
      await sleep(2000);
      ${body}
      conn.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 400);
    })().catch((err) => {
      console.error(err && err.stack ? err.stack : err);
      process.exit(1);
    });
  `;
  const r = spawnSync('node', ['-e', script], {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  if (r.status !== 0) {
    throw new Error(`AP control script failed (exit ${r.status}): ${out.slice(0, 300)}`);
  }
  return { code: r.status, out };
}

/** Vehicle containers only — never restart nrc-nodered between examples. */
const VEHICLE_CONTAINERS = [
  'nrc-ap-1',
  'nrc-ap-2',
  'nrc-ap-3',
  'nrc-ap-4',
  'nrc-ap-5',
  'nrc-px4-11',
  'nrc-px4-12',
  'nrc-px4-13',
  'nrc-px4-14',
  'nrc-px4-15',
  'nrc-ap-companion-20',
  'nrc-px4-companion-21',
];

const PX4_VEHICLE_CONTAINERS = [
  'nrc-px4-11',
  'nrc-px4-12',
  'nrc-px4-13',
  'nrc-px4-14',
  'nrc-px4-15',
];

/**
 * Brief pause after docker restart before peer learning / PX4 helpers.
 * Arm-ready is not this sleep — `ap-guided-1` polls until arm succeeds
 * (override with SITL_FLEET_SETTLE_MS).
 */
const FLEET_SETTLE_MS = Number(process.env.SITL_FLEET_SETTLE_MS) > 0
  ? Number(process.env.SITL_FLEET_SETTLE_MS)
  : 8000;

/**
 * After fleet restart, arm stays DENIED until EKF/IMU settle (STATUSTEXT:
 * "Gyros inconsistent" / "Need Position Estimate"). Poll — do not blind-sleep.
 * Force-disarm after the probe so the example's own arm step still runs.
 */
async function waitApArmReady(sysids, timeoutMs = 120000) {
  const list = Array.isArray(sysids) ? sysids : [sysids];
  console.log(`  waiting for AP ${list.join(',')} arm-ready…`);
  runApControlScript(
    `
      const sysids = ${JSON.stringify(list)};
      const deadline = Date.now() + ${timeoutMs};
      const compOf = (id) => conn.peerTable.getComponent(id, 1);
      for (const sysid of sysids) {
        const t = { sysid, compid: 1 };
        let armedOk = false;
        while (Date.now() < deadline) {
          const comp = compOf(sysid);
          if (comp?.primaryEndpoint) {
            if (comp.armed) { armedOk = true; break; }
            conn.send(buildCommandLong(400, sysid, 1, [1, 0, 0, 0, 0, 0, 0], 0), { band: BAND.CONTROL, target: t });
          }
          await sleep(2000);
          if (compOf(sysid)?.armed) { armedOk = true; break; }
        }
        if (!armedOk) throw new Error('AP-' + sysid + ' did not become armable after fleet restart');
        conn.send(buildCommandLong(400, sysid, 1, [0, 21196, 0, 0, 0, 0, 0], 0), { band: BAND.CONTROL, target: t });
        await sleep(400);
      }
    `,
    timeoutMs + 30000
  );
}

async function setApGuided(sysid = 1) {
  // After fleet restart:
  // 1) SET_MODE needs a learned peer endpoint (pre-peer fallback never arrives).
  // 2) GUIDED while disarmed succeeds in seconds; arm stays DENIED until EKF ready.
  // 3) Prove arm works, then force-disarm so the example's own arm step runs.
  console.log(`  waiting for AP-${sysid} GUIDED + arm-ready…`);
  runApControlScript(
    `
      const t = { sysid: ${sysid}, compid: 1 };
      const deadline = Date.now() + 120000;
      const compOf = () => conn.peerTable.getComponent(${sysid}, 1);
      let guided = false;
      while (Date.now() < deadline) {
        const comp = compOf();
        if (comp?.primaryEndpoint) {
          if (comp.flightMode === 4) { guided = true; break; }
          if (comp.armed) {
            conn.send(buildCommandLong(400, ${sysid}, 1, [0, 21196, 0, 0, 0, 0, 0], 0), { band: BAND.CONTROL, target: t });
            await sleep(500);
          }
          conn.send(buildCommandLong(176, ${sysid}, 1, [1, 4, 0, 0, 0, 0, 0], 0), { band: BAND.CONTROL, target: t });
        }
        await sleep(1000);
      }
      if (!guided && compOf()?.flightMode !== 4) {
        throw new Error('AP-${sysid} did not enter GUIDED after fleet restart');
      }
    `,
    150000
  );
  await waitApArmReady([sysid], 120000);
  runApControlScript(
    `
      const t = { sysid: ${sysid}, compid: 1 };
      const compOf = () => conn.peerTable.getComponent(${sysid}, 1);
      if (compOf()?.flightMode !== 4) {
        conn.send(buildCommandLong(176, ${sysid}, 1, [1, 4, 0, 0, 0, 0, 0], 0), { band: BAND.CONTROL, target: t });
        await sleep(800);
      }
    `,
    20000
  );
}

function applyPx4LabHelpers(containers = PX4_VEHICLE_CONTAINERS) {
  // Parallel param poke — each SIH instance needs its own socket.
  const inner =
    "cd /opt/px4 && ./bin/px4-param set MAV_0_BROADCAST 1 >/dev/null; " +
    "./bin/px4-param set COM_RCL_EXCEPT 7 >/dev/null; " +
    "./bin/px4-param set COM_ARM_MAG_STR 0 >/dev/null; " +
    "./bin/px4-commander disarm -f >/dev/null 2>&1 || true";
  const parts = containers.map(
    (c) => `docker exec ${c} sh -lc ${JSON.stringify(inner)} >/dev/null 2>&1 || true`
  );
  sh(`(${parts.join(' & ')}; wait)`, 60000);
}

/**
 * Reset every SITL vehicle between examples. Force-disarm does not clear AGL;
 * ArduCopter then DENY's NAV_TAKEOFF when still ~airborne from a prior flight.
 */
async function restartVehicleFleet() {
  console.log('  restarting vehicle fleet…');
  const r = sh(
    `for c in ${VEHICLE_CONTAINERS.join(' ')}; do docker restart "$c" >/dev/null & done; wait`,
    180000
  );
  if (r.code !== 0) {
    console.warn(`  fleet restart exit ${r.code}: ${r.out.slice(0, 200)}`);
  }
  await sleep(FLEET_SETTLE_MS);
  applyPx4LabHelpers();
  await sleep(1500);
}

async function prep(kind) {
  if (kind === 'ap-guided-1') {
    await setApGuided(1);
  }
  if (kind === 'ap-arm-ready-fleet') {
    await waitApArmReady([1, 2, 3, 4, 5], 150000);
  }
  if (kind === 'px4-home-ready' || kind === 'px4-mode-ready') {
    // Fleet restart already applied helpers to all PX4; refresh sysid 11 once more
    // immediately before deploy (params can race early HEARTBEAT).
    applyPx4LabHelpers(['nrc-px4-11']);
    await sleep(1500);
  }
}

async function afterInjectHook(fileBase, startedAt) {
  if (fileBase === '09-fanout-member-expires') {
    await sleep(200);
    console.log('  killing nrc-ap-3 mid-run…');
    sh('docker stop nrc-ap-3 >/dev/null');
  }
}

async function cleanupAfter(fileBase) {
  // Next example's fleet restart is the real altitude/arm reset. Only recover
  // containers the example intentionally stopped so docker restart can proceed.
  if (fileBase === '09-fanout-member-expires') {
    console.log('  ensuring nrc-ap-3 is startable for next fleet restart…');
    sh('docker start nrc-ap-3 >/dev/null 2>&1 || true');
    await sleep(2000);
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
  if (profile.skip) {
    return {
      file,
      tab,
      status: 'SKIP',
      reason: profile.notes || profile.expect,
      expect: profile.expect,
      notes: profile.notes || null,
      injects: [],
      debug: [],
      errors: [],
    };
  }
  // Isolation: docker-restart vehicles so AGL/EKF/arm from prior examples cannot
  // DENY takeoff or poison fan-out members. Node-RED stays up (UDP binds cleared later).
  await restartVehicleFleet();
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

  const injectGapMs = Number(profile.injectGapMs) > 0 ? Number(profile.injectGapMs) : 1500;
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
    // Gap before the next inject (example 13 needs set echo to finish before list flood).
    await sleep(injectGapMs);
  }

  await sleep(profile.waitMs);

  // Cover the whole example (prep gaps + injectGapMs + wait), not only waitMs —
  // otherwise long multi-inject stories (e.g. 13) scrape an empty idle window.
  const log = nrLogSince(Math.max(15, Math.floor(Date.now() / 1000) - mark + 5));
  const blocks = extractDebugBlocks(log);
  const summary = summarizeBlocks(blocks);
  const verdict = verdictFrom(profile, summary, log);

  // Clear flows first so cleanup can bind 14550.
  await req(
    'POST',
    '/flows',
    {
      flows: [{ id: 'idle-tab', type: 'tab', label: 'idle', disabled: false }],
    },
    { 'Node-RED-Deployment-Type': 'full' }
  );
  await sleep(1500);
  await cleanupAfter(fileBase);

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
