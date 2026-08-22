#!/usr/bin/env node
'use strict';

/**
 * SITL measurements for GitHub #175 / #179 (Move hypotheses).
 * Writes results under a private mkdtemp directory.
 *
 * Probes (AP sysid 1 on :14550, PX4 sysid 11 on :14560):
 *   1. stream-replace halt — does stop()+new stream visibly perturb?
 *   2. yaw-only setpoint on ArduPilot GUIDED
 *   3. GUID_TIMEOUT one-shot velocity brake (~3 s)
 *   4. PX4 OFFBOARD survival at 5 Hz vs 1 Hz
 *   5. yaw + yaw_rate complementary (AP + PX4)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const { Connection, BAND } = require(path.join(ROOT, 'lib/connection'));
const { loadBundled } = require(path.join(ROOT, 'lib/metadata'));
const { buildCommandLong } = require(path.join(ROOT, 'lib/command/carrier'));
const {
  buildMoveMessage,
  createMoveStream,
  buildStopMessage,
  MAV_FRAME,
} = require(path.join(ROOT, 'lib/move'));

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'nrc-move-179-'));
const OUT = path.join(WORK, 'move-179-results.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Lab helpers so SIH stays armed long enough for OFFBOARD probes (see §14). */
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
  return {
    ok: r.status === 0,
    status: r.status,
    stderr: (r.stderr || '').slice(0, 500),
  };
}

function note(results, name, ok, detail, extra) {
  const row = { name, ok, detail, ...(extra || {}) };
  results.push(row);
  console.log(JSON.stringify(row));
  return row;
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
      identities: [
        {
          id: 'gcs',
          sysid: 255,
          compid: 190,
          heartbeat: {
            type: 6,
            autopilot: 8,
            systemStatus: 4,
            baseMode: 0,
            customMode: 0,
            mavlinkVersion: 3,
          },
          heartbeatIntervalMs: 500,
        },
      ],
      defaultIdentityId: 'gcs',
      boundIdentityIds: ['gcs'],
      signing: {
        linkId: 0,
        signOutbound: false,
        requireSigned: false,
        acceptInvalid: false,
        hasKey: false,
      },
      heartbeat: { staleMs: 5000, expireMs: 15000 },
    },
    { resolveIdentity, logger: { info() {}, warn() {}, error() {} } }
  );
}

function attachSampler(conn, sysid) {
  const samples = [];
  const unsub = conn.subscribe({}, (decoded) => {
    if (!decoded || Number(decoded.sysid) !== Number(sysid)) return;
    const f = decoded.fields || {};
    if (decoded.name === 'LOCAL_POSITION_NED') {
      samples.push({
        t: Date.now(),
        kind: 'ned',
        x: Number(f.x),
        y: Number(f.y),
        z: Number(f.z),
        vx: Number(f.vx),
        vy: Number(f.vy),
        vz: Number(f.vz),
      });
    } else if (decoded.name === 'ATTITUDE') {
      samples.push({
        t: Date.now(),
        kind: 'att',
        yaw: Number(f.yaw),
        yawspeed: Number(f.yawspeed),
      });
    } else if (decoded.name === 'VFR_HUD') {
      samples.push({
        t: Date.now(),
        kind: 'hud',
        gs: Number(f.groundspeed),
        heading: Number(f.heading),
        alt: Number(f.alt),
      });
    } else if (decoded.name === 'HEARTBEAT') {
      samples.push({
        t: Date.now(),
        kind: 'hb',
        baseMode: Number(f.base_mode),
        customMode: Number(f.custom_mode),
        armed: !!(Number(f.base_mode) & 128),
      });
    } else if (decoded.name === 'STATUSTEXT') {
      samples.push({
        t: Date.now(),
        kind: 'text',
        text: String(f.text || ''),
      });
    }
  });
  return { samples, unsub };
}

function sendCmd(conn, sysid, command, params, confirmation = 0) {
  const msg = buildCommandLong(command, sysid, 1, params, confirmation);
  conn.send(msg, { band: BAND.CONTROL, target: { sysid, compid: 1 } });
}

