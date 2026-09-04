#!/usr/bin/env node
'use strict';

/**
 * SITL: peer-table enrichment while airborne (DESIGN.md §8).
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
const { buildMoveMessage, createMoveStream, MAV_FRAME } = require(path.join(ROOT, 'lib/move'));

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'nrc-peer-table-'));
const OUT = path.join(WORK, 'peer-table-results.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** AUTOPILOT_VERSION.capabilities arrives as BigInt from the codec. */
function jsonSafe(value) {
  return JSON.parse(
    JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? v.toString() : v))
  );
}

/** Lab helpers so SIH stays armed for OFFBOARD flight (see Move measure / §14). */
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

function note(results, name, ok, detail, extra) {
  const row = jsonSafe({ name, ok, detail, ...(extra || {}) });
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

function sendCmd(conn, sysid, command, params, confirmation = 0) {
  const msg = buildCommandLong(command, sysid, 1, params, confirmation);
  conn.send(msg, { band: BAND.CONTROL, target: { sysid, compid: 1 } });
}

/** Streams that feed §8 sources + one-shot requests for version/home. */
function requestPeerTelemetry(conn, sysid) {
  for (const streamId of [0, 1, 2, 3, 4, 6, 10, 11, 12]) {
    sendCmd(conn, sysid, 66, [streamId, 100000, 1, 0, 0, 0, 0]);
  }
  // SET_MESSAGE_INTERVAL: SYS_STATUS(1), GPS_RAW_INT(24), GLOBAL_POSITION_INT(33),
  // BATTERY_STATUS(147), ATTITUDE unused by peer table but cheap.
  for (const [id, us] of [
    [1, 500000],
    [24, 200000],
    [33, 100000],
    [147, 1000000],
  ]) {
    sendCmd(conn, sysid, 511, [id, us, 0, 0, 0, 0, 0]);
  }
  // REQUEST_MESSAGE AUTOPILOT_VERSION (148), HOME_POSITION (242)
  sendCmd(conn, sysid, 512, [148, 0, 0, 0, 0, 0, 0]);
  sendCmd(conn, sysid, 512, [242, 0, 0, 0, 0, 0, 0]);
  // REQUEST_AUTOPILOT_CAPABILITIES
  sendCmd(conn, sysid, 520, [1, 0, 0, 0, 0, 0, 0]);
  // GET_HOME_POSITION
  sendCmd(conn, sysid, 410, [0, 0, 0, 0, 0, 0, 0]);
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

function isPx4Offboard(customMode) {
  return ((Number(customMode) >> 16) & 0xff) === 6;
}

function requestPx4Offboard(conn, sysid) {
  sendCmd(conn, sysid, 176, [1, 6, 0, 0, 0, 0, 0]);
}

async function apGuidedArmTakeoff(conn, sysid, results, tag) {
  await waitPeer(conn, sysid);
  requestPeerTelemetry(conn, sysid);
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
  note(results, `${tag}-prep`, true, 'GUIDED+armed');
  sendCmd(conn, sysid, 22, [0, 0, 0, 0, 0, 0, 12]);
  const climbDeadline = Date.now() + 45000;
  let relMm = 0;
  while (Date.now() < climbDeadline) {
    const pos = conn.peerTable.getComponent(sysid, 1)?.position;
    relMm = pos && pos.relativeAlt != null ? Number(pos.relativeAlt) : 0;
    if (relMm > 8000) break;
    await sleep(1000);
  }
  note(results, `${tag}-takeoff`, relMm > 8000, `relativeAltMm=${relMm}`);
  if (relMm <= 8000) throw new Error(`takeoff did not reach 8 m (relMm=${relMm})`);
  requestPeerTelemetry(conn, sysid);
}

async function px4OffboardClimb(conn, sysid, results, tag) {
  await waitPeer(conn, sysid);
  requestPeerTelemetry(conn, sysid);
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
  note(results, `${tag}-prep`, true, 'armed');
  const target = { sysid, compid: 1 };
  const climb = buildMoveMessage({
    mode: 'position',
    frame: MAV_FRAME.LOCAL_NED,
    target,
    position: { north: 0, east: 0, up: 12 },
  });
  const stream = createMoveStream({
    connection: conn,
    message: climb,
    target,
    rateHz: 5,
    ttlMs: 0,
  });
  stream.start();
  await sleep(1000);
  requestPx4Offboard(conn, sysid);
  const climbDeadline = Date.now() + 30000;
  let relMm = 0;
  while (Date.now() < climbDeadline) {
    const pos = conn.peerTable.getComponent(sysid, 1)?.position;
    // GLOBAL relative_alt is mm; also accept local z via GPI once airborne.
    relMm = pos && pos.relativeAlt != null ? Number(pos.relativeAlt) : 0;
    if (relMm > 5000) break;
    if (!isPx4Offboard(conn.peerTable.getComponent(sysid, 1)?.flightMode)) {
      requestPx4Offboard(conn, sysid);
    }
    await sleep(800);
  }
  stream.stop();
  note(results, `${tag}-takeoff`, relMm > 5000, `relativeAltMm=${relMm}`);
  if (relMm <= 5000) throw new Error(`PX4 climb did not reach 5 m (relMm=${relMm})`);
  requestPeerTelemetry(conn, sysid);
}

async function flyAround(conn, sysid) {
  const target = { sysid, compid: 1 };
  const legs = [
    { north: 2, east: 0, up: 0 },
    { north: 0, east: 2, up: 0 },
    { north: -1, east: -1, up: 0 },
  ];
  for (const velocity of legs) {
    const message = buildMoveMessage({
      mode: 'velocity',
      frame: MAV_FRAME.LOCAL_NED,
      target,
      velocity,
    });
    const stream = createMoveStream({
      connection: conn,
      message,
      target,
      rateHz: 5,
      ttlMs: 0,
    });
    stream.start();
    // Reaffirm OFFBOARD on PX4 between legs (AP stays GUIDED without help).
    const mode = conn.peerTable.getComponent(sysid, 1)?.flightMode;
    if (isPx4Offboard(mode)) requestPx4Offboard(conn, sysid);
    await sleep(3500);
    stream.stop();
    await sleep(400);
  }
}

function sectionFresh(component, name, maxAgeMs) {
  const sec = component.sections && component.sections[name];
  if (!sec || sec.lastSeen == null) return { ok: false, ageMs: null };
  const ageMs = Date.now() - Number(sec.lastSeen);
  return { ok: ageMs <= maxAgeMs, ageMs };
}

function assertPeerFields(conn, sysid, results, tag, opts) {
  const c = conn.peerTable.getComponent(sysid, 1);
  if (!c) {
    note(results, `${tag}-component`, false, 'missing component');
    return;
  }
  const snapPeer = conn.peerTable.snapshot().find((p) => Number(p.sysid) === Number(sysid));
  const snap = snapPeer && snapPeer.components.find((x) => Number(x.compid) === 1);

  note(results, `${tag}-identity`, c.type != null && c.autopilot != null && c.systemStatus != null,
    `type=${c.type} autopilot=${c.autopilot} systemStatus=${c.systemStatus} flightMode=${c.flightMode}`,
    { type: c.type, autopilot: c.autopilot, systemStatus: c.systemStatus, flightMode: c.flightMode });

  note(results, `${tag}-armed-active`, c.armed === true && c.state === 'active',
    `armed=${c.armed} state=${c.state}`);

  const epOk = Boolean(c.primaryEndpoint) && c.endpoints && c.endpoints.size > 0;
  note(results, `${tag}-endpoints`, epOk,
    epOk ? `primary=${c.primaryEndpoint} n=${c.endpoints.size}` : 'no primary endpoint');

  const pos = c.position;
  const posOk = Boolean(pos && Number.isFinite(pos.lat) && Number.isFinite(pos.lon)
    && Number(pos.relativeAlt) > (opts.minRelMm || 5000));
  note(results, `${tag}-position`, posOk,
    pos ? `lat=${pos.lat} lon=${pos.lon} relMm=${pos.relativeAlt} hdg=${pos.heading}` : 'null',
    { position: pos });

  const gps = c.gps;
  const gpsOk = Boolean(gps && Number(gps.fixType) >= 3 && Number(gps.satellites) > 0);
  note(results, `${tag}-gps`, gpsOk,
    gps ? `fixType=${gps.fixType} sats=${gps.satellites}` : 'null', { gps });

  const bat = c.battery;
  const batOk = Boolean(bat && (
    (bat.batteryVoltage != null && bat.batteryVoltage !== 65535)
    || bat.remaining != null
    || bat.batteryRemaining != null
  ));
  note(results, `${tag}-battery`, batOk, bat ? JSON.stringify(bat) : 'null', { battery: bat });

  const home = c.home;
  const homeOk = Boolean(home && Number.isFinite(home.lat) && Number.isFinite(home.lon));
  note(results, `${tag}-home`, homeOk, home ? JSON.stringify(home) : 'null', { home });

  for (const [sec, maxAge] of [
    ['heartbeat', 5000],
    ['position', 5000],
    ['gps', 10000],
    ['battery', 15000],
    ['home', 120000],
  ]) {
    const fresh = sectionFresh(c, sec, maxAge);
    // home section may be absent if HOME_POSITION never arrived — already noted above
    if (sec === 'home' && !c.home) {
      note(results, `${tag}-section-${sec}`, false, 'no home section (no HOME_POSITION yet)', fresh);
    } else {
      note(results, `${tag}-section-${sec}`, fresh.ok, `ageMs=${fresh.ageMs}`, fresh);
    }
  }

  const ver = c.autopilotVersion;
  const verOk = Boolean(ver && ver.flightSwVersion != null);
  note(results, `${tag}-autopilot-version`, verOk,
    verOk ? JSON.stringify(ver) : 'no AUTOPILOT_VERSION (PARTIAL-ok if SIH mute)',
    { autopilotVersion: ver, capabilities: c.capabilities });

  const texts = c.statustext || [];
  note(results, `${tag}-statustext`, true,
    texts.length ? `${texts.length} line(s)` : 'none observed (best-effort)',
    { count: texts.length, sample: texts.slice(-3) });

  // Snapshot projection: units converted, same presence.
  const snapOk = Boolean(snap && snap.armed === true && snap.position
    && Number(snap.position.relativeAlt) > (opts.minRelM || 5)
    && snap.gps && Number(snap.gps.fixType) >= 3
    && snap.battery
    && Array.isArray(snap.endpoints) && snap.endpoints.some((e) => e.primary));
  note(results, `${tag}-snapshot`, snapOk,
    snapOk ? 'snapshot projects armed+position+gps+battery+primary' : 'snapshot incomplete',
    {
      snapArmed: snap && snap.armed,
      snapRelAlt: snap && snap.position && snap.position.relativeAlt,
      snapGps: snap && snap.gps,
      snapBattery: snap && snap.battery,
      snapHome: snap && snap.home,
      snapSections: snap && snap.sections,
    });
}

async function runStack(label, connOpts, flyPrep, results) {
  const conn = makeConn(connOpts);
  await conn.start();
  await sleep(2500);
  try {
    await flyPrep(conn, connOpts.sysid, results, label);
    const before = conn.peerTable.getComponent(connOpts.sysid, 1)?.position;
    await flyAround(conn, connOpts.sysid);
    requestPeerTelemetry(conn, connOpts.sysid);
    await sleep(2000);
    const after = conn.peerTable.getComponent(connOpts.sysid, 1)?.position;
    const moved = before && after
      && (Math.abs(Number(after.lat) - Number(before.lat)) > 50
        || Math.abs(Number(after.lon) - Number(before.lon)) > 50);
    note(results, `${label}-moved`, Boolean(moved),
      moved ? 'lat/lon changed during velocity legs' : 'lat/lon unchanged (still assert enrichment)',
      { before, after });
    assertPeerFields(conn, connOpts.sysid, results, label, {
      minRelMm: label.startsWith('px4') ? 4000 : 7000,
      minRelM: label.startsWith('px4') ? 4 : 7,
    });
  } catch (err) {
    note(results, `${label}-fatal`, false, String(err && err.message ? err.message : err));
  }
  try {
    sendCmd(conn, connOpts.sysid, 21, [0, 0, 0, 0, 0, 0, 0]);
    await sleep(2000);
    sendCmd(conn, connOpts.sysid, 400, [0, 21196, 0, 0, 0, 0, 0]);
  } catch (_e) { /* ignore */ }
  await new Promise((resolve) => conn.close(() => resolve()));
}

async function main() {
  const results = [];
  console.log('work dir', WORK);

  await runStack(
    'ap',
    {
      bindPort: 14550,
      remotePort: 14551,
      sysid: 1,
      firmware: 'ardupilot',
      autopilot: 3,
      dialect: 'ardupilotmega',
    },
    apGuidedArmTakeoff,
    results
  );

  const prep = prepPx4LabParams();
  note(results, 'px4-lab-params', prep.ok, prep.ok ? 'helpers applied' : `status=${prep.status}`, prep);

  await runStack(
    'px4',
    {
      bindPort: 14560,
      remotePort: 14561,
      sysid: 11,
      firmware: 'px4',
      autopilot: 12,
      dialect: 'common',
    },
    px4OffboardClimb,
    results
  );

  const required = results.filter((r) =>
    /-identity$|-armed-active$|-endpoints$|-position$|-gps$|-battery$|-home$|-snapshot$/.test(r.name)
  );
  const failed = required.filter((r) => !r.ok);
  const summary = {
    when: new Date().toISOString(),
    commit: require('child_process').execSync('git rev-parse --short HEAD', {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim(),
    workDir: WORK,
    requiredPass: required.length - failed.length,
    requiredTotal: required.length,
    failed: failed.map((r) => r.name),
    results,
  };
  fs.writeFileSync(OUT, JSON.stringify(jsonSafe(summary), null, 2), { mode: 0o600 });
  console.log('WROTE', OUT);
  console.log(JSON.stringify({
    requiredPass: summary.requiredPass,
    requiredTotal: summary.requiredTotal,
    failed: summary.failed,
  }));
  if (failed.length) process.exitCode = 2;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
