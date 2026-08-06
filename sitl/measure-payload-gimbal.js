#!/usr/bin/env node
'use strict';

/**
 * Probe Copter-4.7.0 SITL --gimbal for Payload-node verbs.
 * Writes /tmp/payload-gimbal-results.json
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BIND = 14570;
const SYSID = 31;
const OUT = '/tmp/payload-gimbal-results.json';
const CONTAINER = 'nrc-measure-payload-31';
const IMAGE = 'nrc-mavlink-ap-sitl:local';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function sh(cmd, timeoutMs = 60000) {
  const r = spawnSync('bash', ['-c', cmd], {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
  });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

function gatewayIp() {
  const r = sh(
    `docker network inspect sitl_default -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}' 2>/dev/null`
  );
  const ip = (r.out || '').trim().split('\n')[0];
  if (!ip) throw new Error('could not resolve sitl_default gateway');
  return ip;
}

function startVehicle(parmBody) {
  const parmHost = '/tmp/ap-payload-measure.parm';
  fs.writeFileSync(parmHost, `${parmBody.trim()}\n`);
  const gw = gatewayIp();
  sh(`docker rm -f ${CONTAINER} >/dev/null 2>&1 || true`);
  // Must join sitl_default so host→container UDP replies reach the vehicle
  // (HEARTBEATs can hairpin via the gateway; COMMAND_ACK return path cannot).
  const run = sh(
    `docker run -d --name ${CONTAINER} --platform linux/amd64 --network sitl_default ` +
      `--entrypoint bash ` +
      `-v ${parmHost}:/params/ap-payload.parm:ro ` +
      `${IMAGE} -lc ` +
      `'set -e; mkdir -p /home/sitl/aircraft/lab-ap-${SYSID}; cd /home/sitl/aircraft/lab-ap-${SYSID}; ` +
      `rm -rf logs; ln -sfn /tmp logs; ` +
      `exec /usr/local/bin/arducopter -w -I 20 --model quad --speedup 1 --sysid ${SYSID} ` +
      `--home -35.363262,149.165237,584,270 --gimbal ` +
      `--defaults /params/copter.parm,/params/ap-logging.parm,/params/ap-payload.parm ` +
      `--serial0 udpclient:${gw}:${BIND}'`
  );
  if (run.code !== 0) throw new Error(`docker run failed: ${run.out}`);
  return gw;
}

async function probe() {
  const script = `
    const { Connection, BAND } = require(${JSON.stringify(path.join(ROOT, 'lib/connection'))});
    const { loadBundled } = require(${JSON.stringify(path.join(ROOT, 'lib/metadata'))});
    const { buildPayloadMessage } = require(${JSON.stringify(path.join(ROOT, 'lib/payload'))});
    const { buildCommandLong } = require(${JSON.stringify(path.join(ROOT, 'lib/command/carrier'))});
    const resolveIdentity = (i) => ({ identityId: i.defaultIdentityId, source: 'default' });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const results = [];
    const note = (name, ok, detail, extra) => {
      const row = { name, ok, detail, ...(extra || {}) };
      results.push(row);
      console.log(JSON.stringify(row));
    };

    (async () => {
      const bundle = loadBundled('ardupilotmega');
      const conn = new Connection({
        transport: { mode: 'udp', bindAddress: '0.0.0.0', bindPort: ${BIND}, remoteAddress: '127.0.0.1', remotePort: 14571 },
        vehicle: { targetSystem: ${SYSID}, targetComponent: 1, bundle, firmware: 'ardupilot', autopilot: 3 },
        identities: [{ id: 'gcs', sysid: 255, compid: 190, heartbeat: { type: 6, autopilot: 8, systemStatus: 4, baseMode: 0, customMode: 0, mavlinkVersion: 3 }, heartbeatIntervalMs: 500 }],
        defaultIdentityId: 'gcs', boundIdentityIds: ['gcs'],
        signing: { linkId: 0, signOutbound: false, requireSigned: false, acceptInvalid: false, hasKey: false },
        heartbeat: { staleMs: 5000, expireMs: 15000 },
      }, { resolveIdentity, logger: { info() {}, warn() {}, error() {} } });
      await conn.start();
      await sleep(4000);

      const peers = (conn.peerTable && conn.peerTable.snapshot()) || [];
      const peer = peers.find((p) => Number(p.sysid) === ${SYSID});
      note('peer-learned', !!peer, peer ? 'sysid 31 present' : 'no peer', {
        comps: peer ? (peer.components || []).map((c) => c.compid) : [],
      });

      const seen = [];
      const unsub = conn.subscribe({}, (decoded) => {
        if (!decoded) return;
        seen.push({
          name: decoded.name,
          sysid: decoded.sysid,
          compid: decoded.compid,
          fields: decoded.fields,
          t: Date.now(),
        });
      });

      async function waitAck(commandId, timeoutMs = 8000) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
          const hit = [...seen].reverse().find(
            (s) => s.name === 'COMMAND_ACK' && Number(s.fields && s.fields.command) === Number(commandId)
          );
          if (hit) return hit;
          await sleep(40);
        }
        return null;
      }

      // Sanity: any COMMAND_ACK proves the pipe (DENIED still counts).
      {
        const msg = buildCommandLong(176, ${SYSID}, 1, [1, 89, 0, 0, 0, 0, 0], 0);
        conn.send(msg, { band: BAND.CONTROL, target: { sysid: ${SYSID}, compid: 1 } });
        const ack = await waitAck(176);
        note('sanity-do-set-mode', !!ack, ack
          ? ('COMMAND_ACK result=' + ack.fields.result)
          : 'no ACK — link broken', {});
      }

      async function runVerb(name, input) {
        const before = seen.length;
        const built = buildPayloadMessage(input);
        conn.send(built.message, { band: BAND.CONTROL, target: input.target });
        if (built.confirmation === 'command_ack') {
          const cmd = built.message.fields.command;
          const ack = await waitAck(cmd);
          const after = seen.slice(before).filter((s) => s.name !== 'HEARTBEAT' && s.name !== 'GLOBAL_POSITION_INT' && s.name !== 'ATTITUDE' && s.name !== 'SYS_STATUS' && s.name !== 'GPS_RAW_INT' && s.name !== 'LOCAL_POSITION_NED' && s.name !== 'VFR_HUD');
          note(name, !!(ack && Number(ack.fields.result) === 0), ack
            ? ('COMMAND_ACK result=' + ack.fields.result + ' cmd=' + cmd)
            : 'no ACK cmd=' + cmd, {
              interesting: after.map((s) => s.name + '@' + s.compid),
            });
        } else {
          await sleep(2000);
          const after = seen.slice(before).filter((s) => /GIMBAL|MOUNT|CAMERA|STATUSTEXT|COMMAND_ACK/.test(s.name));
          note(name, after.length > 0, after.length
            ? after.map((s) => s.name).join(',')
            : 'no gimbal/camera telemetry after send', {
              interesting: after.map((s) => s.name + '@' + s.compid),
            });
        }
      }

      const target = { sysid: ${SYSID}, compid: 1 };
      await runVerb('gimbal-aim-legacy', {
        topic: 'gimbal', verb: 'aim', path: 'legacy', target, carrier: 'long',
        values: { pitch: -20, roll: 0, yaw: 10 },
      });
      await runVerb('gimbal-aim-manager', {
        topic: 'gimbal', verb: 'aim', path: 'manager', target,
        values: { pitch: -15, yaw: 5, flags: 0, gimbalDeviceId: 0 },
      });
      await runVerb('camera-photo', {
        topic: 'camera', verb: 'photo', target, carrier: 'long',
        values: { cameraId: 0, count: 1, interval: 0 },
      });
      await runVerb('camera-start-video', {
        topic: 'camera', verb: 'start-video', target, carrier: 'long',
        values: { streamId: 0, statusFrequency: 0 },
      });
      await runVerb('camera-stop-video', {
        topic: 'camera', verb: 'stop-video', target, carrier: 'long',
        values: { streamId: 0 },
      });
      await runVerb('gimbal-roi-set', {
        topic: 'gimbal', verb: 'roi-set', target, carrier: 'long',
        values: { lat: -35.363262, lon: 149.165237, alt: 584 },
      });
      await runVerb('gimbal-roi-clear', {
        topic: 'gimbal', verb: 'roi-clear', target, carrier: 'long',
        values: {},
      });
      await runVerb('gimbal-set-mode', {
        topic: 'gimbal', verb: 'set-mode', target, carrier: 'long',
        values: { mode: 2, stabilizeRoll: 0, stabilizePitch: 0, stabilizeYaw: 0 },
      });

      unsub();
      const summary = {
        sysid: ${SYSID},
        bind: ${BIND},
        results,
        statusTexts: seen
          .filter((s) => s.name === 'STATUSTEXT')
          .map((s) => String((s.fields && s.fields.text) || ''))
          .slice(0, 30),
        mountOrGimbal: seen
          .filter((s) => /MOUNT|GIMBAL|CAMERA/.test(s.name))
          .slice(0, 40)
          .map((s) => ({ name: s.name, sysid: s.sysid, compid: s.compid })),
      };
      require('fs').writeFileSync(${JSON.stringify(OUT)}, JSON.stringify(summary, null, 2));
      console.log('WROTE', ${JSON.stringify(OUT)});
      conn.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 400);
    })().catch((err) => {
      console.error(err && err.stack ? err.stack : err);
      process.exit(1);
    });
  `;

  const probeRun = spawnSync('node', ['-e', script], {
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 10 * 1024 * 1024,
  });
  console.log(probeRun.stdout);
  if (probeRun.status !== 0) {
    console.error(probeRun.stderr);
    console.log('--- vehicle logs ---');
    console.log(sh(`docker logs ${CONTAINER} 2>&1 | tail -60`).out);
    throw new Error(`probe failed exit ${probeRun.status}`);
  }
}

async function main() {
  // Docs path: servo mount + --gimbal
  console.log('starting vehicle (MNT1_TYPE=1 servo + --gimbal)');
  startVehicle(`
MNT1_TYPE 1
SERVO6_FUNCTION 6
SERVO7_FUNCTION 8
SERVO8_FUNCTION 7
`);
  await sleep(8000);
  await probe();
  console.log(fs.readFileSync(OUT, 'utf8'));
  sh(`docker rm -f ${CONTAINER} >/dev/null 2>&1 || true`);
}

main().catch((err) => {
  console.error(err);
  sh(`docker rm -f ${CONTAINER} >/dev/null 2>&1 || true`);
  process.exit(1);
});
