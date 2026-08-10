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
    waitMs: 20000,
    expect: 'TEMPORARILY_REJECTED retried until exhausted (PX4 packed mode)',
    prep: 'px4-mode-ready',
    notes:
      'AP cold-arm returns FAILED(4), not (1); example uses PX4 DO_SET_MODE param2=196608 which stably returns TEMPORARILY_REJECTED',
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
    // delivery=confirm: the first DENIED fails the aggregate, so every one of
    // the five has to be armable before the example runs.
    prep: 'ap-arm-ready-fleet',
  },
  '09-fanout-member-expires': {
    waitMs: 20000,
    expect: 'aggregate reports one failed after mid-run kill',
    // The mid-run kill is afterInjectHook, keyed on the file — `kill-ap-3-mid`
    // was a label prep() never handled. The story needs four to arm and one to
    // fail; an unsettled EKF fails all five and the verdict means nothing.
    prep: 'ap-arm-ready-fleet',
  },
  '10-dual-stack-ten': {
    waitMs: 25000,
    expect: 'broadcast arm AP 1–5 and PX4 11–15',
    // No prep: delivery=send, so no ACK is waited on and no verdict turns on
    // whether anyone armed. Arm-ready here would cost ~40 s and change nothing.
  },
  '11-broadcast-vs-sequential': {
    waitMs: 30000,
    expect: 'sequential + broadcast arm confirmed',
    prep: 'ap-arm-ready-fleet',
    // The sequential half is five confirm-arms; POST /inject returns as soon as
    // the inject fires, not when the fan-out finishes. At the default 1.5 s gap
    // the broadcast half lands on top of it.
    injectGapMs: 12000,
  },
  '12-signing': {
    waitMs: 15000,
    expect: 'signed arm accepted; trusted HEARTBEAT on companion 20',
    prep: 'ap-signing-companion-20',
    notes:
      'Lab passphrase hunter11 injected via Admin API credentials; harness SETUP_SIGNING on companion AP sysid 20',
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
    prep: 'ap-home-ready',
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
    prep: 'ap-arm-ready-2',
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
  '26-formation-basics': {
    waitMs: 140000,
    expect: 'formation line then circle succeeded ×5',
    prep: 'ap-arm-ready-fleet',
    notes: 'GUIDED→arm→takeoff→line→circle on AP 1–5; mavlink-formation confirm aggregates',
  },
  '27-lucy-in-the-sky': {
    waitMs: 260000,
    expect: 'Lucy sphere tumble then peel land',
    prep: 'ap-arm-ready-fleet',
    notes: 'takeoff→line spread→sphere→pitch 0/45/90/135/180→sequential land',
  },
  '28-param-read-by-index': {
    waitMs: 45000,
    expect: 'AP list collect then PARAM_REQUEST_READ by param_index',
    notes: 'pick LOIT_SPEED_MS index from collect; assert empty param_id + index ≥ 0',
  },
  '29-param-fanout-set': {
    waitMs: 40000,
    expect: 'PARAM_SET fan-out sequential confirm ×5',
    notes: 'build LOIT_SPEED_MS → fanout confirm on AP 1–5; no arm prep',
  },
  '30-px4-param-list': {
    waitMs: 55000,
    expect: 'PX4 request-list collect with known ids',
    notes: 'mirrors SITL 13 list path on sysid 11; assert COM_RC_IN_MODE + MPC_XY_VEL_MAX',
  },
  '31-param-encoding-override': {
    waitMs: 45000,
    expect: 'paramEncoding override matching + crossed timeout',
    // Matching sets finish in ~1 s; crossed AP bytewise waits the 5 s echo timeout.
    injectGapMs: 8000,
    notes:
      'matching overrides (PX4 bytewise / AP c-cast) succeed; crossed AP bytewise must echo-timeout (proves override rung)',
  },
  '32-param-echo-timeout': {
    waitMs: 25000,
    expect: 'known param then unknown WPNAV_SPEED echo timeout',
    injectGapMs: 3000,
    notes:
      'LOIT_SPEED_MS confirm proves AP-1 reachable; then missing WPNAV_SPEED must timed-out / echo timeout',
  },
  '33-payload-gimbal-legacy': {
    waitMs: 35000,
    expect: 'AP-31 legacy gimbal aim mode ROI accepted',
    injectGapMs: 2500,
    notes: 'sysid 31 / 14570 — aim + set-mode + roi-set + roi-clear confirm',
  },
  '34-payload-camera': {
    waitMs: 35000,
    expect: 'AP-31 camera photo accepted video denied',
    injectGapMs: 2500,
    notes: 'CAM1_TYPE=1 stills ACCEPTED; VIDEO_* DENIED on this SITL stack',
  },
  '35-payload-gimbal-manager': {
    waitMs: 15000,
    expect: 'AP-31 gimbal manager aim sent unconfirmed',
    notes: 'delivery=send; no COMMAND_ACK / no manager telemetry on Copter-4.7.0 --gimbal',
  },
  '36-peer-table-inflight': {
    waitMs: 20000,
    expect: 'peer-table snapshot armed+position+gps while airborne',
    prep: 'ap-guided-1',
    // Start flight (stream request + takeoff complete + 8 s move) then Snapshot.
    injectGapMs: 70000,
    notes:
      'Flow-level State snapshot after takeoff+move; hard §8 field asserts in sitl/measure-peer-table.js',
  },
  '37-move-reposition-carrier': {
    waitMs: 55000,
    expect: 'Move carrier=reposition goto accepted; yaw 90 deg turns east',
    prep: 'ap-guided-1',
    notes:
      'Same goto as 19 through mavlink-move instead of mavlink-command — carrier is the only variable. Measures: ACK reaches output 1 with resultCode 0; param4 yaw is radians (90 deg must end EAST, not some wrapped heading); blank speed/radius encode the -1/0 sentinels. CHANGE_MODE off — without-GUIDED and CHANGE_MODE are separate runs.',
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

  if (/TEMPORARILY_REJECTED retried|temporarily rejected/i.test(expect)) {
    const retried = summary.debug.some((d) => {
      const retriesMatch = (d.excerpt || '').match(/retries:\s*(\d+)/);
      const retries = retriesMatch ? Number(retriesMatch[1]) : 0;
      const rejected =
        d.result === 'temporarily_rejected' ||
        /temporarily_rejected/i.test(d.excerpt || '');
      return rejected && retries >= 1;
    });
    if (retried) {
      return {
        status: 'PASS',
        reason: 'TEMPORARILY_REJECTED observed with AckWaiter retries',
      };
    }
    return {
      status: 'FAIL',
      reason: 'TEMPORARILY_REJECTED retry path not observed',
    };
  }
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
  if (/signed arm accepted|trusted HEARTBEAT/i.test(expect)) {
    const armAccepted = summary.debug.some(
      (d) => d.result === 'accepted' && (/arm/i.test(d.tag) || /arm/i.test(d.excerpt || ''))
    );
    // debug node complete:"trusted" logs a bare true/false line under [debug:trusted flag]
    const trustedHb =
      /\[debug:trusted flag\]\s*\n?\s*true\b/i.test(log) ||
      summary.debug.some(
        (d) => /trusted flag/i.test(d.tag) && /^\s*true\s*$/m.test(d.excerpt || '')
      );
    if (armAccepted && trustedHb) {
      return {
        status: 'PASS',
        reason: 'signed arm accepted + trusted HEARTBEAT on companion 20',
      };
    }
    if (armAccepted || trustedHb) {
      return {
        status: 'PARTIAL',
        reason: `armAccepted=${armAccepted}; trustedHb=${trustedHb}`,
      };
    }
    return { status: 'FAIL', reason: 'signed arm / trusted HEARTBEAT not observed' };
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
    // Inherit is proven by the resolved target on the status record — success
    // or arm-DENIED both count; requiring accepted alone masked cold-EKF FAIL.
    const inheritOk = summary.debug.some((d) =>
      /target:\s*\{\s*sysid:\s*2\b/.test(d.excerpt || '') ||
      (/sysid:\s*2\b/.test(d.excerpt || '') && /target|compid/i.test(d.excerpt || ''))
    );
    if (inheritOk) {
      return { status: 'PASS', reason: 'profile target inherit resolved sysid 2' };
    }
    return { status: 'UNKNOWN', reason: 'no status record with resolved target sysid 2' };
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
  if (/formation line then circle/i.test(expect)) {
    const lineOk = summary.debug.some(
      (d) => /line status/i.test(d.tag) && d.result === 'succeeded'
    );
    const circleOk = summary.debug.some(
      (d) => /circle status/i.test(d.tag) && d.result === 'succeeded'
    );
    if (lineOk && circleOk) {
      return { status: 'PASS', reason: 'line + circle formation aggregates succeeded' };
    }
    if (lineOk || circleOk) {
      return {
        status: 'PARTIAL',
        reason: `formation incomplete: line=${lineOk} circle=${circleOk}`,
      };
    }
    return { status: 'FAIL', reason: 'no line/circle formation succeeded status' };
  }
  if (/Lucy sphere|peel land/i.test(expect)) {
    // Debug node names: "spread status", "s0 status" … "s180 status", "land status".
    const sphereSteps = ['s0', 's45', 's90', 's135', 's180'].filter((k) =>
      summary.debug.some((d) => new RegExp(`${k} status`, 'i').test(d.tag) && d.result === 'succeeded')
    );
    const spreadOk = summary.debug.some(
      (d) => /spread status/i.test(d.tag) && d.result === 'succeeded'
    );
    const landOk = summary.debug.some(
      (d) => /land status/i.test(d.tag) && d.result === 'succeeded'
    );
    if (spreadOk && sphereSteps.length === 5 && landOk) {
      return {
        status: 'PASS',
        reason: 'Lucy: spread + sphere pitch steps + peel land succeeded',
      };
    }
    if (spreadOk || sphereSteps.length || landOk) {
      return {
        status: 'PARTIAL',
        reason: `Lucy incomplete: spread=${spreadOk} pitches=${sphereSteps.length}/5 land=${landOk}`,
      };
    }
    return { status: 'FAIL', reason: 'Lucy formation/land path not observed' };
  }
  if (/PARAM_REQUEST_READ by param_index|read by index/i.test(expect)) {
    const listOk = summary.debug.some(
      (d) => /list status/i.test(d.tag) && d.result === 'succeeded'
    );
    const indexOk = summary.debug.some(
      (d) => /index assert/i.test(d.tag) && d.result === 'succeeded'
    );
    if (listOk && indexOk) {
      return { status: 'PASS', reason: 'list collect + index-addressed PARAM_REQUEST_READ' };
    }
    if (listOk || indexOk) {
      return {
        status: 'PARTIAL',
        reason: `index-read incomplete: list=${listOk} assert=${indexOk}`,
      };
    }
    return { status: 'FAIL', reason: 'list collect / index-read assert not observed' };
  }
  if (/PARAM_SET fan-out|fan-out sequential confirm/i.test(expect)) {
    // Fan-out silently drops absent peers — a 3/5 fleet can still report
    // succeeded. Require the aggregate count to prove the ×5 path ran.
    const fanOk = summary.debug.some(
      (d) =>
        /fanout status/i.test(d.tag) &&
        d.result === 'succeeded' &&
        /count:\s*5\b/.test(d.excerpt || '')
    );
    if (fanOk) {
      return { status: 'PASS', reason: 'PARAM_SET sequential fan-out confirm succeeded ×5' };
    }
    return { status: 'FAIL', reason: 'PARAM_SET fan-out succeeded×5 status not observed' };
  }
  if (/PX4 request-list collect/i.test(expect)) {
    const listOk = summary.debug.some(
      (d) => /list status/i.test(d.tag) && d.result === 'succeeded'
    );
    const assertOk = summary.debug.some(
      (d) => /list assert/i.test(d.tag) && d.result === 'succeeded'
    );
    if (listOk && assertOk) {
      return { status: 'PASS', reason: 'PX4 list collect + known ids present' };
    }
    if (listOk || assertOk) {
      return {
        status: 'PARTIAL',
        reason: `px4-list incomplete: status=${listOk} assert=${assertOk}`,
      };
    }
    return { status: 'FAIL', reason: 'PX4 list collect not observed' };
  }
  if (/paramEncoding override/i.test(expect)) {
    const apSet = summary.debug.some((d) => /ap set status/i.test(d.tag) && d.result === 'succeeded');
    const px4Set = summary.debug.some((d) => /px4 set status/i.test(d.tag) && d.result === 'succeeded');
    // Crossed override must fail: if payload.paramEncoding were ignored, AP would
    // fall back to c-cast and this set would succeed.
    const crossedTimedOut = summary.debug.some(
      (d) =>
        /ap wrong status/i.test(d.tag) &&
        d.result === 'timed-out' &&
        /echo timeout/i.test(d.detail || d.excerpt || '')
    );
    if (apSet && px4Set && crossedTimedOut) {
      return {
        status: 'PASS',
        reason: 'matching encoding overrides echoed; crossed AP bytewise timed out',
      };
    }
    if (apSet || px4Set || crossedTimedOut) {
      return {
        status: 'PARTIAL',
        reason: `encoding override: ap=${apSet} px4=${px4Set} crossedTimeout=${crossedTimedOut}`,
      };
    }
    return { status: 'FAIL', reason: 'paramEncoding override path not observed' };
  }
  if (/AP-31 legacy gimbal|legacy gimbal aim mode ROI/i.test(expect)) {
    const aim = summary.debug.some((d) => /aim status/i.test(d.tag) && d.result === 'succeeded');
    const mode = summary.debug.some((d) => /mode status/i.test(d.tag) && d.result === 'succeeded');
    const roiSet = summary.debug.some((d) => /roi set status/i.test(d.tag) && d.result === 'succeeded');
    const roiClear = summary.debug.some((d) => /roi clear status/i.test(d.tag) && d.result === 'succeeded');
    if (aim && mode && roiSet && roiClear) {
      return { status: 'PASS', reason: 'legacy gimbal aim/mode/ROI all accepted on AP-31' };
    }
    return {
      status: aim || mode || roiSet || roiClear ? 'PARTIAL' : 'FAIL',
      reason: `legacy gimbal: aim=${aim} mode=${mode} roiSet=${roiSet} roiClear=${roiClear}`,
    };
  }
  if (/AP-31 camera photo|camera photo accepted video denied/i.test(expect)) {
    const photo = summary.debug.some((d) => /photo status/i.test(d.tag) && d.result === 'succeeded');
    const vStartDenied = summary.debug.some(
      (d) => /video start status/i.test(d.tag) && /denied|failed/i.test(d.result || '')
    );
    const vStopDenied = summary.debug.some(
      (d) => /video stop status/i.test(d.tag) && /denied|failed/i.test(d.result || '')
    );
    if (photo && vStartDenied && vStopDenied) {
      return {
        status: 'PASS',
        reason: 'camera photo accepted; video start/stop DENIED as measured',
      };
    }
    return {
      status: photo || vStartDenied || vStopDenied ? 'PARTIAL' : 'FAIL',
      reason: `camera: photo=${photo} vStartDenied=${vStartDenied} vStopDenied=${vStopDenied}`,
    };
  }
  if (/AP-31 gimbal manager|gimbal manager aim sent/i.test(expect)) {
    const mgr = summary.debug.some(
      (d) =>
        /manager status/i.test(d.tag) &&
        d.result === 'succeeded' &&
        /unconfirmed/i.test(d.detail || d.excerpt || '')
    );
    if (mgr) {
      return { status: 'PASS', reason: 'gimbal manager aim sent (unconfirmed) on AP-31' };
    }
    return { status: 'FAIL', reason: 'manager send/unconfirmed status not observed' };
  }
  if (/peer-table snapshot|peer table enrichment/i.test(expect)) {
    // Node-RED console debug prints util.inspect objects (armed: true), not JSON.
    const takeoffOk = summary.debug.some(
      (d) =>
        /takeoff/i.test(d.tag) &&
        (d.result === 'succeeded' || d.result === 'accepted')
    );
    const snapTag = summary.debug.some((d) => /peer-table snapshot/i.test(d.tag));
    const armed = /\barmed:\s*true\b/.test(log);
    const relAlt = /\brelativeAlt:\s*[1-9]/.test(log);
    const gps = /\bfixType:\s*[3-9]/.test(log);
    const battery = /\bbattery:\s*\{/.test(log) && !/\bbattery:\s*null\b/.test(log);
    const home = /\bhome:\s*\{/.test(log) && !/\bhome:\s*null\b/.test(log);
    const fields = { takeoffOk, snapTag, armed, relAlt, gps, battery, home };
    const hits = Object.values(fields).filter(Boolean).length;
    if (hits >= 6) {
      return {
        status: 'PASS',
        reason: `peer-table snapshot in flight (${Object.entries(fields)
          .filter(([, v]) => v)
          .map(([k]) => k)
          .join(', ')})`,
      };
    }
    if (hits >= 3) {
      return {
        status: 'PARTIAL',
        reason: `peer-table inflight partial: ${JSON.stringify(fields)}`,
      };
    }
    return {
      status: 'FAIL',
      reason: `peer-table inflight missing: ${JSON.stringify(fields)}`,
    };
  }
  if (/WPNAV_SPEED echo timeout|unknown .*echo timeout/i.test(expect)) {
    // Negative path: timed-out is the success — but only after a known-param
    // confirm proves AP-1 is reachable (dead peer would also echo-timeout).
    const knownOk = summary.debug.some(
      (d) => /known set status/i.test(d.tag) && d.result === 'succeeded'
    );
    const echoTimedOut = summary.debug.some(
      (d) =>
        /unknown set status/i.test(d.tag) &&
        d.result === 'timed-out' &&
        /echo timeout/i.test(d.detail || d.excerpt || '')
    );
    if (knownOk && echoTimedOut) {
      return {
        status: 'PASS',
        reason: 'known LOIT_SPEED_MS confirmed; unknown WPNAV_SPEED echo-timed-out',
      };
    }
    if (knownOk || echoTimedOut) {
      return {
        status: 'PARTIAL',
        reason: `echo-timeout story: known=${knownOk} unknownTimeout=${echoTimedOut}`,
      };
    }
    return {
      status: 'FAIL',
      reason: 'known-param confirm + unknown-id echo timeout not observed',
    };
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

/**
 * Joke lab signing passphrase for example 12. Intentionally not a secret —
 * Admin API deploy injects it as Connection credentials; harness also pushes
 * SETUP_SIGNING with sha256(passphrase) onto companion AP sysid 20.
 */
const SITL_SIGNING_PASSPHRASE = 'hunter11';

/**
 * Run an out-of-band Connection script against one AP UDP pair.
 * Defaults: GCS fleet bind 14550 → remote 14551, target sysid 1.
 * Companion AP uses bind 14540 → remote 14541, target sysid 20.
 *
 * Pass the source as node argv (not bash -c + JSON.stringify): bash double
 * quotes leave `\\n` literal, so `node -e` used to SyntaxError and the old
 * harness ignored the exit code — GUIDED prep never actually ran.
 *
 * @param {string} body
 * @param {number} [timeoutMs]
 * @param {{bindPort?: number, remotePort?: number, targetSystem?: number}} [opts]
 */
function runApControlScript(body, timeoutMs = 20000, opts = {}) {
  const bindPort = Number(opts.bindPort) > 0 ? Number(opts.bindPort) : 14550;
  const remotePort = Number(opts.remotePort) > 0 ? Number(opts.remotePort) : 14551;
  const targetSystem = Number(opts.targetSystem) > 0 ? Number(opts.targetSystem) : 1;
  const script = `
    const { Connection, BAND } = require(${JSON.stringify(path.join(ROOT, 'lib/connection'))});
    const { loadBundled } = require(${JSON.stringify(path.join(ROOT, 'lib/metadata'))});
    const { buildCommandLong } = require(${JSON.stringify(path.join(ROOT, 'lib/command/carrier'))});
    const resolveIdentity = (i) => ({ identityId: i.defaultIdentityId, source: 'default' });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    (async () => {
      const bundle = loadBundled('ardupilotmega');
      const conn = new Connection({
        transport: { mode: 'udp', bindAddress: '0.0.0.0', bindPort: ${bindPort}, remoteAddress: '127.0.0.1', remotePort: ${remotePort} },
        vehicle: { targetSystem: ${targetSystem}, targetComponent: 1, bundle, firmware: 'ardupilot', autopilot: 3 },
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

/**
 * Attach signingPassphrase credentials for every Connection that enables
 * signOutbound or requireSigned. Node-RED's Admin API accepts a top-level
 * `credentials` map on POST /flows (flow JSON never embeds the secret).
 *
 * @param {object[]} flows
 * @returns {Record<string, {signingPassphrase: string}>}
 */
function signingCredentialsForFlows(flows) {
  /** @type {Record<string, {signingPassphrase: string}>} */
  const credentials = {};
  for (const n of flows) {
    if (!n || n.type !== 'mavlink-connection') continue;
    if (n.signOutbound || n.requireSigned) {
      credentials[n.id] = { signingPassphrase: SITL_SIGNING_PASSPHRASE };
    }
  }
  return credentials;
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
  'nrc-ap-payload-31',
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
 * Source for a probe-arm sweep over `sysids`, spliced into a control script.
 *
 * After a fleet restart an AP heartbeats within seconds but answers arm with
 * DENIED — STATUSTEXT reads "Gyros inconsistent", later "Need Position
 * Estimate" — until the IMUs and EKF settle. That took 20–40 s in this lab and
 * is not a constant, so this polls: a bigger `SITL_FLEET_SETTLE_MS` is a guess
 * that loses on a slow day. Each vehicle is force-disarmed once it proves
 * armable, so the example's own arm step is still the thing under test.
 *
 * One shared budget rather than one per vehicle. The fleet restarts together
 * and settles concurrently, so by the time the sweep reaches sysid 5 it has
 * already had four vehicles' worth of wall clock — it needs less of the
 * budget, not its own.
 *
 * Emitted inside a bare block so the names cannot collide with the script body
 * it is spliced into.
 *
 * @param {number[]} sysids
 * @param {number} budgetMs  wall clock for the whole sweep
 * @returns {string} JavaScript source
 */
function armReadySource(sysids, budgetMs) {
  return `
      {
        const deadline = Date.now() + ${budgetMs};
        for (const sysid of ${JSON.stringify(sysids)}) {
          const t = { sysid, compid: 1 };
          const compOf = () => conn.peerTable.getComponent(sysid, 1);
          while (!compOf()?.armed && Date.now() < deadline) {
            if (compOf()?.primaryEndpoint) {
              conn.send(buildCommandLong(400, sysid, 1, [1, 0, 0, 0, 0, 0, 0], 0), { band: BAND.CONTROL, target: t });
            }
            await sleep(2000);
          }
          if (!compOf()?.armed) {
            throw new Error('AP-' + sysid + ' did not become armable after fleet restart');
          }
          conn.send(buildCommandLong(400, sysid, 1, [0, 21196, 0, 0, 0, 0, 0], 0), { band: BAND.CONTROL, target: t });
          await sleep(800);
        }
      }
  `;
}

/**
 * Prep for the fan-out arm examples: prove AP 1–5 can arm, then leave them
 * disarmed. One control script, so the peer table is learned once.
 */
async function waitApArmReady(sysids, budgetMs = 120000) {
  console.log(`  waiting for AP ${sysids.join(',')} arm-ready…`);
  runApControlScript(armReadySource(sysids, budgetMs), budgetMs + 30000);
}

/**
 * Wait until AP has published HOME_POSITION (EKF origin). Needed before
 * DO_SET_HOME GLOBAL_INT — cold SITL returns MAV_RESULT_FAILED until then.
 *
 * @param {number} [sysid]
 */
async function waitApHomeReady(sysid = 1) {
  console.log(`  waiting for AP-${sysid} HOME_POSITION…`);
  runApControlScript(
    `
      const deadline = Date.now() + 90000;
      const compOf = () => conn.peerTable.getComponent(${sysid}, 1);
      while (Date.now() < deadline) {
        const c = compOf();
        if (c?.home && c.home.lat != null) break;
        await sleep(500);
      }
      if (!compOf()?.home || compOf().home.lat == null) {
        throw new Error('AP-${sysid} HOME_POSITION not seen after fleet restart');
      }
    `,
    100000
  );
}

/**
 * Provision MAVLink2 signing on the standalone companion ArduCopter (sysid 20)
 * and prove it can arm before example 12 deploys. Uses the same sha256(passphrase)
 * key Mission Planner / node-mavlink derive from SITL_SIGNING_PASSPHRASE.
 *
 * Vehicle must be disarmed (ArduPilot refuses SETUP_SIGNING while armed).
 * Message shape is { name, fields } — flat fields serialize as an empty payload.
 */
async function setupCompanionSigning() {
  console.log('  SETUP_SIGNING + arm-ready on companion AP sysid 20…');
  // Compute key in-process so the spliced script only carries hex.
  const { MavLinkPacketSignature } = require('node-mavlink');
  const keyHex = MavLinkPacketSignature.key(SITL_SIGNING_PASSPHRASE).toString('hex');
  runApControlScript(
    `
      const { timestampFromMs } = require(${JSON.stringify(path.join(ROOT, 'lib/connection'))});
      const key = Buffer.from(${JSON.stringify(keyHex)}, 'hex');
      const t = { sysid: 20, compid: 1 };
      const deadline = Date.now() + 90000;
      const compOf = () => conn.peerTable.getComponent(20, 1);
      while (!compOf()?.primaryEndpoint && Date.now() < deadline) await sleep(500);
      if (!compOf()?.primaryEndpoint) throw new Error('companion AP-20 peer not learned');
      // Arm-ready MUST run before SETUP_SIGNING. Once the key is loaded,
      // ArduPilot rejects unsigned commands on non-COMM_0 links — and SITL's
      // udpclient path is not guaranteed to be COMM_0 — so an unsigned probe
      // arm after SETUP_SIGNING hangs until the budget dies.
      ${armReadySource([20], 90000)}
      if (compOf()?.armed) {
        conn.send(buildCommandLong(400, 20, 1, [0, 21196, 0, 0, 0, 0, 0], 0), { band: BAND.CONTROL, target: t });
        await sleep(800);
      }
      conn.send({
        name: 'SETUP_SIGNING',
        fields: {
          target_system: 20,
          target_component: 1,
          secret_key: Array.from(key),
          initial_timestamp: BigInt(timestampFromMs(Date.now())),
        },
      }, { band: BAND.CONTROL, target: t });
      await sleep(1500);
    `,
    130000,
    { bindPort: 14540, remotePort: 14541, targetSystem: 20 }
  );
}

async function setApGuided(sysid = 1) {
  // After fleet restart:
  // 1) SET_MODE needs a learned peer endpoint (pre-peer fallback never arrives).
  // 2) GUIDED while disarmed succeeds in seconds; arm stays DENIED until EKF
  //    has a position estimate (~30–40 s cold — "Need Position Estimate").
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
      ${armReadySource([sysid], 120000)}
      if (compOf()?.flightMode !== 4) {
        conn.send(buildCommandLong(176, ${sysid}, 1, [1, 4, 0, 0, 0, 0, 0], 0), { band: BAND.CONTROL, target: t });
        await sleep(800);
      }
    `,
    // Two 120 s budgets back to back (GUIDED, then the arm sweep). The process
    // timeout has to sit above their sum, or a slow-but-recoverable vehicle is
    // killed instead of reporting which of the two it failed.
    270000
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
    await waitApArmReady([1, 2, 3, 4, 5]);
  }
  if (kind === 'ap-arm-ready-2') {
    await waitApArmReady([2]);
  }
  if (kind === 'ap-home-ready') {
    await waitApHomeReady(1);
  }
  if (kind === 'ap-signing-companion-20') {
    await setupCompanionSigning();
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
  const credentials = signingCredentialsForFlows(flows);
  const deployBody =
    Object.keys(credentials).length > 0 ? { flows, credentials } : { flows };
  const deploy = await req('POST', '/flows', deployBody, { 'Node-RED-Deployment-Type': 'full' });
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