/** Ask the vehicle for attitude / local / HUD / global at ~10 Hz. */
function requestTelemetry(conn, sysid) {
  for (const streamId of [0, 1, 2, 3, 4, 6, 10, 11, 12]) {
    sendCmd(conn, sysid, 66, [streamId, 100000, 1, 0, 0, 0, 0]);
  }
  for (const [id, us] of [
    [30, 100000],
    [32, 100000],
    [33, 100000],
    [74, 100000],
  ]) {
    sendCmd(conn, sysid, 511, [id, us, 0, 0, 0, 0, 0]);
  }
}

function sendMove(conn, sysid, input) {
  const message = buildMoveMessage({
    ...input,
    target: { sysid, compid: 1 },
  });
  conn.send(message, {
    band: BAND.STREAMING,
    target: { sysid, compid: 1 },
  });
  return message;
}

async function waitPeer(conn, sysid, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const c = conn.peerTable.getComponent(sysid, 1);
    if (c && c.primaryEndpoint) return c;
    await sleep(200);
  }
  throw new Error(`peer ${sysid} not learned`);
}

async function apGuidedArmTakeoff(conn, sysid, results) {
  await waitPeer(conn, sysid);
  requestTelemetry(conn, sysid);
  await sleep(1000);
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
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
    const c = conn.peerTable.getComponent(sysid, 1);
    if (c?.armed) break;
    sendCmd(conn, sysid, 400, [1, 0, 0, 0, 0, 0, 0]);
    await sleep(2000);
  }
  if (!conn.peerTable.getComponent(sysid, 1)?.armed) {
    throw new Error('AP did not arm');
  }
  note(results, 'ap-prep', true, 'GUIDED+armed');
  // Takeoff ~15 m AGL and wait until relative alt is useful for velocity probes.
  sendCmd(conn, sysid, 22, [0, 0, 0, 0, 0, 0, 15]);
  const climbDeadline = Date.now() + 45000;
  let rel = 0;
  while (Date.now() < climbDeadline) {
    const pos = conn.peerTable.getComponent(sysid, 1)?.position;
    rel = pos && pos.relativeAlt != null ? Number(pos.relativeAlt) / 1000 : 0;
    if (rel > 8) break;
    await sleep(1000);
  }
  note(results, 'ap-takeoff', rel > 8, `relativeAlt=${rel.toFixed(2)} m`);
  if (rel <= 8) throw new Error(`takeoff did not reach 8 m (rel=${rel})`);
  requestTelemetry(conn, sysid);
  await sleep(500);
}

function downsample(samples, kind, everyMs = 100) {
  const out = [];
  let last = 0;
  for (const s of samples) {
    if (s.kind !== kind) continue;
    if (s.t - last < everyMs && out.length) continue;
    last = s.t;
    out.push(s);
  }
  return out;
}

