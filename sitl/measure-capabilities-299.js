#!/usr/bin/env node
'use strict';

/**
 * SITL measurement for GitHub #299 / DESIGN.md §14.82.
 * AP sysid 1 :14550, PX4 sysid 11 :14560.
 * Writes JSON under a private mkdtemp directory (mode 0600).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const { Connection } = require(path.join(ROOT, 'lib/connection/runtime'));
const { BAND } = require(path.join(ROOT, 'lib/connection/bands'));
const { loadBundled } = require(path.join(ROOT, 'lib/metadata/bundled'));
const { buildCommandLong } = require(path.join(ROOT, 'lib/command/carrier'));
// MAV_PROTOCOL_CAPABILITY_PARAM_ENCODE_BYTEWISE / _C_CAST as AUTOPILOT_VERSION
// reports them: the measurement decodes the vehicle's word with the protocol's
// own bit values, not the driver's.
const CAP_PARAM_ENCODE_BYTEWISE = 16;
const CAP_PARAM_ENCODE_C_CAST = 131072;

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'nrc-cap-299-'));
const OUT = path.join(WORK, 'capabilities-299-results.json');

const PASSIVE_MS = Number(process.env.CAP299_PASSIVE_MS || 15000);
const REQUEST_TIMEOUT_MS = Number(process.env.CAP299_REQUEST_MS || 10000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function prepPx4LabParams(container = 'nrc-px4-11') {
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

function note(results, name, ok, detail, extra) {
  const row = { name, ok, detail, ...(extra || {}) };
  results.push(row);
  console.log(JSON.stringify(row));
  return row;
}

function makeConn({ bindPort, remotePort, sysid, firmware, autopilot }) {
  const bundle = loadBundled('ardupilotmega');
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

function sendCmd(conn, sysid, command, params, confirmation = 0) {
  const msg = buildCommandLong(command, sysid, 1, params, confirmation);
  conn.send(msg, { band: BAND.CONTROL, target: { sysid, compid: 1 } });
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

function capBits(caps) {
  const n = Number(caps);
  return {
    raw: n,
    bytewise: (n & CAP_PARAM_ENCODE_BYTEWISE) !== 0,
    cCast: (n & CAP_PARAM_ENCODE_C_CAST) !== 0,
    bit4: (n & 16) !== 0,
    bit17: (n & 131072) !== 0,
  };
}

async function measureStack(label, connOpts, results) {
  const conn = makeConn(connOpts);
  await conn.start();
  let phase = 'passive';
  const passiveMessages = [];
  const afterRequest = [];
  const unsub = conn.subscribe({}, (decoded) => {
    if (!decoded || decoded.name !== 'AUTOPILOT_VERSION') return;
    if (Number(decoded.sysid) !== Number(connOpts.sysid)) return;
    const row = {
      atMs: Date.now(),
      capabilities: decoded.fields && decoded.fields.capabilities,
      flightSwVersion: decoded.fields && decoded.fields.flight_sw_version,
    };
    if (phase === 'passive') passiveMessages.push(row);
    else afterRequest.push(row);
  });

  await sleep(2000);
  await waitPeer(conn, connOpts.sysid);

  await sleep(PASSIVE_MS);
  const passiveSeen = passiveMessages.length;
  note(results, `${label}-passive`, passiveSeen === 0,
    passiveSeen === 0
      ? `no AUTOPILOT_VERSION in ${PASSIVE_MS}ms passive window`
      : `saw ${passiveSeen} unsolicited frame(s)`,
    { passiveMs: PASSIVE_MS, passiveMessages });

  phase = 'request';
  const t0 = Date.now();
  sendCmd(conn, connOpts.sysid, 512, [148, 0, 0, 0, 0, 0, 0]);
  let answer = null;
  while (Date.now() - t0 < REQUEST_TIMEOUT_MS) {
    if (afterRequest.length > 0) {
      answer = afterRequest[afterRequest.length - 1];
      break;
    }
    const peer = conn.peerTable.getComponent(connOpts.sysid, 1);
    if (peer && peer.autopilotVersion && peer.capabilities != null) {
      answer = {
        atMs: Date.now(),
        capabilities: peer.capabilities,
        flightSwVersion: peer.autopilotVersion.flightSwVersion,
        fromPeerTable: true,
      };
      break;
    }
    await sleep(50);
  }
  const latencyMs = answer ? answer.atMs - t0 : null;
  const peer = conn.peerTable.getComponent(connOpts.sysid, 1);
  const caps = answer && answer.capabilities != null
    ? answer.capabilities
    : peer && peer.capabilities;
  const bits = caps != null ? capBits(caps) : null;

  note(results, `${label}-request`, Boolean(answer),
    answer
      ? `AUTOPILOT_VERSION in ${latencyMs}ms caps=${bits && bits.raw}`
      : `no reply within ${REQUEST_TIMEOUT_MS}ms`,
    {
      latencyMs,
      capabilities: bits,
      peerCapabilities: peer && peer.capabilities != null ? capBits(peer.capabilities) : null,
      flightSwVersion: answer && answer.flightSwVersion,
    });

  unsub();
  await new Promise((resolve) => conn.close(() => resolve()));
  return { passiveSeen, bits, latencyMs };
}

async function main() {
  const results = [];
  const px4Prep = prepPx4LabParams();
  note(results, 'px4-lab-prep', px4Prep.ok, px4Prep.ok ? 'helpers set' : px4Prep.stderr, px4Prep);

  const ap = await measureStack('ap', {
    bindPort: 14550,
    remotePort: 14550,
    sysid: 1,
    firmware: 'ardupilot',
    autopilot: 3,
  }, results);

  const px4 = await measureStack('px4', {
    bindPort: 14560,
    remotePort: 14560,
    sysid: 11,
    firmware: 'px4',
    autopilot: 12,
  }, results);

  const summary = {
    measuredAt: new Date().toISOString(),
    passiveMs: PASSIVE_MS,
    ap: ap.bits,
    px4: px4.bits,
    ruling: {
      unsolicitedExpected: true,
      apBytewiseExpected: false,
      px4BytewiseExpected: true,
      probeSubsumedByHeartbeat: true,
    },
  };
  note(results, 'summary', true, 'measurement complete', summary);

  fs.writeFileSync(OUT, JSON.stringify({ results, summary }, null, 2), { mode: 0o600 });
  console.error(`wrote ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
