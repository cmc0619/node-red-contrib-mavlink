'use strict';

/**
 * Exercise System-node engines against AP sysid 1 on the lab:
 *   1. backup  — ParamBackup
 *   2. restore — ParamRestore of that capture
 *   3. log pull — LOG_REQUEST_LIST + LOG_REQUEST_DATA
 *   4. file pull — MAVFTP list + download
 *
 * Usage: node sitl/measure-system-ops.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { Connection } = require('../lib/connection/runtime');
const { BAND } = require('../lib/connection/bands');
const { loadBundled } = require('../lib/metadata/bundled');
const { buildCommandLong } = require('../lib/command/carrier');
const { createMachine } = require('../lib/log');
const { FtpMachine } = require('../lib/ftp');
const { ParamBackup, ParamRestore } = require('../lib/param/backup');

// Private mkdtemp directory, mode 0600 — the same shape every other measure
// script in this tree uses (measure-peer-table, measure-swarm-mcast, …).
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'nrc-system-ops-'));
const ARTIFACT_RESULTS = path.join(WORK, 'system-ops-results.json');
const ARTIFACT_LOG = path.join(WORK, 'system-ops-log.bin');
const ARTIFACT_FILE = path.join(WORK, 'system-ops-file.bin');

const SYSID = 1;
const COMPID = 1;
const TARGET = { sysid: SYSID, compid: COMPID };
const TIMEOUT_MS = 25_000;
const MAX_RETRIES = 3;
const LOG_PULL_CAP = 128 * 1024;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value, (_k, v) => {
    if (typeof v === 'bigint') return v.toString();
    if (Buffer.isBuffer(v)) return { type: 'Buffer', byteLength: v.length };
    return v;
  }));
}

function note(results, name, ok, detail, extra) {
  const row = jsonSafe({ name, ok, detail, ...(extra || {}) });
  results.push(row);
  console.log(JSON.stringify(row));
  return row;
}

function docker(...args) {
  const r = spawnSync('docker', args, { encoding: 'utf8' });
  return {
    ok: r.status === 0,
    status: r.status,
    out: `${r.stdout || ''}${r.stderr || ''}`.slice(0, 800),
  };
}

function makeConn() {
  const bundle = loadBundled('ardupilotmega');
  const resolveIdentity = (i) => ({ identityId: i.defaultIdentityId, source: 'default' });
  return new Connection(
    {
      transport: {
        mode: 'udp',
        bindAddress: '0.0.0.0',
        bindPort: 14550,
        remoteAddress: '127.0.0.1',
        remotePort: 14550,
      },
      vehicle: {
        targetSystem: SYSID,
        targetComponent: COMPID,
        bundle,
        firmware: 'ardupilot',
        autopilot: 3,
      },
      identities: [{
        id: 'gcs',
        sysid: 255,
        compid: 190,
        heartbeat: {
          type: 6, autopilot: 8, systemStatus: 4,
          baseMode: 0, customMode: 0, mavlinkVersion: 3,
        },
        heartbeatIntervalMs: 500,
      }],
      defaultIdentityId: 'gcs',
      boundIdentityIds: ['gcs'],
      signing: {
        linkId: 0, signOutbound: false, acceptInvalid: false, hasKey: false,
      },
      heartbeat: { staleMs: 5000, expireMs: 15000 },
    },
    { resolveIdentity, logger: { info() {}, warn() {}, error() {} } }
  );
}

function sendCmd(conn, command, params) {
  conn.send(buildCommandLong(command, SYSID, COMPID, params, 0), {
    band: BAND.CONTROL,
    target: TARGET,
  });
}

function engineOpts(conn, extra = {}) {
  const source = conn.resolveSourceIds('gcs');
  return {
    send: (message) => conn.send(message, {
      band: BAND.BULK,
      target: TARGET,
      identityId: 'gcs',
    }),
    subscribe: (filter, handler) => conn.subscribe(filter, handler),
    target: TARGET,
    source,
    sourceIds: source,
    timeoutMs: TIMEOUT_MS,
    maxRetries: MAX_RETRIES,
    onProgress() {},
    encoding: 'c-cast',
    ...extra,
  };
}

async function waitPeer(conn, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const c = conn.peerTable.getComponent(SYSID, COMPID);
    if (c && c.primaryEndpoint) return c;
    await sleep(200);
  }
  throw new Error(`peer ${SYSID} not learned`);
}

function requestTelemetry(conn) {
  // 66 is the REQUEST_DATA_STREAM *message* id, not a MAV_CMD, so this loop
  // asks for nothing — it is carried here only to match the five sibling
  // measure scripts, which all send it and all follow it with the interval
  // requests below. SET_MESSAGE_INTERVAL (511) is the half that works, and
  // 33 (GLOBAL_POSITION_INT) is what the climb check reads.
  for (const streamId of [0, 1, 2, 3, 4, 6, 10, 11, 12]) {
    sendCmd(conn, 66, [streamId, 100000, 1, 0, 0, 0, 0]);
  }
  for (const [id, us] of [[1, 500000], [24, 200000], [30, 100000], [32, 100000], [33, 100000]]) {
    sendCmd(conn, 511, [id, us, 0, 0, 0, 0, 0]);
  }
}

async function briefFlight(conn) {
  requestTelemetry(conn);
  await sleep(1000);
  const modeDeadline = Date.now() + 90000;
  while (Date.now() < modeDeadline) {
    const c = conn.peerTable.getComponent(SYSID, COMPID);
    if (c && c.flightMode === 4) break;
    if (c && c.armed) {
      sendCmd(conn, 400, [0, 21196, 0, 0, 0, 0, 0]);
      await sleep(500);
    }
    sendCmd(conn, 176, [1, 4, 0, 0, 0, 0, 0]);
    await sleep(1000);
  }
  if (conn.peerTable.getComponent(SYSID, COMPID)?.flightMode !== 4) {
    throw new Error('AP did not enter GUIDED');
  }
  const armDeadline = Date.now() + 90000;
  while (Date.now() < armDeadline) {
    if (conn.peerTable.getComponent(SYSID, COMPID)?.armed) break;
    sendCmd(conn, 400, [1, 0, 0, 0, 0, 0, 0]);
    await sleep(2000);
  }
  if (!conn.peerTable.getComponent(SYSID, COMPID)?.armed) {
    throw new Error('AP did not arm');
  }
  sendCmd(conn, 22, [0, 0, 0, 0, 0, 0, 5]);
  const climbDeadline = Date.now() + 25000;
  let climbed = false;
  while (Date.now() < climbDeadline) {
    const rel = conn.peerTable.getComponent(SYSID, COMPID)?.position?.relativeAlt;
    if (rel != null && Number(rel) > 1500) {
      climbed = true;
      break;
    }
    await sleep(500);
  }
  // Disarm first either way, then fail: the mode and arm phases above both
  // throw when they miss, and a takeoff that never left the ground must not
  // record brief-flight as a pass.
  sendCmd(conn, 400, [0, 21196, 0, 0, 0, 0, 0]);
  await sleep(2500);
  if (!climbed) throw new Error('AP did not climb');
}

async function main() {
  const results = [];
  let paramBundle = null;

  console.log(`artifacts → ${WORK}`);
  note(results, 'restart-ap-1', docker('restart', 'nrc-ap-1').ok, 'nrc-ap-1');
  await sleep(22000);

  const conn = makeConn();

  try {
    // start() belongs inside the guarded lifecycle: a terminal UDP failure has
    // to close the connection and land in the results file like any other
    // failure, not escape past the finally and leave the run unrecorded.
    await conn.start();
    await sleep(1500);

    await waitPeer(conn);
    note(results, 'peer', true, `sysid ${SYSID} learned`);

    try {
      await briefFlight(conn);
      note(results, 'brief-flight', true, 'GUIDED arm + climb + force-disarm');
    } catch (err) {
      note(results, 'brief-flight', false, String(err.message || err));
    }

    // 1) BACKUP
    {
      const t0 = Date.now();
      const outcome = await new ParamBackup(engineOpts(conn, {
        onProgress(u) {
          if (u.phase === 'param' && u.index % 250 === 0) {
            process.stderr.write(`  backup ${u.index}/${u.count}\r`);
          }
        },
      })).start();
      const n = Array.isArray(outcome.params) ? outcome.params.length : 0;
      const ok = outcome.result === 'succeeded' && n > 0;
      note(results, 'backup-parameters', ok,
        `${outcome.result}: ${n} params in ${Date.now() - t0} ms`,
        {
          result: outcome.result,
          paramCount: n,
          elapsedMs: Date.now() - t0,
          phase: outcome.phase,
          reason: outcome.reason,
        });
      if (ok) paramBundle = outcome.params;
    }

    // 2) RESTORE
    {
      if (!paramBundle) {
        note(results, 'restore-parameters', false, 'skipped — no backup');
      } else {
        const t0 = Date.now();
        const outcome = await new ParamRestore(engineOpts(conn, {
          params: paramBundle,
          onProgress(u) {
            if (u.phase === 'param' && u.index % 250 === 0) {
              process.stderr.write(`  restore ${u.index}\r`);
            }
          },
        })).start();
        note(results, 'restore-parameters', outcome.result === 'succeeded',
          `${outcome.result}: restored=${outcome.restored} in ${Date.now() - t0} ms`,
          {
            result: outcome.result,
            restored: outcome.restored,
            elapsedMs: Date.now() - t0,
            phase: outcome.phase,
            reason: outcome.reason,
          });
      }
    }

    // 3) LOG PULL
    {
      const listed = await createMachine('list', engineOpts(conn)).start();
      const entries = listed.entries || [];
      note(results, 'log-list', listed.result === 'succeeded' && entries.length > 0,
        `${listed.result}: ${entries.length} entries`,
        {
          result: listed.result,
          count: entries.length,
          entries: entries.map((e) => ({ id: e.id, size: e.size, timeUtc: e.timeUtc })),
        });

      if (listed.result === 'succeeded' && entries.length > 0) {
        const sorted = [...entries].sort((a, b) => b.id - a.id);
        const entry = sorted.find((e) => e.size > 0) || sorted[0];
        const sizeHint = Math.min(Number(entry.size) || LOG_PULL_CAP, LOG_PULL_CAP);
        const t0 = Date.now();
        const pulled = await createMachine('download', engineOpts(conn, {
          id: entry.id,
          size: sizeHint,
          timeoutMs: 90_000,
        })).start();
        const bytes = pulled.data ? pulled.data.length : 0;
        const ok = pulled.result === 'succeeded' && bytes > 0;
        note(results, 'log-pull', ok,
          `${pulled.result}: id=${entry.id} ${bytes} bytes (hint ${sizeHint}) in ${Date.now() - t0} ms`,
          {
            result: pulled.result,
            logId: entry.id,
            advertisedSize: entry.size,
            bytes,
            sizeHint,
            elapsedMs: Date.now() - t0,
            phase: pulled.phase,
            reason: pulled.reason,
          });
        if (ok) {
          fs.writeFileSync(ARTIFACT_LOG, pulled.data, { mode: 0o600 });
        }
      } else {
        note(results, 'log-pull', false, 'skipped — empty LOG_ENTRY list');
      }
    }

    // 4) FILE PULL — SITL @SYS/@PARAM virtual files often list but do not
    // open; prove MAVFTP with an upload then download of a real POSIX path.
    {
      const probePath = '/nrc-system-ops.txt';
      const probeBody = Buffer.from(`nrc-system-ops ${new Date().toISOString()}\n`);
      const up = await new FtpMachine('upload', engineOpts(conn, {
        path: probePath,
        data: probeBody,
        timeoutMs: 30_000,
      })).start();
      note(results, 'ftp-upload-probe', up.result === 'succeeded',
        `${up.result}: ${probePath} ${probeBody.length} bytes`,
        // A failed upload is not a failed run: it is the branch that sends the
        // measurement down the list-and-pull fallback below.
        { result: up.result, phase: up.phase, reason: up.reason, nonGating: true });

      if (up.result === 'succeeded') {
        const t0 = Date.now();
        const pulled = await new FtpMachine('download', engineOpts(conn, {
          path: probePath,
          timeoutMs: 30_000,
        })).start();
        const bytes = pulled.data ? pulled.data.length : 0;
        const ok = pulled.result === 'succeeded'
          && bytes > 0
          && Buffer.compare(pulled.data, probeBody) === 0;
        note(results, 'file-pull', ok,
          `${pulled.result}: ${probePath} ${bytes} bytes in ${Date.now() - t0} ms`,
          {
            result: pulled.result,
            path: probePath,
            bytes,
            elapsedMs: Date.now() - t0,
            phase: pulled.phase,
            reason: pulled.reason,
            roundTrip: ok,
          });
        if (ok) {
          fs.writeFileSync(ARTIFACT_FILE, pulled.data, { mode: 0o600 });
        }
      } else {
        // Fall back to listing a real directory and downloading one file.
        const roots = ['/logs', '/', '/APM'];
        let listedRoot = null;
        let listOutcome = null;
        for (const root of roots) {
          const outcome = await new FtpMachine('list', engineOpts(conn, {
            path: root,
            timeoutMs: 12_000,
          })).start();
          const count = (outcome.entries || []).length;
          note(results, `ftp-list-${root.replace(/[^A-Za-z0-9]+/g, '_') || 'root'}`,
            outcome.result === 'succeeded',
            `${outcome.result}: ${root} entries=${count}`,
            {
              result: outcome.result,
              path: root,
              count,
              sample: (outcome.entries || []).slice(0, 10),
              phase: outcome.phase,
              reason: outcome.reason,
              // This loop is a search for a root that exists; the roots that
              // do not are expected misses, not failures of the measurement.
              nonGating: true,
            });
          if (outcome.result === 'succeeded' && count > 0) {
            listedRoot = root;
            listOutcome = outcome;
            break;
          }
        }
        if (!listOutcome) {
          note(results, 'file-pull', false, 'upload failed and no FTP root listed');
        } else {
          const entries = listOutcome.entries || [];
          const files = entries.filter((e) => {
            const name = e.name || e.path || '';
            return Boolean(name)
              && name !== '.'
              && name !== '..'
              && !name.endsWith('/')
              && !e.isDir
              && !(e.type && /dir/i.test(String(e.type)));
          });
          const pick = files.find((e) => Number(e.size) > 0 && Number(e.size) < 64 * 1024)
            || files[0];
          if (!pick) {
            note(results, 'file-pull', false, `list ok at ${listedRoot} but no file row`, { entries });
          } else {
            const name = pick.name || pick.path;
            const remote = name.startsWith('/')
              ? name
              : `${String(listedRoot).replace(/\/$/, '')}/${name}`;
            const t0 = Date.now();
            const pulled = await new FtpMachine('download', engineOpts(conn, {
              path: remote,
              timeoutMs: 90_000,
            })).start();
            const bytes = pulled.data ? pulled.data.length : 0;
            const ok = pulled.result === 'succeeded' && bytes > 0;
            note(results, 'file-pull', ok,
              `${pulled.result}: ${remote} ${bytes} bytes in ${Date.now() - t0} ms`,
              {
                result: pulled.result,
                path: remote,
                bytes,
                elapsedMs: Date.now() - t0,
                phase: pulled.phase,
                reason: pulled.reason,
              });
            if (ok) {
              fs.writeFileSync(ARTIFACT_FILE, pulled.data, { mode: 0o600 });
            }
          }
        }
      }
    }
  } catch (err) {
    note(results, 'fatal', false, String(err?.message || err));
  } finally {
    await new Promise((resolve) => conn.close(() => resolve()));
  }

  const summary = {
    measuredAt: new Date().toISOString(),
    commit: spawnSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
    vehicle: 'nrc-ap-1',
    sysid: SYSID,
    results,
    ok: {
      backup: results.some((r) => r.name === 'backup-parameters' && r.ok),
      restore: results.some((r) => r.name === 'restore-parameters' && r.ok),
      logPull: results.some((r) => r.name === 'log-pull' && r.ok),
      filePull: results.some((r) => r.name === 'file-pull' && r.ok),
      // Everything else recorded false is a failed measurement, including the
      // ones no named gate above covers: a brief flight that never climbed, a
      // container that would not restart, and any 'fatal' thrown after the
      // last named gate already passed. A harness that reports success while
      // carrying an ok:false row is reporting a run that did not happen.
      noFailures: results.every((r) => r.ok || r.nonGating),
    },
  };
  fs.writeFileSync(ARTIFACT_RESULTS, JSON.stringify(summary, null, 2), { mode: 0o600 });
  console.log(`\nWrote ${ARTIFACT_RESULTS}`);
  console.log('summary', JSON.stringify(summary.ok));
  if (!Object.values(summary.ok).every(Boolean)) process.exitCode = 2;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
