'use strict';

/**
 * Deploy each examples/sitl/*.json into the lab Node-RED (host :1880), fire
 * injects, scrape debug/error lines, and write a JSON report.
 *
 * Before each non-SKIP example, selectively docker-restarts the vehicles that
 * example needs cold (PROFILE.restart — not Node-RED). Force-disarm alone
 * leaves AGL and makes NAV_TAKEOFF DENIED. Examples are numbered in run order
 * (none → ap-* → px4-* → ap-fleet → fleet) so restart:none batches avoid
 * paying settle between param/companion/payload stories. See sitl/AGENTS.md.
 *
 * After injects, PROFILE.waitMs is a max wait: the harness polls Node-RED
 * logs and early-exits on specialized verdictFrom PASS (optional readyWhen;
 * generic "results: …" PASS does not early-exit).
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
const { waitUntilReady } = require('./lib/wait-until-ready');
const {
  ALL_VEHICLES,
  containersForRestart,
  px4ContainersIn,
} = require('./lib/suite-schedule');

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

/**
 * Per-example harness profile.
 * `waitMs` is a hard ceiling (max wait after injects), not a fixed sleep —
 * the suite polls logs and early-exits on specialized PASS (or optional
 * `readyWhen`). See sitl/lib/wait-until-ready.js.
 *
 * `restart` selects which containers docker-restart before the example
 * (`none` | `ap-1` | `ap-2` | `ap-12` | `ap-fleet` | `px4-1` | `fleet`).
 * Examples are numbered in run order: none → ap-* → px4-* → ap-fleet → fleet.
 *
 * @type {Record<string, {restart?: string, waitMs: number, expect: string, notes?: string, prep?: string, readyWhen?: Function, injectGapMs?: number, skip?: boolean}>}
 */
