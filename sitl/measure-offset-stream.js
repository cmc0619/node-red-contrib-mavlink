#!/usr/bin/env node
'use strict';

/**
 * SITL: confirm offset-frame stream walks the vehicle (DESIGN.md 14.100-stream).
 * AP sysid 1 :14550 — streams LOCAL_OFFSET_NED z=-2 m at 5 Hz for 3 s.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { Connection } = require('../lib/connection/runtime');
const { BAND } = require('../lib/connection/bands');
const { loadBundled } = require('../lib/metadata/bundled');
const { buildCommandLong } = require('../lib/command/carrier');
const { buildMoveMessage, createMoveStream, MAV_FRAME } = require('../lib/move');

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'nrc-offset-stream-'));
const OUT = path.join(WORK, 'offset-stream-results.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
      vehicle: { targetSystem: 1, targetComponent: 1, bundle, firmware: 'ardupilot', autopilot: 3 },
      identities: [{
        id: 'gcs', sysid: 255, compid: 190,
        heartbeat: { type: 6, autopilot: 8, systemStatus: 4, baseMode: 0, customMode: 0, mavlinkVersion: 3 },
        heartbeatIntervalMs: 500,
      }],
      defaultIdentityId: 'gcs',
      boundIdentityIds: ['gcs'],
      signing: { linkId: 0, signOutbound: false, requireSigned: false, acceptInvalid: false, hasKey: false },
      heartbeat: { staleMs: 5000, expireMs: 15000 },
    },
    { resolveIdentity, logger: { info() {}, warn() {}, error() {} } }
  );
}

function sendCmd(conn, command, params) {
  const msg = buildCommandLong(command, 1, 1, params, 0);
  conn.send(msg, { band: BAND.CONTROL, target: { sysid: 1, compid: 1 } });
}

function requestPeerTelemetry(conn) {
  for (const streamId of [0, 1, 2, 3, 4, 6, 10, 11, 12]) {
    sendCmd(conn, 66, [streamId, 100000, 1, 0, 0, 0, 0]);
  }
  for (const [id, us] of [[1, 500000], [24, 200000], [33, 100000], [147, 1000000]]) {
    sendCmd(conn, 511, [id, us, 0, 0, 0, 0, 0]);
  }
}

async function waitPeer(conn) {
  const start = Date.now();
  while (Date.now() - start < 60000) {
    const c = conn.peerTable.getComponent(1, 1);
    if (c && c.primaryEndpoint) return c;
    await sleep(200);
  }
  throw new Error('peer not learned');
}

async function apGuidedArmTakeoff(conn) {
  await waitPeer(conn);
  requestPeerTelemetry(conn);
  await sleep(1000);
  const modeDeadline = Date.now() + 120000;
  while (Date.now() < modeDeadline) {
    const c = conn.peerTable.getComponent(1, 1);
    if (c && c.flightMode === 4) break;
    if (c?.armed) {
      sendCmd(conn, 400, [0, 21196, 0, 0, 0, 0, 0]);
      await sleep(500);
    }
    sendCmd(conn, 176, [1, 4, 0, 0, 0, 0, 0]);
    await sleep(1000);
  }
  if (conn.peerTable.getComponent(1, 1)?.flightMode !== 4) {
    throw new Error('AP did not enter GUIDED');
  }
  const armDeadline = Date.now() + 120000;
  while (Date.now() < armDeadline) {
    if (conn.peerTable.getComponent(1, 1)?.armed) break;
    sendCmd(conn, 400, [1, 0, 0, 0, 0, 0, 0]);
    await sleep(2000);
  }
  if (!conn.peerTable.getComponent(1, 1)?.armed) {
    throw new Error('AP did not arm');
  }
  sendCmd(conn, 22, [0, 0, 0, 0, 0, 0, 12]);
  const climbDeadline = Date.now() + 45000;
  let relMm = 0;
  while (Date.now() < climbDeadline) {
    const pos = conn.peerTable.getComponent(1, 1)?.position;
    relMm = pos && pos.relativeAlt != null ? Number(pos.relativeAlt) : 0;
    if (relMm > 8000) break;
    await sleep(1000);
  }
  if (relMm <= 8000) throw new Error(`takeoff did not reach 8 m (relMm=${relMm})`);
  requestPeerTelemetry(conn);
}

async function main() {
  const conn = makeConn();
  const samples = [];
  await conn.start();
  const unsub = conn.subscribe({}, (decoded) => {
    if (!decoded || Number(decoded.sysid) !== 1) return;
    const f = decoded.fields || {};
    if (decoded.name === 'GLOBAL_POSITION_INT') {
      samples.push({ t: Date.now(), relMm: Number(f.relative_alt) });
    }
  });
  await sleep(2000);
  await apGuidedArmTakeoff(conn);

  const target = { sysid: 1, compid: 1 };
  const msg = buildMoveMessage({
    mode: 'position',
    frame: MAV_FRAME.LOCAL_OFFSET_NED,
    target,
    position: { north: 0, east: 0, up: 2 },
  });
  const stream = createMoveStream({ connection: conn, message: msg, target, rateHz: 5, ttlMs: 3000 });
  const t0 = Date.now();
  stream.start();
  await sleep(3500);
  stream.stop();
  unsub();
  await new Promise((resolve) => conn.close(() => resolve()));

  const window = samples.filter((s) => s.t >= t0 - 500 && s.t <= t0 + 4000);
  const rel0 = window.length ? window[0].relMm : null;
  const relMax = window.reduce((m, s) => Math.max(m, s.relMm), rel0 ?? 0);
  const deltaMm = rel0 != null ? relMax - rel0 : null;
  const walked = deltaMm != null && deltaMm > 1500;

  const result = {
    measuredAt: new Date().toISOString(),
    frame: 'LOCAL_OFFSET_NED',
    rateHz: 5,
    durationMs: 3000,
    offsetUpM: 2,
    rel0Mm: rel0,
    relMaxMm: relMax,
    deltaMm,
    walked,
    sampleCount: window.length,
    withholdValidated: walked,
  };
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(result));
  console.error(`wrote ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