async function probeHaltReplace(conn, sysid, results, frame) {
  const { samples, unsub } = attachSampler(conn, sysid);
  const target = { sysid, compid: 1 };
  const rateHz = 10;
  const mk = (vel) =>
    buildMoveMessage({
      mode: 'velocity',
      frame,
      target,
      velocity: vel,
    });

  const msgA = mk({ north: 2, east: 0, up: 0 });
  let stream = createMoveStream({
    connection: conn,
    message: msgA,
    target,
    rateHz,
    ttlMs: 0,
  });
  stream.start();
  await sleep(2500);

  const tReplace = Date.now();
  // Same path as mavlink-move replace: stop() then new stream (halt on wire).
  stream.stop();
  // Both frames take the same velocity vector: the global frames carry it in
  // the GLOBAL_INT fields, and the arms were identical even when this read
  // the frame name.
  const msgB = mk({ north: 0, east: 2, up: 0 });
  stream = createMoveStream({
    connection: conn,
    message: msgB,
    target,
    rateHz,
    ttlMs: 0,
  });
  stream.start();
  await sleep(2500);
  stream.stop();
  unsub();

  const ned = samples.filter((s) => s.kind === 'ned' && s.t >= tReplace - 500);
  const window = ned.filter((s) => s.t >= tReplace && s.t <= tReplace + 400);
  const speeds = window.map((s) => Math.hypot(s.vx || 0, s.vy || 0));
  const minSpd = speeds.length ? Math.min(...speeds) : null;
  const maxSpd = speeds.length ? Math.max(...speeds) : null;
  // "Visible halt" = horizontal speed collapses below 0.3 m/s in the 400 ms after replace
  // while we were previously moving (~2 m/s commanded).
  const pre = ned.filter((s) => s.t < tReplace && s.t >= tReplace - 500);
  const preSpd = pre.map((s) => Math.hypot(s.vx || 0, s.vy || 0));
  const preMed = preSpd.length
    ? preSpd.slice().sort((a, b) => a - b)[Math.floor(preSpd.length / 2)]
    : null;
  const visibleHalt = minSpd != null && preMed != null && preMed > 0.8 && minSpd < 0.35;

  note(results, `halt-replace-${frame}`, !visibleHalt, visibleHalt
    ? 'visible velocity collapse after stop()+replace'
    : 'no visible halt dip — next setpoint absorbs replace', {
    preMedSpd: preMed,
    minSpdAfter: minSpd,
    maxSpdAfter: maxSpd,
    samplesAfter: speeds.length,
    stopMessageName: buildStopMessage(msgA).name,
    streamMessageName: msgA.name,
  });
}

async function probeYawOnly(conn, sysid, results) {
  const { samples, unsub } = attachSampler(conn, sysid);
  await sleep(800);
  const att0 = [...samples].reverse().find((s) => s.kind === 'att');
  const yaw0 = att0 ? att0.yaw : null;
  const targetYawDeg = ((yaw0 == null ? 0 : (yaw0 * 180) / Math.PI) + 90 + 360) % 360;
  // Hold position while commanding yaw via yaw-only mode for 5 s (streamed).
  const target = { sysid, compid: 1 };
  const message = buildMoveMessage({
    mode: 'yaw-only',
    frame: MAV_FRAME.LOCAL_NED,
    target,
    yaw: targetYawDeg,
  });
  const stream = createMoveStream({
    connection: conn,
    message,
    target,
    rateHz: 10,
    ttlMs: 0,
  });
  const t0 = Date.now();
  stream.start();
  await sleep(5000);
  stream.stop();
  unsub();
  const att = samples.filter((s) => s.kind === 'att' && s.t >= t0);
  const yawEnd = att.length ? att[att.length - 1].yaw : null;
  let deltaDeg = null;
  if (yaw0 != null && yawEnd != null) {
    deltaDeg = ((((yawEnd - yaw0) * 180) / Math.PI + 540) % 360) - 180;
  }
  const moved = deltaDeg != null && Math.abs(deltaDeg) > 15;
  note(results, 'ap-yaw-only', true, moved
    ? 'yaw changed under yaw-only setpoint — source "hold_position ignores yaw" NOT confirmed'
    : 'yaw stayed put under yaw-only setpoint — matches hold_position hypothesis', {
    yaw0Rad: yaw0,
    yawEndRad: yawEnd,
    deltaDeg,
    typeMask: message.fields.type_mask,
  });
}

