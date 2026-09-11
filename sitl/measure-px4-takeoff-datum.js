#!/usr/bin/env node
'use strict';

/**
 * Measure PX4 NAV_TAKEOFF altitude datum (COMMAND_LONG + COMMAND_INT frame 3).
 *
 * Claim under test (source triage A4): PX4 treats param7 / INT z as AMSL on both
 * carriers with no frame conversion. At lab home (~584 m AMSL), a "10 m" takeoff
 * is already above that AMSL, so the vehicle does not climb and relative-frame
 * product completion waits out its timeout.
 *
 * Usage:
 *   node sitl/measure-px4-takeoff-datum.js
 *   node sitl/measure-px4-takeoff-datum.js --out /opt/cursor/artifacts/px4-takeoff-datum-results.json
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { Connection } = require('../lib/connection/runtime');
const { BAND } = require('../lib/connection/bands');
const { loadBundled } = require('../lib/metadata/bundled');
const {
  buildCommandLong,
  buildCommandInt,
  MAV_FRAME,
} = require('../lib/command/carrier');
const { waitForCompletion } = require('../lib/command/completion');
const { COMPLETION } = require('../lib/command/presets');

const CONTAINER = 'nrc-px4-11';
const SYSID = 11;
const COMPID = 1;
const REMOTE_PORT = Number(process.env.SITL_PX4_PORT || 14560);
const TAKEOFF_ALT_M = 10;
const COMPLETION_MS = 25_000;
const NAV_TAKEOFF = 22;
const ARM_DISARM = 400;
const REQUEST_DATA_STREAM = 66;
const SET_MESSAGE_INTERVAL = 511;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function docker(...args) {
  const r = spawnSync('docker', args, { encoding: 'utf8' });
  return { code: r.status || 0, out: (r.stdout || '') + (r.stderr || '') };
}

function restartVehicle() {
  console.log(`  restart ${CONTAINER}…`);
  const r = docker('restart', CONTAINER);
  if (r.code !== 0) throw new Error(`docker restart failed: ${r.out}`);
  spawnSync('sleep', ['28']);
}

function prepPx4LabParams() {
  const script = [
    'cd /opt/px4',
    './bin/px4-param set MAV_0_BROADCAST 1',
    './bin/px4-param set COM_RCL_EXCEPT 7',
    './bin/px4-param set COM_ARM_MAG_STR 0',
    './bin/px4-param set COM_DISARM_PRFLT -1',
    './bin/px4-param set COM_DISARM_LAND -1',
    './bin/px4-param set CBRK_SUPPLY_CHK 894281',
    './bin/px4-param set COM_ARM_WO_GPS 1',
  ].join(' && ');
  const r = spawnSync('docker', ['exec', CONTAINER, 'sh', '-lc', script], {
    encoding: 'utf8',
  });
  return { ok: r.status === 0, status: r.status, stderr: (r.stderr || '').slice(0, 500) };
}

function makeConn(bindPort) {
  const bundle = loadBundled('common');
  const resolveIdentity = (i) => ({ identityId: i.defaultIdentityId, source: 'default' });
  return new Connection(
    {
      transport: {
        mode: 'udp',
        bindAddress: '0.0.0.0',
        bindPort,
        remoteAddress: '127.0.0.1',
        remotePort: REMOTE_PORT,
      },
      vehicle: {
        targetSystem: SYSID,
        targetComponent: COMPID,
        bundle,
        firmware: 'px4',
        autopilot: 12,
      },
      identities: [{
        id: 'gcs',
        sysid: 255,
        compid: 190,
        heartbeat: {
          type: 6, autopilot: 8, systemStatus: 4, baseMode: 0, customMode: 0, mavlinkVersion: 3,
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

function sendCmd(conn, command, params, confirmation = 0) {
  const msg = buildCommandLong(command, SYSID, COMPID, params, confirmation);
  conn.send(msg, { band: BAND.CONTROL, target: { sysid: SYSID, compid: COMPID } });
}

function requestTelemetry(conn) {
  for (const streamId of [0, 1, 2, 3, 4, 6, 10, 11, 12]) {
    sendCmd(conn, REQUEST_DATA_STREAM, [streamId, 100000, 1, 0, 0, 0, 0]);
  }
  for (const [id, us] of [[1, 500000], [24, 200000], [30, 100000], [32, 100000], [33, 100000]]) {
    sendCmd(conn, SET_MESSAGE_INTERVAL, [id, us, 0, 0, 0, 0, 0]);
  }
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

function snapshot(conn) {
  const pos = conn.peerTable.getComponent(SYSID, COMPID)?.position;
  if (!pos) return null;
  return {
    relative_m: pos.relativeAlt != null ? Number(pos.relativeAlt) / 1000 : null,
    amsl_m: pos.alt != null ? Number(pos.alt) / 1000 : null,
    lat: pos.lat != null ? Number(pos.lat) / 1e7 : null,
    lon: pos.lon != null ? Number(pos.lon) / 1e7 : null,
  };
}

async function waitPosition(conn, ms = 20000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const s = snapshot(conn);
    if (s && s.amsl_m != null && Number.isFinite(s.amsl_m) && Math.abs(s.amsl_m) > 1) {
      return s;
    }
    await sleep(200);
  }
  return snapshot(conn);
}

async function arm(conn) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (conn.peerTable.getComponent(SYSID, COMPID)?.armed) return;
    sendCmd(conn, ARM_DISARM, [1, 0, 0, 0, 0, 0, 0]);
    await sleep(1500);
  }
  throw new Error('PX4 did not arm');
}

function collectTelemetry(conn) {
  const texts = [];
  const acks = [];
  const unsub = conn.subscribe({}, (decoded) => {
    if (!decoded || Number(decoded.sysid) !== SYSID) return;
    if (decoded.name === 'STATUSTEXT') {
      const t = decoded.fields && decoded.fields.text;
      if (typeof t === 'string' && t.trim()) texts.push(t.trim());
    }
    if (decoded.name === 'COMMAND_ACK') {
      if (Number(decoded.fields.command) === NAV_TAKEOFF) {
        acks.push({
          result: Number(decoded.fields.result),
          resultName: String(decoded.fields.result),
        });
      }
    }
  });
  return { texts, acks, stop: unsub };
}

async function runProbe(label, sendTakeoff, bindPort) {
  console.log(`\n=== ${label} ===`);
  restartVehicle();
  const prep = prepPx4LabParams();
  console.log('  prep:', prep.ok ? 'ok' : prep.stderr);
  const conn = makeConn(bindPort);
  await conn.start();
  await sleep(2000);
  const tel = collectTelemetry(conn);
  try {
    await waitPeer(conn);
    requestTelemetry(conn);
    await sleep(1500);
    const before = await waitPosition(conn);
    console.log('  before:', before);
    await arm(conn);
    await sleep(1500);
    const armedAt = snapshot(conn);
    console.log('  armed:', armedAt);

    sendTakeoff(conn, armedAt || before);

    const t0 = Date.now();
    // Product default: absent frame → relative completion (completion.js).
    const { promise } = waitForCompletion({
      completionKey: COMPLETION.TAKEOFF,
      params: [0, 0, 0, 0, 0, 0, TAKEOFF_ALT_M],
      peerTable: conn.peerTable,
      sysid: SYSID,
      compid: COMPID,
      timeoutMs: COMPLETION_MS,
      now: Date.now,
    });
    const completion = await promise;
    const elapsedMs = Date.now() - t0;
    await sleep(2000);
    const after = snapshot(conn);

    const climbRel =
      before && after && before.relative_m != null && after.relative_m != null
        ? after.relative_m - before.relative_m
        : null;
    const alreadyHigher = tel.texts.some((t) =>
      /already higher|takeoff altitude/i.test(t)
    );

    const row = {
      label,
      takeoff_param7_m: TAKEOFF_ALT_M,
      home_amsl_m: before && before.amsl_m,
      before,
      after,
      climb_relative_m: climbRel,
      climbed: climbRel != null && climbRel > 2,
      ack: tel.acks[0] || null,
      already_higher_statustext: alreadyHigher,
      matching_statustext: tel.texts.filter((t) =>
        /takeoff|altitude|higher|mission/i.test(t)
      ),
      completion,
      completion_elapsed_ms: elapsedMs,
      product_relative_completion_timed_out: Boolean(
        completion && completion.success === false
      ),
      prep_ok: prep.ok,
    };
    console.log('  after:', after);
    console.log('  climb_relative_m:', climbRel);
    console.log('  already_higher:', alreadyHigher);
    console.log('  ack:', row.ack);
    console.log('  completion:', completion);
    return row;
  } finally {
    tel.stop();
    await new Promise((resolve) => conn.close(() => resolve()));
  }
}

async function main() {
  const outIdx = process.argv.indexOf('--out');
  const outPath =
    outIdx >= 0
      ? process.argv[outIdx + 1]
      : path.join('/opt/cursor/artifacts', 'px4-takeoff-datum-results.json');

  console.log(`PX4 takeoff datum probe → ${CONTAINER} :${REMOTE_PORT}`);
  console.log(`param7/z = ${TAKEOFF_ALT_M} m; product completion frame = (absent → relative)`);

  // Same bind==remote pattern as sitl/measure-verification-debt.js (PX4 :14560).
  const longRow = await runProbe(
    'COMMAND_LONG param7=10',
    (conn) => {
      sendCmd(conn, NAV_TAKEOFF, [0, 0, 0, NaN, NaN, NaN, TAKEOFF_ALT_M]);
    },
    REMOTE_PORT
  );

  const intRow = await runProbe(
    'COMMAND_INT frame=3 (GLOBAL_RELATIVE_ALT) z=10',
    (conn, pos) => {
      const lat = pos && pos.lat != null ? pos.lat : 47.397742;
      const lon = pos && pos.lon != null ? pos.lon : 8.545594;
      const msg = buildCommandInt(
        NAV_TAKEOFF,
        SYSID,
        COMPID,
        [0, 0, 0, NaN, lat, lon, TAKEOFF_ALT_M],
        { frame: MAV_FRAME.GLOBAL_RELATIVE_ALT }
      );
      conn.send(msg, { band: BAND.CONTROL, target: { sysid: SYSID, compid: COMPID } });
    },
    REMOTE_PORT
  );

  const report = {
    measured_at: new Date().toISOString(),
    vehicle: CONTAINER,
    sysid: SYSID,
    claim:
      'PX4 reads NAV_TAKEOFF param7/z as AMSL on LONG and INT; relative product completion mismatches at non-zero home AMSL',
    probes: [longRow, intRow],
    summary: {
      long_climbed: longRow.climbed,
      long_already_higher: longRow.already_higher_statustext,
      long_relative_completion_timed_out:
        longRow.product_relative_completion_timed_out,
      long_home_amsl_m: longRow.home_amsl_m,
      int_climbed: intRow.climbed,
      int_already_higher: intRow.already_higher_statustext,
      int_relative_completion_timed_out:
        intRow.product_relative_completion_timed_out,
      int_home_amsl_m: intRow.home_amsl_m,
      claim_supported:
        !longRow.climbed &&
        !intRow.climbed &&
        longRow.product_relative_completion_timed_out &&
        intRow.product_relative_completion_timed_out,
    },
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\nWrote ${outPath}`);
  console.log('summary:', JSON.stringify(report.summary, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
