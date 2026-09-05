#!/usr/bin/env node
'use strict';

/**
 * Remaining verification-debt SITL probes (docs/verification-debt.md):
 *   14.79-SITL  — takeoff completion at non-zero home elevation
 *   14.98.5     — commanded yaw rate near target (not a speed limit)
 *   14.108-loiter — PX4 DO_REPOSITION flag-clear from Hold (AUTO_LOITER)
 *   14.108-heading — goto param4 yaw honour (opt-in: VDEBT_PROBE=14.108-heading)
 *
 * AP sysid 1 :14550, PX4 sysid 11 :14560.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { Connection } = require('../lib/connection/runtime');
const { BAND } = require('../lib/connection/bands');
const { loadBundled } = require('../lib/metadata/bundled');
const { buildCommandLong } = require('../lib/command/carrier');
const { waitForCompletion } = require('../lib/command/completion');
const { COMPLETION } = require('../lib/command/presets');
const {
  buildMoveMessage,
  createMoveStream,
  MAV_FRAME,
} = require('../lib/move');
const { buildRepositionMessage, DO_REPOSITION } = require('../lib/move/reposition');

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'nrc-vdebt-'));
const OUT = path.join(WORK, 'verification-debt-results.json');
const PX4_HOLD_MODE = 0x03040000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PROBE_FILTER = process.env.VDEBT_PROBE
  ? new Set(process.env.VDEBT_PROBE.split(',').map((s) => s.trim()))
  : null;
const DEFAULT_PROBES = ['14.79', '14.98.5', '14.108-loiter'];

function wantProbe(name) {
  if (PROBE_FILTER) return PROBE_FILTER.has(name);
  return DEFAULT_PROBES.includes(name);
}

function restartContainer(name) {
  const r = spawnSync('docker', ['restart', name], { encoding: 'utf8' });
  return { ok: r.status === 0, status: r.status, stderr: (r.stderr || '').slice(0, 300) };
}

function note(results, name, ok, detail, extra) {
  const row = { name, ok, detail, ...(extra || {}) };
  results.push(row);
  console.log(JSON.stringify(row));
  return row;
}

function prepPx4LabParams(container = 'nrc-px4-11') {
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
  const r = spawnSync('docker', ['exec', container, 'sh', '-lc', script], {
    encoding: 'utf8',
  });
  return { ok: r.status === 0, status: r.status, stderr: (r.stderr || '').slice(0, 500) };
}

function makeConn({ bindPort, remotePort, sysid, firmware, autopilot, dialect }) {
  const bundle = loadBundled(dialect);
  const resolveIdentity = (i) => ({ identityId: i.defaultIdentityId, source: 'default' });
  return new Connection(
    {
      transport: {
        mode: 'udp',
        bindAddress: '0.0.0.0',
        bindPort,
        remoteAddress: '127.0.0.1',
        remotePort,
      },
      vehicle: {
        targetSystem: sysid,
        targetComponent: 1,
        bundle,
        firmware,
        autopilot,
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
        linkId: 0, signOutbound: false, requireSigned: false, acceptInvalid: false, hasKey: false,
      },
      heartbeat: { staleMs: 5000, expireMs: 15000 },
    },
    { resolveIdentity, logger: { info() {}, warn() {}, error() {} } }
  );
}

function sendCmd(conn, sysid, command, params, confirmation = 0) {
  const msg = buildCommandLong(command, sysid, 1, params, confirmation);
  conn.send(msg, { band: BAND.CONTROL, target: { sysid, compid: 1 } });
}

function requestTelemetry(conn, sysid) {
  for (const streamId of [0, 1, 2, 3, 4, 6, 10, 11, 12]) {
    sendCmd(conn, sysid, 66, [streamId, 100000, 1, 0, 0, 0, 0]);
  }
  for (const [id, us] of [[1, 500000], [24, 200000], [30, 100000], [32, 100000], [33, 100000]]) {
    sendCmd(conn, sysid, 511, [id, us, 0, 0, 0, 0, 0]);
  }
}

async function waitPeer(conn, sysid, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const c = conn.peerTable.getComponent(sysid, 1);
    if (c && c.primaryEndpoint) return c;
    await sleep(200);
  }
  throw new Error(`peer ${sysid} not learned`);
}

function waitCommandAck(conn, sysid, command, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const unsub = conn.subscribe({}, (decoded) => {
      if (!decoded || decoded.name !== 'COMMAND_ACK') return;
      if (Number(decoded.sysid) !== Number(sysid)) return;
      if (Number(decoded.fields.command) !== Number(command)) return;
      unsub();
      resolve({
        result: Number(decoded.fields.result),
        latencyMs: Date.now() - start,
      });
    });
    setTimeout(() => {
      unsub();
      resolve(null);
    }, timeoutMs);
  });
}

async function apGuidedArm(conn, sysid) {
  await waitPeer(conn, sysid);
  requestTelemetry(conn, sysid);
  await sleep(1000);
  const modeDeadline = Date.now() + 120000;
  while (Date.now() < modeDeadline) {
    const c = conn.peerTable.getComponent(sysid, 1);
    if (c && c.flightMode === 4) break;
    if (c?.armed) {
      sendCmd(conn, sysid, 400, [0, 21196, 0, 0, 0, 0, 0]);
      await sleep(500);
    }
    sendCmd(conn, sysid, 176, [1, 4, 0, 0, 0, 0, 0]);
    await sleep(1000);
  }
  if (conn.peerTable.getComponent(sysid, 1)?.flightMode !== 4) {
    throw new Error('AP did not enter GUIDED');
  }
  const armDeadline = Date.now() + 120000;
  while (Date.now() < armDeadline) {
    if (conn.peerTable.getComponent(sysid, 1)?.armed) break;
    sendCmd(conn, sysid, 400, [1, 0, 0, 0, 0, 0, 0]);
    await sleep(2000);
  }
  if (!conn.peerTable.getComponent(sysid, 1)?.armed) {
    throw new Error('AP did not arm');
  }
}

async function probeTakeoffCompletion(results) {
  const conn = makeConn({
    bindPort: 14550,
    remotePort: 14550,
    sysid: 1,
    firmware: 'ardupilot',
    autopilot: 3,
    dialect: 'ardupilotmega',
  });
  await conn.start();
  await sleep(2000);
  try {
    await apGuidedArm(conn, 1);
    const posBefore = conn.peerTable.getComponent(1, 1)?.position;
    const homeAmslMm = posBefore && posBefore.alt != null && posBefore.relativeAlt != null
      ? Number(posBefore.alt) - Number(posBefore.relativeAlt)
      : null;
    sendCmd(conn, 1, 22, [0, 0, 0, 0, 0, 0, 10]);
    const { promise } = waitForCompletion({
      completionKey: COMPLETION.TAKEOFF,
      params: [0, 0, 0, 0, 0, 0, 10],
      peerTable: conn.peerTable,
      sysid: 1,
      compid: 1,
      timeoutMs: 45000,
      now: Date.now,
    });
    const outcome = await promise;
    const posAfter = conn.peerTable.getComponent(1, 1)?.position;
    const relMm = posAfter && posAfter.relativeAlt != null ? Number(posAfter.relativeAlt) : null;
    const ok = outcome.success && homeAmslMm != null && homeAmslMm > 100000;
    note(results, 'takeoff-14.79-sitl', ok,
      ok
        ? `completion at homeAmsl=${(homeAmslMm / 1000).toFixed(1)} m rel=${relMm != null ? (relMm / 1000).toFixed(2) : '?'} m`
        : `completion failed: ${outcome.detail}`,
      { homeAmslMm, relMm, outcome });
  } catch (err) {
    note(results, 'takeoff-14.79-sitl', false, err.message);
  }
  await new Promise((resolve) => conn.close(() => resolve()));
}

function headingErrorDeg(yawRad, targetDeg) {
  const current = ((yawRad * 180) / Math.PI + 360) % 360;
  return Math.abs((((current - targetDeg) + 540) % 360) - 180);
}

async function probeYawRateNearTarget(results) {
  const conn = makeConn({
    bindPort: 14550,
    remotePort: 14550,
    sysid: 1,
    firmware: 'ardupilot',
    autopilot: 3,
    dialect: 'ardupilotmega',
  });
  const samples = [];
  await conn.start();
  const unsub = conn.subscribe({}, (decoded) => {
    if (!decoded || Number(decoded.sysid) !== 1 || decoded.name !== 'ATTITUDE') return;
    const yaw = Number(decoded.fields.yaw);
    const yawspeed = Number(decoded.fields.yawspeed);
    samples.push({
      t: Date.now(),
      rateDegS: Math.abs((yawspeed * 180) / Math.PI),
      errDeg: headingErrorDeg(yaw, 180),
    });
  });
  await sleep(2000);
  try {
    await apGuidedArm(conn, 1);
    sendCmd(conn, 1, 22, [0, 0, 0, 0, 0, 0, 12]);
    await sleep(12000);
    requestTelemetry(conn, 1);
    const target = { sysid: 1, compid: 1 };
    const msg = buildMoveMessage({
      mode: 'velocity',
      frame: MAV_FRAME.LOCAL_NED,
      target,
      velocity: { north: 0, east: 0, up: 0 },
      yaw: 180,
      yawRate: 20,
    });
    const t0 = Date.now();
    const stream = createMoveStream({
      connection: conn, message: msg, target, rateHz: 10, ttlMs: 0,
    });
    stream.start();
    await sleep(8000);
    stream.stop();
    unsub();
    const window = samples.filter((s) => s.t >= t0);
    const far = window.filter((s) => s.errDeg > 45);
    const mid = window.filter((s) => s.errDeg >= 15 && s.errDeg <= 45);
    const near = window.filter((s) => s.errDeg < 15);
    const med = (arr) => (arr.length
      ? arr.map((s) => s.rateDegS).sort((a, b) => a - b)[Math.floor(arr.length / 2)]
      : null);
    const farMed = med(far);
    const midMed = med(mid);
    const nearMed = med(near);
    const notLimitMid = midMed != null && midMed > 25;
    note(results, 'yaw-rate-14.98.5', far.length > 3 || mid.length > 3,
      notLimitMid
        ? `mid-error median ${midMed.toFixed(1)}°/s (commanded 20) — still not a speed limit while slewing`
        : `far=${farMed != null ? farMed.toFixed(1) : 'n/a'} mid=${midMed != null ? midMed.toFixed(1) : 'n/a'} near=${nearMed != null ? nearMed.toFixed(1) : 'n/a'} °/s`,
      {
        commandedDegS: 20,
        farMedDegS: farMed,
        midMedDegS: midMed,
        nearMedDegS: nearMed,
        farSamples: far.length,
        midSamples: mid.length,
        nearSamples: near.length,
      });
  } catch (err) {
    unsub();
    note(results, 'yaw-rate-14.98.5', false, err.message);
  }
  await new Promise((resolve) => conn.close(() => resolve()));
}

async function px4ArmClimb(conn, sysid) {
  await waitPeer(conn, sysid);
  requestTelemetry(conn, sysid);
  await sleep(1000);
  const armDeadline = Date.now() + 60000;
  while (Date.now() < armDeadline) {
    if (conn.peerTable.getComponent(sysid, 1)?.armed) break;
    sendCmd(conn, sysid, 400, [1, 0, 0, 0, 0, 0, 0]);
    await sleep(1500);
  }
  if (!conn.peerTable.getComponent(sysid, 1)?.armed) {
    throw new Error('PX4 did not arm');
  }
  sendCmd(conn, sysid, 22, [0, 0, 0, 0, 0, 0, 15]);
  const climbDeadline = Date.now() + 45000;
  while (Date.now() < climbDeadline) {
    const rel = conn.peerTable.getComponent(sysid, 1)?.position?.relativeAlt;
    if (rel != null && Number(rel) > 5000) break;
    await sleep(1000);
  }
}

async function probePx4LoiterReposition(results) {
  const prep = prepPx4LabParams();
  note(results, 'px4-loiter-prep', prep.ok, prep.ok ? 'lab helpers' : prep.stderr, prep);
  const conn = makeConn({
    bindPort: 14560,
    remotePort: 14560,
    sysid: 11,
    firmware: 'px4',
    autopilot: 12,
    dialect: 'common',
  });
  await conn.start();
  await sleep(2000);
  try {
    await px4ArmClimb(conn, 11);
    sendCmd(conn, 11, 176, [1, 4, 3, 0, 0, 0, 0]);
    const holdDeadline = Date.now() + 30000;
    while (Date.now() < holdDeadline) {
      if (conn.peerTable.getComponent(11, 1)?.flightMode === PX4_HOLD_MODE) break;
      await sleep(500);
    }
    const mode = conn.peerTable.getComponent(11, 1)?.flightMode;
    if (mode !== PX4_HOLD_MODE) {
      throw new Error(`PX4 not in Hold (got ${mode})`);
    }
    note(results, 'px4-hold-mode', true, `custom_mode=0x${mode.toString(16)}`);
    const msg = buildRepositionMessage({
      changeMode: false,
      frame: MAV_FRAME.GLOBAL_RELATIVE_ALT,
      target: { sysid: 11, compid: 1 },
      position: { lat: 47.397742, lon: 8.545594, alt: 25 },
      yaw: 90,
    });
    const ackWait = waitCommandAck(conn, 11, DO_REPOSITION);
    conn.send(msg, { band: BAND.CONTROL, target: { sysid: 11, compid: 1 } });
    const ack = await ackWait;
    const accepted = ack && ack.result === 0;
    note(results, 'px4-loiter-reposition-14.108', accepted,
      accepted
        ? `DO_REPOSITION ACCEPTED from Hold with changeMode=false (${ack.latencyMs}ms)`
        : `ack=${ack ? ack.result : 'timeout'}`,
      { ack, changeMode: false, flightMode: mode });
  } catch (err) {
    note(results, 'px4-loiter-reposition-14.108', false, err.message);
  }
  await new Promise((resolve) => conn.close(() => resolve()));
}

async function sampleHeadingAfterReposition(conn, sysid, msg) {
  const headings = [];
  const unsub = conn.subscribe({}, (decoded) => {
    if (!decoded || Number(decoded.sysid) !== Number(sysid)) return;
    if (decoded.name === 'VFR_HUD') {
      headings.push({ t: Date.now(), hdg: Number(decoded.fields.heading) });
    } else if (decoded.name === 'ATTITUDE') {
      headings.push({
        t: Date.now(),
        hdg: ((Number(decoded.fields.yaw) * 180) / Math.PI + 360) % 360,
      });
    }
  });
  requestTelemetry(conn, sysid);
  await sleep(3000);
  const tPre = Date.now();
  const pre = headings.filter((h) => h.t >= tPre - 2500);
  const initialHdg = pre.length ? pre[pre.length - 1].hdg : null;
  const ackWait = waitCommandAck(conn, sysid, DO_REPOSITION);
  conn.send(msg, { band: BAND.CONTROL, target: { sysid, compid: 1 } });
  const ack = await ackWait;
  const t0 = Date.now();
  await sleep(20000);
  unsub();
  const late = headings.filter((h) => h.t >= t0 + 8000);
  const finalHdg = late.length ? late[late.length - 1].hdg : null;
  return { ack, initialHdg, finalHdg, sampleCount: late.length };
}

function headingDeltaDeg(a, b) {
  if (a == null || b == null) return null;
  return Math.abs((((a - b) + 540) % 360) - 180);
}

async function probeGotoHeadingAp(results) {
  const restart = restartContainer('nrc-ap-1');
  note(results, 'goto-heading-ap-restart', restart.ok, restart.ok ? 'nrc-ap-1' : restart.stderr);
  await sleep(15000);
  const conn = makeConn({
    bindPort: 14550,
    remotePort: 14550,
    sysid: 1,
    firmware: 'ardupilot',
    autopilot: 3,
    dialect: 'ardupilotmega',
  });
  await conn.start();
  await sleep(2000);
  try {
    await apGuidedArm(conn, 1);
    sendCmd(conn, 1, 22, [0, 0, 0, 0, 0, 0, 12]);
    await sleep(12000);
    const msg = buildRepositionMessage({
      changeMode: false,
      frame: MAV_FRAME.GLOBAL_RELATIVE_ALT,
      target: { sysid: 1, compid: 1 },
      position: { lat: -35.362262, lon: 149.165237, alt: 20 },
      yaw: 90,
    });
    const { ack, initialHdg, finalHdg, sampleCount } = await sampleHeadingAfterReposition(conn, 1, msg);
    const delta = headingDeltaDeg(finalHdg, 90);
    const ignored = ack && ack.result === 0 && delta != null && delta > 30;
    note(results, 'goto-heading-ap-14.108', ack && ack.result === 0,
      ignored
        ? `param4 yaw ignored — final hdg ${finalHdg.toFixed(1)}° (Δ90=${delta.toFixed(1)}°); completion tier does not capture heading`
        : `ack=${ack ? ack.result : 'timeout'} hdg=${finalHdg}`,
      { commandedYawDeg: 90, initialHdg, finalHdg, deltaFrom90: delta, sampleCount, ack });
  } catch (err) {
    note(results, 'goto-heading-ap-14.108', false, err.message);
  }
  await new Promise((resolve) => conn.close(() => resolve()));
}

async function probeGotoHeadingPx4(results) {
  const restart = restartContainer('nrc-px4-11');
  note(results, 'goto-heading-px4-restart', restart.ok, restart.ok ? 'nrc-px4-11' : restart.stderr);
  await sleep(15000);
  const prep = prepPx4LabParams();
  note(results, 'goto-heading-px4-prep', prep.ok, prep.ok ? 'lab helpers' : prep.stderr, prep);
  const conn = makeConn({
    bindPort: 14560,
    remotePort: 14560,
    sysid: 11,
    firmware: 'px4',
    autopilot: 12,
    dialect: 'common',
  });
  await conn.start();
  await sleep(2000);
  try {
    await px4ArmClimb(conn, 11);
    const msg = buildRepositionMessage({
      changeMode: true,
      frame: MAV_FRAME.GLOBAL_RELATIVE_ALT,
      target: { sysid: 11, compid: 1 },
      position: { lat: 47.3991, lon: 8.5456, alt: 20 },
      yaw: 90,
    });
    const { ack, initialHdg, finalHdg, sampleCount } = await sampleHeadingAfterReposition(conn, 11, msg);
    const delta = headingDeltaDeg(finalHdg, 90);
    const initialDelta = headingDeltaDeg(initialHdg, 90);
    const movedToward = initialDelta != null && delta != null && delta < initialDelta - 15;
    const honoured = delta != null && (delta < 30 || movedToward);
    note(results, 'goto-heading-px4-14.108', ack && ack.result === 0,
      honoured
        ? `PX4 honoured param4 yaw — final hdg ${finalHdg.toFixed(1)}° (Δ90=${delta.toFixed(1)}°, initial Δ=${initialDelta != null ? initialDelta.toFixed(1) : 'n/a'}°); completion tier still ack-only`
        : `ack ok but heading inconclusive — final hdg ${finalHdg} (Δ90=${delta}, initialΔ=${initialDelta}); completion tier ack-only`,
      { commandedYawDeg: 90, initialHdg, finalHdg, deltaFrom90: delta, initialDeltaFrom90: initialDelta, movedToward, honoured, sampleCount, ack });
  } catch (err) {
    note(results, 'goto-heading-px4-14.108', false, err.message);
  }
  await new Promise((resolve) => conn.close(() => resolve()));
}

async function main() {
  const results = [];
  const ran = [];
  if (wantProbe('14.79')) { ran.push('14.79-SITL'); await probeTakeoffCompletion(results); }
  if (wantProbe('14.98.5')) { ran.push('14.98.5'); await probeYawRateNearTarget(results); }
  if (wantProbe('14.108-loiter')) { ran.push('14.108-loiter'); await probePx4LoiterReposition(results); }
  if (wantProbe('14.108-heading')) {
    ran.push('14.108-heading');
    await probeGotoHeadingAp(results);
    await probeGotoHeadingPx4(results);
  }
  if (ran.length === 0) {
    console.error('No probes selected; set VDEBT_PROBE to a probe id from the script header.');
    process.exit(1);
  }
  const summary = {
    measuredAt: new Date().toISOString(),
    probes: ran,
  };
  const allOk = results.every((r) => r.ok);
  note(results, 'summary', allOk, 'verification-debt probes complete', summary);
  fs.writeFileSync(OUT, JSON.stringify({ results, summary }, null, 2), { mode: 0o600 });
  console.error(`wrote ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