async function probeGuidTimeout(conn, sysid, results) {
  const { samples, unsub } = attachSampler(conn, sysid);
  // One-shot Send (not stream): single velocity setpoint.
  sendMove(conn, sysid, {
    mode: 'velocity',
    frame: MAV_FRAME.LOCAL_NED,
    velocity: { north: 2, east: 0, up: 0 },
  });
  const t0 = Date.now();
  await sleep(6500);
  unsub();
  const ned = samples.filter((s) => s.kind === 'ned' && s.t >= t0);
  const series = downsample(ned, 'ned', 200).map((s) => ({
    dt: s.t - t0,
    spd: Math.hypot(s.vx || 0, s.vy || 0),
  }));
  const early = series.filter((s) => s.dt >= 500 && s.dt <= 2000);
  const late = series.filter((s) => s.dt >= 3500 && s.dt <= 6000);
  const earlyMed = early.length
    ? early.map((s) => s.spd).sort((a, b) => a - b)[Math.floor(early.length / 2)]
    : null;
  const lateMed = late.length
    ? late.map((s) => s.spd).sort((a, b) => a - b)[Math.floor(late.length / 2)]
    : null;
  const braked = earlyMed != null && lateMed != null && earlyMed > 0.6 && lateMed < 0.4;
  note(results, 'ap-guid-timeout', true, braked
    ? 'one-shot velocity braked after ~GUID_TIMEOUT — document Stream for sustained velocity'
    : 'no clear ~3 s brake observed on one-shot velocity', {
    earlyMed,
    lateMed,
    series: series.filter((_, i) => i % 2 === 0).slice(0, 40),
  });
}

async function probeGuidYawPark(conn, sysid, results) {
  const { samples, unsub } = attachSampler(conn, sysid);
  const t0 = Date.now();
  sendMove(conn, sysid, {
    mode: 'velocity',
    frame: MAV_FRAME.LOCAL_NED,
    velocity: { north: 0, east: 0, up: 0 },
    yaw: 180,
    yawRate: 20,
  });
  await sleep(6500);
  unsub();
  const att = samples.filter((s) => s.kind === 'att' && s.t >= t0);
  const rates = att.map((s) => ({
    dt: s.t - t0,
    rateDegS: Math.abs((s.yawspeed || 0) * 180) / Math.PI,
  }));
  const early = rates.filter((s) => s.dt >= 800 && s.dt <= 2500);
  const late = rates.filter((s) => s.dt >= 3800 && s.dt <= 6000);
  const earlyMed = early.length
    ? early.map((s) => s.rateDegS).sort((a, b) => a - b)[Math.floor(early.length / 2)]
    : null;
  const lateMed = late.length
    ? late.map((s) => s.rateDegS).sort((a, b) => a - b)[Math.floor(late.length / 2)]
    : null;
  const parked = earlyMed != null && lateMed != null && earlyMed > 3 && lateMed < 2;
  note(results, 'ap-guid-yaw-park', true, parked
    ? 'one-shot yaw+rate slews then parks after ~GUID_TIMEOUT (14.98.6)'
    : 'no clear yaw-rate park on one-shot yaw+rate', {
    earlyMedDegS: earlyMed,
    lateMedDegS: lateMed,
    sampleCount: rates.length,
  });
}

