#!/usr/bin/env node
'use strict';

/**
 * Swarm / multicast SITL measurement (entrypoint-ap-mcast.sh test brief).
 * Run on the host (ap-mcast-41 uses network_mode: host):
 *   node sitl/measure-swarm-mcast.js
 *
 * Or inside the compose bridge (PX4 subnet-broadcast leg only):
 *   SWARM_SKIP_MCAST=1 docker run --rm --network sitl_default ...
 *
 * Vehicles: ap-mcast-41 (mcast:239.255.145.50:14550), px4-bcast-42 (subnet broadcast).
 * Writes JSON under a private mkdtemp directory (mode 0600).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const { Connection, BAND } = require(path.join(ROOT, 'lib/connection'));
const { loadBundled } = require(path.join(ROOT, 'lib/metadata'));
const { buildCommandLong } = require(path.join(ROOT, 'lib/command/carrier'));

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'nrc-swarm-mcast-'));
const OUT = path.join(WORK, 'swarm-mcast-results.json');

const MCAST_GROUP = process.env.MCAST_GROUP || '239.255.145.50';
const MCAST_PORT = Number(process.env.MCAST_PORT || 14550);
const AP_SYSID = Number(process.env.AP_MCAST_SYSID || 41);
const PX4_SYSID = Number(process.env.PX4_BCAST_SYSID || 42);
const PX4_BIND_PORT = Number(process.env.PX4_BIND_PORT || 14580);
const PX4_LISTEN_PORT = Number(process.env.PX4_LISTEN_PORT || 18570);
const SUBNET_BCAST = process.env.SITL_BRIDGE_BCAST || '172.18.255.255';

const GCS_SYSID = 255;
const GCS_COMPID = 190;
const PEER_TIMEOUT_MS = Number(process.env.SWARM_PEER_MS || 45000);
const ARM_TIMEOUT_MS = Number(process.env.SWARM_ARM_MS || 30000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function note(results, name, ok, detail, extra) {
  const row = { name, ok, detail, ...(extra || {}) };
  results.push(row);
  console.log(JSON.stringify(row));
  return row;
}

function prepPx4Broadcast(container = 'nrc-px4-bcast-42') {
  if (!process.env.SWARM_SKIP_DOCKER_PREP) {
    const script = [
      'cd /opt/px4',
      './bin/px4-param set MAV_0_BROADCAST 1',
      './bin/px4-param set COM_RCL_EXCEPT 7',
      './bin/px4-param set COM_ARM_MAG_STR 0',
    ].join(' && ');
    const r = spawnSync('docker', ['exec', container, 'sh', '-lc', script], {
      encoding: 'utf8',
    });
    return { ok: r.status === 0, status: r.status, stderr: (r.stderr || '').slice(0, 500) };
  }
  return { ok: true, skipped: true };
}

function makeConn(transport, vehicleSysid) {
  const bundle = loadBundled('ardupilotmega');
  const resolveIdentity = (i) => ({ identityId: i.defaultIdentityId, source: 'default' });
  return new Connection(
    {
      transport: { mode: 'udp', ...transport },
      vehicle: {
        targetSystem: vehicleSysid,
        targetComponent: 1,
        bundle,
        firmware: vehicleSysid === PX4_SYSID ? 'px4' : 'ardupilot',
        autopilot: vehicleSysid === PX4_SYSID ? 12 : 3,
      },
      identities: [{
        id: 'gcs',
        sysid: GCS_SYSID,
        compid: GCS_COMPID,
        heartbeat: {
          type: 6,
          autopilot: 8,
          systemStatus: 4,
          baseMode: 0,
          customMode: 0,
          mavlinkVersion: 3,
        },
        heartbeatIntervalMs: 500,
      }],
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

function sendCmd(conn, sysid, command, params) {
  const msg = buildCommandLong(command, sysid, 1, params, 0);
  conn.send(msg, { band: BAND.CONTROL, target: { sysid, compid: 1 } });
}

async function waitPeer(conn, sysid, timeoutMs = PEER_TIMEOUT_MS) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const c = conn.peerTable.getComponent(sysid, 1);
    if (c && c.primaryEndpoint) return c;
    await sleep(200);
  }
  throw new Error(`peer ${sysid} not learned within ${timeoutMs}ms`);
}

async function waitArmed(conn, sysid, wantArmed, timeoutMs = ARM_TIMEOUT_MS) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (conn.peerTable.getComponent(sysid, 1)?.armed === wantArmed) return true;
    await sleep(500);
  }
  return false;
}

async function measureMcastMembership(results) {
  const conn = makeConn({
    bindAddress: '0.0.0.0',
    bindPort: MCAST_PORT,
    broadcastAddress: MCAST_GROUP,
  }, AP_SYSID);
  await conn.start();
  await sleep(2000);
  let peer;
  try {
    peer = await waitPeer(conn, AP_SYSID);
  } catch (err) {
    note(results, 'mcast-peer-41', false, err.message);
    await new Promise((resolve) => conn.close(() => resolve()));
    return { conn: null, peerSeen: false };
  }
  note(results, 'mcast-peer-41', true, `peer ${AP_SYSID} learned`, {
    endpoint: peer.primaryEndpoint,
    flightMode: peer.flightMode,
  });
  return { conn, peerSeen: true };
}

async function measureBroadcastArm(conn, results) {
  if (!conn) {
    note(results, 'mcast-broadcast-arm', false, 'skipped — no peer');
    return false;
  }
  if (conn.peerTable.getComponent(AP_SYSID, 1)?.armed) {
    sendCmd(conn, AP_SYSID, 400, [0, 21196, 0, 0, 0, 0, 0]);
    await sleep(1500);
  }
  sendCmd(conn, 0, 400, [1, 0, 0, 0, 0, 0, 0]);
  const armed = await waitArmed(conn, AP_SYSID, true);
  note(results, 'mcast-broadcast-arm', armed,
    armed ? `sysid ${AP_SYSID} armed via target_system=0` : 'no arm after broadcast COMMAND_LONG');
  return armed;
}

async function measureLoopback(results) {
  const bundle = loadBundled('ardupilotmega');
  const resolveIdentity = (i) => ({ identityId: i.defaultIdentityId, source: 'default' });
  const base = {
    bindAddress: '0.0.0.0',
    bindPort: MCAST_PORT + 1,
    broadcastAddress: MCAST_GROUP,
  };
  const listener = new Connection({
    transport: { mode: 'udp', ...base },
    vehicle: { targetSystem: AP_SYSID, targetComponent: 1, bundle, firmware: 'ardupilot', autopilot: 3 },
    identities: [{
      id: 'listener',
      sysid: 254,
      compid: 191,
      heartbeat: {
        type: 6, autopilot: 8, systemStatus: 4, baseMode: 0, customMode: 0, mavlinkVersion: 3,
      },
      heartbeatIntervalMs: 500,
    }],
    defaultIdentityId: 'listener',
    boundIdentityIds: ['listener'],
    signing: { linkId: 0, signOutbound: false, requireSigned: false, acceptInvalid: false, hasKey: false },
    heartbeat: { staleMs: 5000, expireMs: 15000 },
  }, { resolveIdentity, logger: { info() {}, warn() {}, error() {} } });

  const talker = new Connection({
    transport: { mode: 'udp', ...base },
    vehicle: { targetSystem: AP_SYSID, targetComponent: 1, bundle, firmware: 'ardupilot', autopilot: 3 },
    identities: [{
      id: 'talker',
      sysid: 253,
      compid: 192,
      heartbeat: {
        type: 6, autopilot: 8, systemStatus: 4, baseMode: 0, customMode: 0, mavlinkVersion: 3,
      },
      heartbeatIntervalMs: 500,
    }],
    defaultIdentityId: 'talker',
    boundIdentityIds: ['talker'],
    signing: { linkId: 0, signOutbound: false, requireSigned: false, acceptInvalid: false, hasKey: false },
    heartbeat: { staleMs: 5000, expireMs: 15000 },
  }, { resolveIdentity, logger: { info() {}, warn() {}, error() {} } });

  await listener.start();
  await talker.start();
  await sleep(3000);
  const heard = !!listener.peerTable.getComponent(253, 192);
  note(results, 'mcast-loopback-two-members', heard,
    heard ? 'listener saw talker heartbeat on shared multicast group' : 'no cross-member visibility');
  await new Promise((resolve) => talker.close(() => resolve()));
  await new Promise((resolve) => listener.close(() => resolve()));
  return heard;
}

async function measureSelfEcho(conn, results) {
  if (!conn) {
    note(results, 'mcast-self-echo-filter', false, 'skipped — no conn');
    return false;
  }
  sendCmd(conn, AP_SYSID, 176, [1, 4, 0, 0, 0, 0, 0]);
  await sleep(2000);
  const selfPeer = conn.peerTable.getComponent(GCS_SYSID, GCS_COMPID);
  const filtered = !selfPeer;
  note(results, 'mcast-self-echo-filter', filtered,
    filtered
      ? 'GCS identity not in peer table after multicast sends (echo filtered)'
      : 'GCS appeared as peer — self-echo filter missing');
  return filtered;
}

async function measurePx4SubnetBroadcast(results) {
  const px4Prep = prepPx4Broadcast();
  note(results, 'px4-bcast-prep', px4Prep.ok, px4Prep.ok ? 'MAV_0_BROADCAST=1' : px4Prep.stderr, px4Prep);
  await sleep(2000);

  const conn = makeConn({
    bindAddress: '0.0.0.0',
    bindPort: PX4_BIND_PORT,
    broadcastAddress: SUBNET_BCAST,
    broadcastPort: PX4_LISTEN_PORT,
  }, PX4_SYSID);
  await conn.start();
  await sleep(3000);
  let peer;
  try {
    peer = await waitPeer(conn, PX4_SYSID);
  } catch (err) {
    note(results, 'px4-bcast-peer-42', false, err.message);
    await new Promise((resolve) => conn.close(() => resolve()));
    return;
  }
  note(results, 'px4-bcast-peer-42', true, `peer ${PX4_SYSID} on subnet broadcast path`, {
    endpoint: peer.primaryEndpoint,
  });

  if (peer.armed) {
    sendCmd(conn, PX4_SYSID, 400, [0, 21196, 0, 0, 0, 0, 0]);
    await sleep(1500);
  }
  sendCmd(conn, 0, 400, [1, 0, 0, 0, 0, 0, 0]);
  const armed = await waitArmed(conn, PX4_SYSID, true);
  note(results, 'px4-bcast-broadcast-arm', armed,
    armed
      ? `sysid ${PX4_SYSID} armed via subnet broadcast target_system=0`
      : 'no arm — broadcast may not reach PX4 listen port');
  await new Promise((resolve) => conn.close(() => resolve()));
}

async function main() {
  const results = [];
  const skipMcast = process.env.SWARM_SKIP_MCAST === '1';
  const skipPx4 = process.env.SWARM_SKIP_PX4 === '1';

  if (!skipMcast) {
    const { conn } = await measureMcastMembership(results);
    await measureBroadcastArm(conn, results);
    await measureSelfEcho(conn, results);
    if (conn) await new Promise((resolve) => conn.close(() => resolve()));
    await measureLoopback(results);
  }

  if (!skipPx4) {
    await measurePx4SubnetBroadcast(results);
  }

  const peerRow = results.find((r) => r.name === 'mcast-peer-41');
  const summary = {
    measuredAt: new Date().toISOString(),
    network: { mcastGroup: MCAST_GROUP, mcastPort: MCAST_PORT, subnetBcast: SUBNET_BCAST },
    apSysid: AP_SYSID,
    px4Sysid: PX4_SYSID,
    peerSeen: peerRow ? peerRow.ok : null,
    loopbackFixExpected: true,
    selfEchoFilterExpected: true,
    skipMcast,
    skipPx4,
  };
  note(results, 'summary', skipMcast || (peerRow && peerRow.ok), 'swarm mcast measurement complete', summary);
  fs.writeFileSync(OUT, JSON.stringify({ results, summary }, null, 2), { mode: 0o600 });
  console.error(`wrote ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