const PROFILE = {
  '20-completion-takeoff': {
    restart: 'ap-1',
    waitMs: 45000,
    expect: 'takeoff complete / altitude reached',
    prep: 'ap-guided-1',
  },
  '21-completion-timeout': {
    restart: 'ap-1',
    waitMs: 35000,
    expect: 'completion timeout after accepted takeoff',
    prep: 'ap-guided-1',
  },
  '28-temporarily-rejected': {
    restart: 'px4-1',
    waitMs: 20000,
    expect: 'TEMPORARILY_REJECTED retried until exhausted (PX4 packed mode)',
    prep: 'px4-mode-ready',
    notes:
      'AP cold-arm returns FAILED(4), not (1); example uses PX4 DO_SET_MODE param2=196608 which stably returns TEMPORARILY_REJECTED',
  },
  '36-mode-tables': {
    restart: 'fleet',
    waitMs: 20000,
    expect: 'AP GUIDED + PX4 mode set accepted',
    prep: 'px4-mode-ready',
  },
  '01-px4-param-union': {
    restart: 'none',
    waitMs: 15000,
    expect: 'param set+read echo confirmed',
  },
  '02-mission-fence-rally': {
    restart: 'none',
    waitMs: 40000,
    expect: 'AP mission/fence/rally ok; PX4 fence fails loud',
  },
  '03-mission-failloud': {
    restart: 'none',
    waitMs: 45000,
    expect: 'good upload ok; bad upload fails; good plan survives',
  },
  '31-fanout-sequential-five': {
    restart: 'ap-fleet',
    waitMs: 25000,
    expect: 'dry-run then live sequential arm ×5',
    // delivery=confirm: the first DENIED fails the aggregate, so every one of
    // the five has to be armable before the example runs.
    prep: 'ap-arm-ready-fleet',
  },
  '32-fanout-member-expires': {
    restart: 'ap-fleet',
    waitMs: 20000,
    expect: 'aggregate reports one failed after mid-run kill',
    // The mid-run kill is afterInjectHook, keyed on the file — `kill-ap-3-mid`
    // was a label prep() never handled. The story needs four to arm and one to
    // fail; an unsettled EKF fails all five and the verdict means nothing.
    prep: 'ap-arm-ready-fleet',
  },
  '37-dual-stack-ten': {
    restart: 'fleet',
    waitMs: 25000,
    expect: 'broadcast arm AP 1–5 and PX4 11–15',
    // No prep: delivery=send, so no ACK is waited on and no verdict turns on
    // whether anyone armed. Arm-ready here would cost ~40 s and change nothing.
  },
  '33-broadcast-vs-sequential': {
    restart: 'ap-fleet',
    waitMs: 30000,
    expect: 'sequential + broadcast arm confirmed',
    prep: 'ap-arm-ready-fleet',
    // The sequential half is five confirm-arms; POST /inject returns as soon as
    // the inject fires, not when the fan-out finishes. At the default 1.5 s gap
    // the broadcast half lands on top of it.
    injectGapMs: 12000,
  },
  '38-signing': {
    restart: 'fleet',
    waitMs: 15000,
    expect: 'signed arm accepted; trusted HEARTBEAT on companion 20',
    prep: 'ap-signing-companion-20',
    notes:
      'Lab passphrase hunter11 injected via Admin API credentials; harness SETUP_SIGNING on companion AP sysid 20',
  },
  '04-param-defs-live': {
    restart: 'none',
    waitMs: 20000,
    expect: 'read / set / list param defs against AP',
    // Let set echo-confirm finish before request-list floods PARAM_VALUE.
    injectGapMs: 8000,
  },
  '22-command-mission-basics': {
    restart: 'ap-12',
    waitMs: 40000,
    expect: 'arm sysid1; mission up/down sysid2',
    prep: 'ap-guided-1',
  },
  '05-companion-ap': {
    restart: 'none',
    waitMs: 10000,
    expect: 'NVF sent on companion 20',
  },
  '06-companion-px4': {
    restart: 'none',
    waitMs: 10000,
    expect: 'NVF sent on companion 21',
  },
  '29-int-carrier-goto': {
    restart: 'px4-1',
    waitMs: 55000,
    expect: 'arm+takeoff+INT goto accepted; ~150 m north',
    prep: 'px4-home-ready',
  },
  '07-int-local-vs-global': {
    restart: 'none',
    waitMs: 25000,
    expect: 'GLOBAL_INT accepted both stacks; LOCAL_NED denied AP / accepted PX4',
    prep: 'ap-home-ready',
  },
  '23-ap-int-carrier-goto': {
    restart: 'ap-1',
    waitMs: 55000,
    expect: 'AP arm+takeoff+INT goto accepted',
    prep: 'ap-guided-1',
  },
  '24-move-stream-stop': {
    restart: 'ap-1',
    waitMs: 25000,
    expect: 'move stream then zero-velocity stop',
    prep: 'ap-guided-1',
  },
  '08-param-echo-float32': {
    restart: 'none',
    waitMs: 35000,
    expect: 'AP + PX4 float32 param set/read echo',
  },
  '09-in-build-out': {
    restart: 'none',
    waitMs: 20000,
    expect: 'mavlink-in → build → out composition',
  },
  '25-profile-target-inherit': {
    restart: 'ap-2',
    waitMs: 20000,
    expect: 'command inherits profile target sysid 2',
    prep: 'ap-arm-ready-2',
  },
  '10-companion-receive': {
    restart: 'none',
    waitMs: 15000,
    expect: 'companion receive path sees vehicle traffic',
  },
  '19-tcp-connection': {
    restart: 'none',
    waitMs: 5000,
    expect: 'TCP template — skip unless SITL TCP exposed',
    notes: 'default Compose lab is UDP-only; skip without published :5760',
    skip: true,
  },
  '34-formation-basics': {
    restart: 'ap-fleet',
    waitMs: 140000,
    expect: 'formation line then circle succeeded ×5',
    prep: 'ap-arm-ready-fleet',
    notes: 'GUIDED→arm→takeoff→line→circle on AP 1–5; mavlink-formation confirm aggregates',
  },
  '35-lucy-in-the-sky': {
    restart: 'ap-fleet',
    waitMs: 260000,
    expect: 'Lucy sphere tumble then peel land',
    prep: 'ap-arm-ready-fleet',
    notes: 'takeoff→line spread→sphere→pitch 0/45/90/135/180→sequential land',
  },
  '11-param-read-by-index': {
    restart: 'none',
    waitMs: 45000,
    expect: 'AP list collect then PARAM_REQUEST_READ by param_index',
    notes: 'pick LOIT_SPEED_MS index from collect; assert empty param_id + index ≥ 0',
  },
  '12-param-fanout-set': {
    restart: 'none',
    waitMs: 40000,
    expect: 'PARAM_SET fan-out sequential confirm ×5',
    notes: 'build LOIT_SPEED_MS → fanout confirm on AP 1–5; no arm prep',
  },
  '13-px4-param-list': {
    restart: 'none',
    waitMs: 55000,
    expect: 'PX4 request-list collect with known ids',
    notes: 'mirrors SITL 13 list path on sysid 11; assert COM_RC_IN_MODE + MPC_XY_VEL_MAX',
  },
  '14-param-encoding-override': {
    restart: 'none',
    waitMs: 45000,
    expect: 'paramEncoding override matching + crossed timeout',
    // Matching sets finish in ~1 s; crossed AP bytewise waits the 5 s echo timeout.
    injectGapMs: 8000,
    notes:
      'matching overrides (PX4 bytewise / AP c-cast) succeed; crossed AP bytewise must echo-timeout (proves override rung)',
  },
  '15-param-echo-timeout': {
    restart: 'none',
    waitMs: 25000,
    expect: 'known param then unknown WPNAV_SPEED echo timeout',
    injectGapMs: 3000,
    notes:
      'LOIT_SPEED_MS confirm proves AP-1 reachable; then missing WPNAV_SPEED must timed-out / echo timeout',
  },
  '16-payload-gimbal-legacy': {
    restart: 'none',
    waitMs: 35000,
    expect: 'AP-31 legacy gimbal aim mode ROI accepted',
    injectGapMs: 2500,
    notes: 'sysid 31 / 14570 — aim + set-mode + roi-set + roi-clear confirm',
  },
  '17-payload-camera': {
    restart: 'none',
    waitMs: 35000,
    expect: 'AP-31 camera photo accepted video denied',
    injectGapMs: 2500,
    notes: 'CAM1_TYPE=1 stills ACCEPTED; VIDEO_* DENIED on this SITL stack',
  },
  '18-payload-gimbal-manager': {
    restart: 'none',
    waitMs: 15000,
    expect: 'AP-31 gimbal manager aim sent unconfirmed',
    notes: 'delivery=send; no COMMAND_ACK / no manager telemetry on Copter-4.7.0 --gimbal',
  },
  '26-peer-table-inflight': {
    restart: 'ap-1',
    waitMs: 20000,
    expect: 'peer-table snapshot armed+position+gps while airborne',
    prep: 'ap-guided-1',
    // Start flight (stream request + takeoff complete + 8 s move) then Snapshot.
    injectGapMs: 70000,
    notes:
      'Flow-level State snapshot after takeoff+move; hard §8 field asserts in sitl/measure-peer-table.js',
  },
  '27-move-reposition-carrier': {
    restart: 'ap-1',
    waitMs: 55000,
    expect: 'Move carrier=reposition goto accepted; yaw 90 deg turns east',
    prep: 'ap-guided-1',
    notes:
      'Same goto as 23 through mavlink-move instead of mavlink-command — carrier is the only variable. Measures: ACK reaches output 1 with resultCode 0; param4 yaw is radians (90 deg must end EAST, not some wrapped heading); blank speed/radius encode the -1/0 sentinels. CHANGE_MODE off — without-GUIDED and CHANGE_MODE are separate runs.',
  },
  '30-px4-move-reposition': {
    restart: 'px4-1',
    waitMs: 55000,
    expect: 'PX4 Move reposition: goto settles; result recorded',
    prep: 'px4-home-ready',
    notes:
      "PX4 twin of 27 — #239's last acceptance box. CHANGE_MODE on: the shape 29 measured " +
      'accepted via mavlink-command, so the carrier is the only variable. What this run expects ' +
      'is that PX4 answers, not what it answers: accept and denial are both anticipated and both ' +
      'PASS — a denial is a measurement, never a harness FAIL. No ACK at all measures nothing and ' +
      'is FAIL (timeout, or a send that never reached the wire). Once §14 records the answer this ' +
      'tightens to assert it, the way 17 requires video DENIED. If accepted: yaw 90 must end EAST.',
  },
  // ── Throwaway CHANGE_MODE probes (delete with 39/40 once §14 records them) ──
  //
  // 27 and 30 did not run the same experiment: 27 was AP pre-switched into
  // GUIDED with the flag OFF, 30 was PX4 with no mode arrangement and the flag
  // ON. Each stack was tested only in the configuration expected to work for
  // it, so "both firmwares answer the same way" rests on two different
  // experiments. These two fill the opposite cells. Both are open questions, so
  // both use the `silence is a result` contract — see verdictFrom.
  '39-ap-reposition-changemode': {
    restart: 'ap-1',
    waitMs: 60000,
    expect: 'AP Move reposition from LOITER, CHANGE_MODE on: silence is a result',
    prep: 'ap-guided-1',
    notes:
      'Inverse of 27. Source hypothesis (ArduCopter handle_command_int_do_reposition): not in ' +
      'guided AND flag clear returns MAV_RESULT_DENIED, so with the flag set it should ACCEPT and ' +
      'switch itself into GUIDED. Deliberately asserts no heading — the same handler calls ' +
      'set_destination(loc, false, 0, false, 0), so Copter ignores param4 for DO_REPOSITION and ' +
      "27's \"yaw 90 turns east\" cannot hold (ArduPlane does read it, for loiter direction).",
  },
  '40-px4-reposition-no-changemode': {
    restart: 'px4-1',
    waitMs: 60000,
    expect: 'PX4 Move reposition from POSCTL, CHANGE_MODE off: silence is a result',
    prep: 'px4-home-ready',
    notes:
      'Inverse of 30. Source hypothesis (PX4 Navigator::run): the setpoint applies only if the ' +
      'CHANGE_MODE bit is set OR nav_state is already AUTO_LOITER, and only while armed. PX4 ' +
      'settles into AUTO_LOITER by itself once a takeoff completes — the very state that satisfies ' +
      'the no-flag path — so the cell is only reachable before the climb finishes. Attempt 1 tried ' +
      'to leave Hold via POSCTL and PX4 answered TEMPORARILY_REJECTED (resultCode 1, 3 retries, ' +
      '3.0 s): it refuses a stick-driven mode airborne with no RC, so the reposition never ran and ' +
      'the run correctly scored not-measured. This cut needs no mode change — mid-climb the ' +
      'nav_state is AUTO_TAKEOFF, already not AUTO_LOITER. MIS_TAKEOFF_ALT is raised to 40 m to ' +
      'widen that window from ~2 s to ~25 s; an explicit NAV_TAKEOFF altitude would not do, since ' +
      "PX4 reads param7 as AMSL and the lab's Zurich home is near 488 m.",
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
    // resultCode is the proof a COMMAND_ACK actually arrived: a terminal
    // MAV_RESULT carries its number, while a send that threw before the wire
    // (failInput) emits result 'failed' with no code at all. Both spell
    // `result: 'failed'`, and only this tells a measured denial from a
    // measurement that never happened. Accepted is 0, so never test it for
    // truthiness.
    const resultCode = (text.match(/resultCode:\s*(-?\d+|null)/) || [])[1];
    debug.push({
      tag: b.tag,
      result: result || null,
      command: command || null,
      detail: detail || null,
      resultCode: resultCode === undefined || resultCode === 'null' ? null : Number(resultCode),
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
  // SITL 02: AP mission + fence + rally must succeed; PX4 fence must fail gated.
  // The old "fails loud" branch PASSed on *any* failure — including AP empty
  // uploads — once the expected PX4 gate fired (false PASS on phase:empty).
  if (/AP mission\/fence\/rally ok|PX4 fence fails loud/i.test(expect)) {
    const lastByTag = new Map();
    for (const d of summary.debug) {
      if (d.tag && d.result) lastByTag.set(d.tag, d);
    }
    const apMission = lastByTag.get('debug:mission status');
    const apFence = lastByTag.get('debug:fence status');
    const apRally = lastByTag.get('debug:rally status');
    const px4Fence = lastByTag.get('debug:px4 fence status');
    const apOk = [apMission, apFence, apRally].every((d) => d && d.result === 'succeeded');
    const px4Gated =
      !!px4Fence &&
      px4Fence.result === 'failed' &&
      (/does not support fence/i.test(px4Fence.excerpt || '') ||
        /phase:\s*'gated'/i.test(px4Fence.excerpt || '') ||
        /does not support fence/i.test(log));
    if (apOk && px4Gated) {
      return { status: 'PASS', reason: 'AP mission/fence/rally ok; PX4 fence fails loud' };
    }
    if (!apOk) {
      const parts = [
        `mission=${apMission?.result || 'missing'}`,
        `fence=${apFence?.result || 'missing'}`,
        `rally=${apRally?.result || 'missing'}`,
      ];
      return { status: 'FAIL', reason: `AP uploads incomplete (${parts.join(', ')})` };
    }
    return {
      status: 'FAIL',
      reason: `PX4 fence gate missing (px4=${px4Fence?.result || 'missing'})`,
    };
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
    // Key on the goto's OWN record, not any accepted in the flow: the arm ack
    // satisfied results.includes('accepted') and the old log co-condition
    // matched the debug node's *name*, so a timed-out or denied goto could
    // classify PASS off the arm alone (#267). Both 23 and 29 expose a
    // `goto status` debug wired to the goto command's status output.
    const gotoRecord = summary.debug.find((d) => /goto status/i.test(d.tag) && d.result);
    if (gotoRecord) {
      return gotoRecord.result === 'accepted'
        ? { status: 'PASS', reason: 'INT goto accepted' }
        : { status: 'FAIL', reason: `INT goto ${gotoRecord.result}` };
    }
    // No goto record: the example never exercised its subject, so it failed to
    // test the thing — FAIL, not a half-credit PARTIAL. Never fall through: the
    // generic tail would PASS on the arm/takeoff accepteds, the exact fiction
    // this branch existed to avoid. Safe mid-poll — waitUntilReady early-exits
    // on specialized PASS only, so this keeps polling and the deadline decides.
    return { status: 'FAIL', reason: 'INT goto never settled — not measured' };
  }
  if (/carrier=reposition|Move reposition/i.test(expect)) {
    // #267 again, one carrier over: 27/30 send the same goto through
    // mavlink-move, and their expect strings matched no branch, so the arm and
    // takeoff accepteds satisfied the generic tail. A Move that never emitted a
    // status record classified PASS off records that say nothing about the
    // reposition — the fiction #239's acceptance box cannot afford. Key on the
    // Move's own `reposition status` debug, as 23/29 key on `goto status`.
    const repositionRecord = summary.debug.find(
      (d) => /reposition status/i.test(d.tag) && d.result
    );
    if (!repositionRecord) {
      // Did we test the thing? No — so we failed to test it. Not PARTIAL:
      // an example that never exercised its subject has failed at its job,
      // whatever the vehicle would have said. Safe mid-poll — waitUntilReady
      // early-exits on specialized PASS only, so a FAIL here keeps polling
      // and the deadline recomputes the final verdict.
      return { status: 'FAIL', reason: 'Move reposition never settled — not measured' };
    }
    // mavlink-move does NOT speak mavlink-command's status vocabulary, and
    // keying these examples on the Command words was wrong in both directions:
    // an accepted reposition is published by completeResult as result
    // 'succeeded' (detail 'accepted'), so 27 could never pass; a lost ack is
    // 'timeout', not 'timed-out', so 30 fell through to PASS on the very
    // silence the branch exists to catch. 23/29 read 'accepted' because
    // mavlink-command emits exactly that — the two families differ.
    const accepted = repositionRecord.result === 'succeeded';
    // A terminal MAV_RESULT and a send that threw both spell result 'failed';
    // only the ACK carries a resultCode. ACCEPTED is 0, so compare to null.
    const vehicleAnswered = accepted ||
      (repositionRecord.result === 'failed' && repositionRecord.resultCode !== null);
    // The two contracts differ and the expect strings carry the difference. 30
    // is a measurement, so what it expects is that PX4 *answers* — not what the
    // answer is. An accept and a denial are both anticipated outcomes of the
    // open question (#239), so neither is a surprise and both pass: a denial is
    // a measurement, never a harness FAIL. What fails is no answer at all —
    // a timeout, or a send that never reached the wire, measures nothing. Once
    // §14 records what PX4 answers, this tightens to assert that specific
    // result, the way 17 requires video DENIED.
    // Throwaway 39/40 (delete with the examples). Same measurement contract as
    // 30, one cell wider: for the CHANGE_MODE probes "does the firmware answer
    // at all?" is *part of* the open question, so a timeout is a finding — PX4
    // dropping a flag-clear reposition without a word is exactly the shape the
    // source predicts. Silence still is not a blank cheque: a send that never
    // reached the wire spells result 'failed' with no resultCode, and that
    // measures nothing on any run.
    if (/silence is a result/i.test(expect)) {
      if (repositionRecord.result === 'failed' && repositionRecord.resultCode === null) {
        return {
          status: 'FAIL',
          reason: `Move reposition ${repositionRecord.detail || 'never reached the wire'} — nothing measured`,
        };
      }
      const answer = accepted
        ? 'accepted'
        : repositionRecord.result === 'timeout'
          ? 'no ACK — silently dropped'
          : `${repositionRecord.detail || 'denied'} (${repositionRecord.resultCode})`;
      return { status: 'PASS', reason: `Move reposition ${answer} (measured)` };
    }
    if (/result recorded/i.test(expect)) {
      if (!vehicleAnswered) {
        return {
          status: 'FAIL',
          reason: `PX4 Move reposition ${repositionRecord.result} — no ACK, nothing measured`,
        };
      }
      return {
        status: 'PASS',
        reason: `PX4 Move reposition ${accepted ? 'accepted' : repositionRecord.detail || 'denied'} (measured)`,
      };
    }
    return accepted
      ? { status: 'PASS', reason: 'Move reposition accepted' }
      : {
        status: 'FAIL',
        reason: `Move reposition ${repositionRecord.detail || repositionRecord.result}`,
      };
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
  if (/param defs against AP/i.test(expect)) {
    // Key on this example's own debug tags — the rolling docker-log window
    // often still holds example 03's validate failure, which used to force a
    // false PARTIAL after list-complete succeeded.
    const setOk = summary.debug.some(
      (d) => /set status/i.test(d.tag) && d.result === 'succeeded' &&
        /echo-confirmed/i.test(d.detail || d.excerpt || '')
    );
    const listOk = summary.debug.some(
      (d) => /list status/i.test(d.tag) && d.result === 'succeeded' &&
        /list-complete/i.test(d.detail || d.excerpt || '')
    );
    if (setOk && listOk) {
      return { status: 'PASS', reason: 'param defs: set echo-confirmed + list-complete' };
    }
    if (setOk || listOk) {
      return {
        status: 'PARTIAL',
        reason: `param defs incomplete: set=${setOk} list=${listOk}`,
      };
    }
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
 * Joke lab signing passphrase for example 38 (signing). Intentionally not a secret —
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
    // Prefer the trailing 800 chars — Node deprecation banners often eat the
    // front of stdout/stderr and used to hide the real throw message.
    const tail = out.length > 800 ? out.slice(-800) : out;
    throw new Error(`AP control script failed (exit ${r.status}): ${tail}`);
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
const VEHICLE_CONTAINERS = ALL_VEHICLES;

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
 * Under selective restart (`restart: none`) this helper often attaches after
 * the vehicle's one-shot HOME_POSITION publication has already passed, so a
 * passive peer-table wait never sees it. Actively request home (same shape as
 * sitl/measure-peer-table.js): MAV_CMD_GET_HOME_POSITION (410) plus
 * REQUEST_MESSAGE HOME_POSITION (242).
 *
 * @param {number} [sysid]
 */
async function waitApHomeReady(sysid = 1) {
  console.log(`  waiting for AP-${sysid} HOME_POSITION…`);
  runApControlScript(
    `
      const deadline = Date.now() + 90000;
      const t = { sysid: ${sysid}, compid: 1 };
      const compOf = () => conn.peerTable.getComponent(${sysid}, 1);
      const requestHome = () => {
        conn.send(buildCommandLong(410, ${sysid}, 1, [0, 0, 0, 0, 0, 0, 0], 0), {
          band: BAND.CONTROL, target: t,
        });
        conn.send(buildCommandLong(512, ${sysid}, 1, [242, 0, 0, 0, 0, 0, 0], 0), {
          band: BAND.CONTROL, target: t,
        });
      };
      while (!compOf()?.primaryEndpoint && Date.now() < deadline) await sleep(500);
      if (!compOf()?.primaryEndpoint) {
        throw new Error('AP-${sysid} peer not learned before HOME_POSITION wait');
      }
      let nextRequest = 0;
      while (Date.now() < deadline) {
        const c = compOf();
        if (c && c.home && c.home.lat != null) break;
        if (Date.now() >= nextRequest) {
          requestHome();
          nextRequest = Date.now() + 2000;
        }
        await sleep(500);
      }
      const home = compOf()?.home;
      if (!home || home.lat == null) {
        throw new Error(
          'AP-${sysid} HOME_POSITION not seen after GET_HOME_POSITION / REQUEST_MESSAGE(242)'
        );
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
 * Reset SITL vehicles before an example. Force-disarm does not clear AGL;
 * ArduCopter then DENY's NAV_TAKEOFF when still ~airborne from a prior flight.
 *
 * @param {string[]} [containers]  subset to restart; empty → skip (restart: none)
 */
async function restartVehicleFleet(containers = VEHICLE_CONTAINERS) {
  if (!containers.length) {
    console.log('  skip vehicle restart (restart: none)');
    return;
  }
  const label =
    containers.length === VEHICLE_CONTAINERS.length
      ? 'vehicle fleet'
      : containers.join(' ');
  console.log(`  restarting ${label}…`);
  const r = sh(
    `for c in ${containers.join(' ')}; do docker restart "$c" >/dev/null & done; wait`,
    180000
  );
  if (r.code !== 0) {
    console.warn(`  fleet restart exit ${r.code}: ${r.out.slice(0, 200)}`);
  }
  await sleep(FLEET_SETTLE_MS);
  const px4 = px4ContainersIn(containers);
  if (px4.length) {
    applyPx4LabHelpers(px4);
    await sleep(1500);
  }
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
  if (fileBase === '32-fanout-member-expires') {
    await sleep(200);
    console.log('  killing nrc-ap-3 mid-run…');
    sh('docker stop nrc-ap-3 >/dev/null');
  }
}

async function cleanupAfter(fileBase) {
  // Next example's selective restart is the real altitude/arm reset. Only recover
  // containers the example intentionally stopped so docker restart can proceed.
  if (fileBase === '32-fanout-member-expires') {
    console.log('  ensuring nrc-ap-3 is startable for next fleet restart…');
    sh('docker start nrc-ap-3 >/dev/null 2>&1 || true');
    await sleep(2000);
  }
}

/** True after any restart this process (including a one-shot prime for restart:none). */
let suiteRestartPrimed = false;

/**
 * Selective restart. `restart: none` skips once the suite has been primed;
 * the first none primes the full fleet so param/companion examples start cold.
 *
 * @param {{ restart?: string }} profile
 */
async function restartForProfile(profile) {
  const containers = containersForRestart(profile.restart);
  if (containers.length === 0) {
    if (!suiteRestartPrimed) {
      console.log('  priming vehicle fleet (first restart:none)…');
      await restartVehicleFleet(VEHICLE_CONTAINERS);
      suiteRestartPrimed = true;
      return;
    }
    await restartVehicleFleet([]);
    return;
  }
  await restartVehicleFleet(containers);
  suiteRestartPrimed = true;
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
  // Isolation: docker-restart only the vehicles this example needs cold.
  // Node-RED stays up (UDP binds cleared later).
  await restartForProfile(profile);
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

  // Event-driven: poll until specialized PASS (or readyWhen), capped by waitMs.
  // Cover the whole example (prep gaps + injectGapMs + wait), not only waitMs —
  // otherwise long multi-inject stories (e.g. 13) scrape an empty idle window.
  const pollMs =
    Number(process.env.SITL_READY_POLL_MS) > 0
      ? Number(process.env.SITL_READY_POLL_MS)
      : 500;
  const waited = await waitUntilReady({
    waitMs: profile.waitMs,
    pollMs,
    readyWhen: profile.readyWhen,
    snapshot: () => {
      const log = nrLogSince(Math.max(15, Math.floor(Date.now() / 1000) - mark + 5));
      return { summary: summarizeBlocks(extractDebugBlocks(log)), log };
    },
    verdict: (summary, log) => verdictFrom(profile, summary, log),
  });
  console.log(
    waited.ready
      ? `  ready after ${(waited.waitedMs / 1000).toFixed(1)}s`
      : `  waitMs timeout after ${(waited.waitedMs / 1000).toFixed(1)}s`
  );
  const verdict = waited.verdict;
  const summary = waited.summary;

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

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

// For tests only: the wait gate's generic-PASS exclusion keys on the reason
// string verdictFrom's fallback tail emits (#256). That contract spans two
// files, so the pin has to drive the real function, not a stub of its output.
module.exports = { PROFILE, verdictFrom };