async function probeYawAndRate(conn, sysid, results, tag) {
  const { samples, unsub } = attachSampler(conn, sysid);
  const target = { sysid, compid: 1 };
  // A) velocity north + absolute yaw east (90°)
  const msgA = buildMoveMessage({
    mode: 'velocity',
    frame: MAV_FRAME.LOCAL_NED,
    target,
    velocity: { north: 1.5, east: 0, up: 0 },
    yaw: 90,
  });
  let stream = createMoveStream({
    connection: conn,
    message: msgA,
    target,
    rateHz: 10,
    ttlMs: 0,
  });
  const tA = Date.now();
  stream.start();
  if (tag.startsWith('px4')) {
    await sleep(400);
    requestPx4Offboard(conn, sysid);
  }
  await sleep(4000);
  stream.stop();
  const attA = samples.filter((s) => s.kind === 'att' && s.t >= tA);
  const yawA = attA.length ? (attA[attA.length - 1].yaw * 180) / Math.PI : null;
  const nedA = samples.filter((s) => s.kind === 'ned' && s.t >= tA + 1000);
  const movedNorth = nedA.some((s) => (s.vx || 0) > 0.4);

  // B) yaw 180° + rate 20°/s while hovering (velocity 0)
  await sleep(500);
  const msgB = buildMoveMessage({
    mode: 'velocity',
    frame: MAV_FRAME.LOCAL_NED,
    target,
    velocity: { north: 0, east: 0, up: 0 },
    yaw: 180,
    yawRate: 20,
  });
  stream = createMoveStream({
    connection: conn,
    message: msgB,
    target,
    rateHz: 10,
    ttlMs: 0,
  });
  const tB = Date.now();
  const yawStart = [...samples].reverse().find((s) => s.kind === 'att');
  stream.start();
  if (tag.startsWith('px4')) {
    await sleep(400);
    requestPx4Offboard(conn, sysid);
  }
  await sleep(4000);
  stream.stop();
  unsub();
  const attB = samples.filter((s) => s.kind === 'att' && s.t >= tB);
  const yawRates = attB.map((s) => Math.abs((s.yawspeed || 0) * 180) / Math.PI);
  const medRate = yawRates.length
    ? yawRates.slice().sort((a, b) => a - b)[Math.floor(yawRates.length / 2)]
    : null;
  const yawEnd = attB.length ? (attB[attB.length - 1].yaw * 180) / Math.PI : null;
  // Complementary: translating with absolute yaw held near 90; then non-trivial yawspeed while slewing.
  const headingHeldWhileMoving =
    movedNorth && yawA != null && Math.abs((((yawA - 90) + 540) % 360) - 180) < 35;
  const slewWithRate = medRate != null && medRate > 5;
  note(results, `${tag}-yaw-and-rate`, headingHeldWhileMoving || slewWithRate,
    `vel+yaw headingHeld=${headingHeldWhileMoving}; yaw+rate slew=${slewWithRate}`, {
      yawADeg: yawA,
      yawEndDeg: yawEnd,
      yawStartDeg: yawStart ? (yawStart.yaw * 180) / Math.PI : null,
      medYawRateDegS: medRate,
      movedNorth,
      typeMaskA: msgA.fields.type_mask,
      typeMaskB: msgB.fields.type_mask,
    });
}

function isPx4Offboard(customMode) {
  return ((Number(customMode) >> 16) & 0xff) === 6;
}

/** This SIH accepts PX4 main_mode in DO_SET_MODE param2 (DESIGN.md §14), not the HEARTBEAT pack. */
function requestPx4Offboard(conn, sysid) {
  sendCmd(conn, sysid, 176, [1, 6, 0, 0, 0, 0, 0]);
}

async function probePx4OffboardRate(conn, sysid, results) {
  await waitPeer(conn, sysid);
  requestTelemetry(conn, sysid);
  // Arm PX4 (lab helpers already set COM_RCL_EXCEPT).
  const armDeadline = Date.now() + 60000;
  while (Date.now() < armDeadline) {
    if (conn.peerTable.getComponent(sysid, 1)?.armed) break;
    sendCmd(conn, sysid, 400, [1, 0, 0, 0, 0, 0, 0]);
    await sleep(1500);
  }
  const armed = !!conn.peerTable.getComponent(sysid, 1)?.armed;
  note(results, 'px4-armed', armed, armed ? 'armed' : 'could not arm — rate probe degraded');
  if (!armed) {
    note(results, 'px4-offboard-rate', true, 'skipped — not armed', {});
    return;
  }

  async function runAtRate(rateHz) {
    const { samples, unsub } = attachSampler(conn, sysid);
    const target = { sysid, compid: 1 };
    const message = buildMoveMessage({
      mode: 'velocity',
      frame: MAV_FRAME.LOCAL_NED,
      target,
      velocity: { north: 0.5, east: 0, up: 0 },
    });
    const stream = createMoveStream({
      connection: conn,
      message,
      target,
      rateHz,
      ttlMs: 0,
    });
    stream.start();
    // Prefill setpoints, then DO_SET_MODE with main_mode=6 (OFFBOARD).
    await sleep(1500);
    requestPx4Offboard(conn, sysid);
    await sleep(1200);
    const t0 = Date.now();
    await sleep(8000);
    const peerEnd = conn.peerTable.getComponent(sysid, 1)?.flightMode;
    const armedEnd = !!conn.peerTable.getComponent(sysid, 1)?.armed;
    stream.stop();
    unsub();
    const hbs = samples.filter((s) => s.kind === 'hb' && s.t >= t0 + 1000);
    const modes = hbs.map((s) => ({
      customMode: s.customMode,
      main: (Number(s.customMode) >> 16) & 0xff,
    }));
    const offboardCount = hbs.filter((s) => isPx4Offboard(s.customMode)).length;
    const entered = hbs.some((s) => isPx4Offboard(s.customMode)) || isPx4Offboard(peerEnd);
    const stayed = entered && hbs.length > 0 && offboardCount / hbs.length > 0.7;
    return {
      rateHz,
      entered,
      stayed,
      hb: hbs.length,
      offboardFrac: hbs.length ? offboardCount / hbs.length : 0,
      lastCustom: hbs.length ? hbs[hbs.length - 1].customMode : null,
      peerEnd,
      armedEnd,
      modeSample: modes.slice(-5),
    };
  }

  const at5 = await runAtRate(5);
  await sleep(1500);
  sendCmd(conn, sysid, 176, [1, 3, 0, 0, 0, 0, 0]); // POSCTL
  await sleep(1500);
  const at1 = await runAtRate(1);
  await sleep(1500);
  sendCmd(conn, sysid, 176, [1, 3, 0, 0, 0, 0, 0]);
  await sleep(1000);
  // Full setpoint silence while still in OFFBOARD — COM_OF_LOSS_T path.
  const silence = await (async () => {
    const { samples, unsub } = attachSampler(conn, sysid);
    const target = { sysid, compid: 1 };
    const message = buildMoveMessage({
      mode: 'velocity',
      frame: MAV_FRAME.LOCAL_NED,
      target,
      velocity: { north: 0, east: 0, up: 0 },
    });
    const stream = createMoveStream({
      connection: conn,
      message,
      target,
      rateHz: 5,
      ttlMs: 0,
    });
    stream.start();
    await sleep(1000);
    requestPx4Offboard(conn, sysid);
    await sleep(1500);
    const modeBefore = conn.peerTable.getComponent(sysid, 1)?.flightMode;
    stream.stop();
    const t0 = Date.now();
    await sleep(3500);
    unsub();
    const modeAfter = conn.peerTable.getComponent(sysid, 1)?.flightMode;
    const hbs = samples.filter((s) => s.kind === 'hb' && s.t >= t0 + 1500);
    return {
      modeBefore,
      modeAfter,
      lost: isPx4Offboard(modeBefore) && !isPx4Offboard(modeAfter),
      lateOffFrac: hbs.length
        ? hbs.filter((s) => isPx4Offboard(s.customMode)).length / hbs.length
        : null,
    };
  })();

  const dropsAt1 = at5.stayed && !at1.stayed;
  note(results, 'px4-offboard-rate', true, dropsAt1
    ? 'OFFBOARD held at 5 Hz and dropped at 1 Hz — advisory/editor hint justified'
    : at5.stayed && at1.stayed && silence.lost
      ? 'OFFBOARD held at 5 Hz and 1 Hz; full silence left OFFBOARD (COM_OF_LOSS_T) — 2 Hz hard floor not confirmed'
      : at5.stayed && at1.stayed
        ? 'OFFBOARD held at both 5 Hz and 1 Hz on this SIH — 2 Hz floor not confirmed here'
        : 'OFFBOARD did not stably engage — inconclusive on this SIH arming path', {
    at5,
    at1,
    silence,
    dropsAt1,
    comOfLossT: 1.0,
  });
}

async function main() {
  const results = [];
  console.log('work dir', WORK);

  // --- ArduPilot ---
  const ap = makeConn({
    bindPort: 14550,
    remotePort: 14551,
    sysid: 1,
    firmware: 'ardupilot',
    autopilot: 3,
    dialect: 'ardupilotmega',
  });
  await ap.start();
  await sleep(3000);
  try {
    await apGuidedArmTakeoff(ap, 1, results);
    await probeHaltReplace(ap, 1, results, MAV_FRAME.LOCAL_NED);
    await sleep(1000);
    await probeHaltReplace(ap, 1, results, MAV_FRAME.GLOBAL_RELATIVE_ALT);
    await sleep(1000);
    await probeYawOnly(ap, 1, results);
    await sleep(1000);
    await probeGuidTimeout(ap, 1, results);
    await probeGuidYawPark(ap, 1, results);
    await sleep(1000);
    await probeYawAndRate(ap, 1, results, 'ap');
  } catch (err) {
    note(results, 'ap-fatal', false, String(err && err.message ? err.message : err));
  }
  // Land / disarm best-effort
  try {
    sendCmd(ap, 1, 21, [0, 0, 0, 0, 0, 0, 0]);
    await sleep(2000);
    sendCmd(ap, 1, 400, [0, 21196, 0, 0, 0, 0, 0]);
  } catch (_e) { /* ignore */ }
  await new Promise((resolve) => ap.close(() => resolve()));

  // --- PX4 ---
  const prep = prepPx4LabParams();
  note(results, 'px4-lab-params', prep.ok, prep.ok
    ? 'disarm/battery helpers applied'
    : `docker exec failed status=${prep.status}`, prep);

  const px4 = makeConn({
    bindPort: 14560,
    remotePort: 14561,
    sysid: 11,
    firmware: 'px4',
    autopilot: 12,
    dialect: 'common',
  });
  await px4.start();
  await sleep(3000);
  try {
    await probePx4OffboardRate(px4, 11, results);
    // Climb via position setpoint in OFFBOARD, then yaw+rate probes.
    const target = { sysid: 11, compid: 1 };
    requestTelemetry(px4, 11);
    const climb = buildMoveMessage({
      mode: 'position',
      frame: MAV_FRAME.LOCAL_NED,
      target,
      position: { north: 0, east: 0, up: 10 },
    });
    const climbStream = createMoveStream({
      connection: px4,
      message: climb,
      target,
      rateHz: 5,
      ttlMs: 0,
    });
    climbStream.start();
    await sleep(1000);
    requestPx4Offboard(px4, 11);
    const climbSamp = attachSampler(px4, 11);
    const climbDeadline = Date.now() + 25000;
    let z = 0;
    while (Date.now() < climbDeadline) {
      await sleep(800);
      const ned = [...climbSamp.samples].reverse().find((s) => s.kind === 'ned');
      z = ned ? ned.z : z;
      if (z < -5) break;
    }
    climbSamp.unsub();
    note(results, 'px4-climb', z < -5, `ned.z=${z}`);
    climbStream.stop();
    const px4Off = isPx4Offboard(px4.peerTable.getComponent(11, 1)?.flightMode);
    note(results, 'px4-offboard-for-yaw', px4Off, px4Off
      ? 'OFFBOARD engaged for yaw+rate probe'
      : 'OFFBOARD not engaged — yaw+rate probe degraded');
    await probeYawAndRate(px4, 11, results, 'px4');
  } catch (err) {
    note(results, 'px4-fatal', false, String(err && err.message ? err.message : err));
  }
  try {
    sendCmd(px4, 11, 400, [0, 21196, 0, 0, 0, 0, 0]);
  } catch (_e) { /* ignore */ }
  await new Promise((resolve) => px4.close(() => resolve()));

  const summary = {
    when: new Date().toISOString(),
    commit: require('child_process').execSync('git rev-parse --short HEAD', { cwd: ROOT, encoding: 'utf8' }).trim(),
    workDir: WORK,
    results,
  };
  fs.writeFileSync(OUT, JSON.stringify(summary, null, 2), { mode: 0o600 });
  console.log('WROTE', OUT);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
