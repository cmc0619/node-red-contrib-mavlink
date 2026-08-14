'use strict';

const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');
















test('mavlink-move stream: a replaced or closed stream expires silently', async () => {
  const conn = { vehicle: {}, send() {} };
  const RED = redStub({ conn });
  require('../../nodes/mavlink-move')(RED);
  const Node = RED.nodes.types['mavlink-move'];
  const node = new Node({
    delivery: 'stream',
    action: 'steer',
    reference: 'world',
    vNorth: 1,
    vEast: 0,
    vUp: 0,
    connection: 'conn',
    targetSystem: 1,
    targetComponent: 1,
    rateHz: 200,
    ttlMs: 0,
  });

  const emitted = [];
  node.send = (messages) => { emitted.push(messages); };

  // The flow caused both of these, so neither needs announcing back to it.
  node.emit('input', { payload: {} }, () => {}, () => {});
  node.emit('input', { payload: {} }, () => {}, () => {});
  await new Promise((resolve) => setTimeout(resolve, 30));
  node.emit('close', () => {});
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(emitted.length, 0, 'replacement and close emit nothing');
});

test('mavlink-move stream: one owner per (connection, target) — a second node is refused, the owner may replace itself (#176)', () => {
  const conn = { id: 'conn', vehicle: {}, send() {} };
  const RED = redStub({ conn });
  require('../../nodes/mavlink-move')(RED);
  const Node = RED.nodes.types['mavlink-move'];
  const cfg = {
    delivery: 'stream',
    action: 'steer',
    reference: 'world',
    vNorth: 1,
    vEast: 0,
    vUp: 0,
    connection: 'conn',
    targetSystem: 1,
    targetComponent: 1,
    rateHz: 200,
    ttlMs: 0,
  };
  const a = new Node({ ...cfg });
  const b = new Node({ ...cfg });

  a.emit('input', { payload: {} }, () => {}, () => {});

  // Another node streaming to the held target fails loudly — no takeover.
  let sent;
  let doneError;
  b.emit('input', { payload: {} }, (m) => { sent = m; }, (err) => { doneError = err; });
  assert.equal(sent[0], null, 'conflict must not fire the continue port');
  assert.equal(sent[1].result, 'failed');
  assert.match(doneError.message, /stream to 1\.1 is already running on this connection/);

  // The owner replacing its own stream is single-flight, not a conflict.
  let replaced;
  a.emit('input', { payload: {} }, (m) => { replaced = m; }, () => {});
  assert.equal(replaced[1].result, 'streaming', 'same node re-acquires its own scope');

  // A different target on the same connection is a different vehicle: free.
  let other;
  b.emit('input', { payload: { target: { sysid: 2, compid: 1 } } }, (m) => { other = m; }, () => {});
  assert.equal(other[1].result, 'streaming', 'other targets stay free');

  // Close releases the scope for the next owner.
  a.emit('close', () => {});
  let after;
  b.emit('input', { payload: {} }, (m) => { after = m; }, () => {});
  assert.equal(after[1].result, 'streaming', 'close freed the target');
  b.emit('close', () => {});
});

test('mavlink-move stream: TTL expiry frees the target for another node (#176)', async () => {
  const conn = { id: 'conn', vehicle: {}, send() {} };
  const RED = redStub({ conn });
  require('../../nodes/mavlink-move')(RED);
  const Node = RED.nodes.types['mavlink-move'];
  const cfg = {
    delivery: 'stream',
    action: 'steer',
    reference: 'world',
    vNorth: 1,
    vEast: 0,
    vUp: 0,
    connection: 'conn',
    targetSystem: 1,
    targetComponent: 1,
    rateHz: 200,
    ttlMs: 0,
  };
  const a = new Node({ ...cfg, ttlMs: 20 });
  const b = new Node({ ...cfg });

  const emitted = [];
  a.send = (messages) => { emitted.push(messages); };
  a.emit('input', { payload: {} }, () => {}, () => {});

  const deadline = Date.now() + 2000;
  while (!emitted.length && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(emitted[0][1].result, 'expired', 'stream expired');

  let sent;
  b.emit('input', { payload: {} }, (m) => { sent = m; }, () => {});
  assert.equal(sent[1].result, 'streaming', 'expiry freed the target');
  a.emit('close', () => {});
  b.emit('close', () => {});
});





test('mavlink-move stream: stop with nothing running reports stopped with detail "no stream"', () => {
  const sends = [];
  const conn = { vehicle: {}, send(message) { sends.push(message); } };
  const RED = redStub({ conn });
  require('../../nodes/mavlink-move')(RED);
  const Node = RED.nodes.types['mavlink-move'];
  const node = new Node({
    delivery: 'stream',
    action: 'steer',
    reference: 'world',
    vNorth: 1,
    vEast: 0,
    vUp: 0,
    connection: 'conn',
    targetSystem: 1,
    targetComponent: 1,
    rateHz: 0.1,
    ttlMs: 0,
  });

  // A stop control must not punish a second press (§ "Move setpoint matrix").
  let out;
  let doneError;
  node.emit('input', { payload: { action: 'stop' } }, (m) => { out = m; }, (err) => { doneError = err; });

  assert.equal(doneError, undefined, 'stop with nothing running is not an error');
  assert.ok(out[0], 'still fires output 0');
  assert.equal(out[1].result, 'stopped');
  assert.equal(out[1].detail, 'no stream');
  assert.equal(sends.length, 0, 'nothing running, so nothing sent');
});

test('mavlink-move send delivery refuses {action:"stop"} — only the stream tier owns streams', () => {
  const conn = { vehicle: {}, send() {} };
  const RED = redStub({ conn });
  require('../../nodes/mavlink-move')(RED);
  const Node = RED.nodes.types['mavlink-move'];
  const node = new Node({
    delivery: 'send',
    action: 'steer',
    reference: 'world',
    vNorth: 1,
    vEast: 0,
    vUp: 0,
    connection: 'conn',
    targetSystem: 1,
    targetComponent: 1,
  });

  let out;
  let doneError;
  node.emit('input', { payload: { action: 'stop' } }, (m) => { out = m; }, (err) => { doneError = err; });

  assert.equal(out[0], null);
  assert.equal(out[1].result, 'failed');
  assert.match(doneError.message, /requires stream delivery/);
});

test('mavlink-move: an unknown action throws naming the valid actions', () => {
  const conn = { vehicle: {}, send() {} };
  const RED = redStub({ conn });
  require('../../nodes/mavlink-move')(RED);
  const Node = RED.nodes.types['mavlink-move'];
  const node = new Node({
    delivery: 'stream',
    action: 'steer',
    reference: 'world',
    vNorth: 1,
    vEast: 0,
    vUp: 0,
    connection: 'conn',
    targetSystem: 1,
    targetComponent: 1,
    rateHz: 0.1,
    ttlMs: 0,
  });

  let out;
  let doneError;
  node.emit('input', { payload: { action: 'hover' } }, (m) => { out = m; }, (err) => { doneError = err; });

  assert.equal(out[0], null);
  assert.equal(out[1].result, 'failed');
  assert.match(doneError.message, /unknown Move action "hover"/);
  assert.match(doneError.message, /stop/, 'names the valid actions');
});

test('mavlink-move stream: {action:"stop"} releases the target for a new stream (#176)', () => {
  const conn = { id: 'conn', vehicle: {}, send() {} };
  const RED = redStub({ conn });
  require('../../nodes/mavlink-move')(RED);
  const Node = RED.nodes.types['mavlink-move'];
  const cfg = {
    delivery: 'stream',
    action: 'steer',
    reference: 'world',
    vNorth: 1,
    vEast: 0,
    vUp: 0,
    connection: 'conn',
    targetSystem: 1,
    targetComponent: 1,
    rateHz: 0.1,
    ttlMs: 0,
  };
  const a = new Node({ ...cfg });
  const b = new Node({ ...cfg });

  a.emit('input', { payload: {} }, () => {}, () => {});
  let refused;
  b.emit('input', { payload: {} }, (m) => { refused = m; }, () => {});
  assert.equal(refused[1].result, 'failed', 'target held while a streams');

  let stopped;
  a.emit('input', { payload: { action: 'stop' } }, (m) => { stopped = m; }, () => {});
  assert.equal(stopped[1].result, 'stopped');

  let after;
  b.emit('input', { payload: {} }, (m) => { after = m; }, () => {});
  assert.equal(after[1].result, 'streaming', 'stop freed the target');
  b.emit('close', () => {});
  a.emit('close', () => {});
});

function redStub(nodesById) {
  return {
    nodes: {
      types: {},
      createNode(node, config) {
        Object.setPrototypeOf(node, EventEmitter.prototype);
        EventEmitter.call(node);
        node.id = config.id || 'node';
        node.status = () => {};
        node.error = () => {};
        node.warn = () => {};
        // Real Node-RED gives every node a send() for emits that outlive the
        // input handler — the stream-expiry message is one.
        node.send = () => {};
      },
      registerType(name, ctor) {
        this.types[name] = ctor;
      },
      getNode(id) {
        return nodesById[id];
      },
    },
  };
}

test('mavlink-move stream: expiry brake failure keeps the documented discriminator (Codex, #240)', async () => {
  // A flow following the node help switches on result === 'expired'. The one
  // moment recovery matters most — the brake never reached the wire — is
  // exactly when that switch must still match; the failure rides its own
  // brakeError field instead.
  const conn = {
    id: 'conn',
    vehicle: {},
    // The brake is deliberately shaped like a velocity setpoint (same mask
    // 3527), so the stub tells them apart by the commanded velocity: the
    // streamed setpoint carries vx=1, the brake vx=0.
    send(message) {
      if (message.fields.vx === 0) throw new Error('link down');
    },
  };
  const RED = redStub({ conn });
  require('../../nodes/mavlink-move')(RED);
  const Node = RED.nodes.types['mavlink-move'];
  const node = new Node({
    delivery: 'stream',
    action: 'steer',
    reference: 'world',
    vNorth: 1,
    vEast: 0,
    vUp: 0,
    connection: 'conn',
    targetSystem: 1,
    targetComponent: 1,
    rateHz: 200,
    ttlMs: 20,
  });

  const emitted = [];
  node.send = (messages) => { emitted.push(messages); };
  node.emit('input', { payload: {} }, () => {}, () => {});

  const deadline = Date.now() + 2000;
  while (!emitted.length && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(emitted[0][1].result, 'expired', 'the discriminator survives the brake failure');
  assert.match(emitted[0][1].brakeError, /link down/);
  assert.equal(typeof emitted[0][1].sent, 'number');
  node.emit('close', () => {});
});

test('mavlink-move stream: a failed handover send leaves the old stream running (Codex, #240)', () => {
  // The replacement's initial send throwing must not leave the vehicle with
  // no retrying stream and no brake — the old stream keeps the slot.
  const sends = [];
  let failNext = false;
  const conn = {
    id: 'conn',
    vehicle: {},
    send(message) {
      if (failNext) { failNext = false; throw new Error('identity unresolved'); }
      sends.push(message);
    },
  };
  const RED = redStub({ conn });
  require('../../nodes/mavlink-move')(RED);
  const Node = RED.nodes.types['mavlink-move'];
  const node = new Node({
    delivery: 'stream',
    action: 'steer',
    reference: 'world',
    vNorth: 1,
    vEast: 0,
    vUp: 0,
    connection: 'conn',
    targetSystem: 1,
    targetComponent: 1,
    rateHz: 0.1,
    ttlMs: 0,
  });

  node.emit('input', { payload: {} }, () => {}, () => {});
  assert.equal(sends.length, 1, 'old stream started');

  failNext = true;
  let failed;
  let doneErr;
  node.emit('input', { payload: { velocity: { north: 2, east: 0, up: 0 } } }, (m) => { failed = m; }, (err) => { doneErr = err; });
  assert.match(doneErr.message, /identity unresolved/);
  assert.equal(failed[1].result, 'failed');

  // The old stream still owns the slot: close brakes it — a dead stream
  // would have nothing to brake.
  node.emit('close', () => {});
  assert.equal(sends.length, 2, 'close braked the surviving stream');
  assert.equal(sends[1].fields.type_mask, 3527);
  assert.equal(sends[1].fields.vx, 0);
});

test('mavlink-move stream: a retarget brakes the old target after the new stream is live (Codex, #240)', () => {
  // Same-target replacement hands over brakeless; a retarget ends control of
  // the OLD target, so that vehicle gets the brake — after the new stream's
  // first send succeeded.
  const sends = [];
  const conn = { id: 'conn', vehicle: {}, send(message) { sends.push(message); } };
  const RED = redStub({ conn });
  require('../../nodes/mavlink-move')(RED);
  const Node = RED.nodes.types['mavlink-move'];
  const node = new Node({
    delivery: 'stream',
    action: 'steer',
    reference: 'world',
    vNorth: 1,
    vEast: 0,
    vUp: 0,
    connection: 'conn',
    targetSystem: 1,
    targetComponent: 1,
    rateHz: 0.1,
    ttlMs: 0,
  });

  node.emit('input', { payload: {} }, () => {}, () => {});
  node.emit('input', { payload: { target: { sysid: 2, compid: 1 } } }, () => {}, () => {});

  assert.equal(sends.length, 3, 'setpoint, handover setpoint, old-target brake');
  assert.equal(sends[0].fields.target_system, 1);
  assert.equal(sends[1].fields.target_system, 2, 'the new stream sends before the old is stopped');
  assert.equal(sends[2].fields.target_system, 1, 'the brake goes to the abandoned target');
  assert.equal(sends[2].fields.type_mask, 3527);
  node.emit('close', () => {});
});

test('mavlink-move stream: a failed retarget frees only the new scope, old stream keeps its own (Codex, #240)', () => {
  let failNext = false;
  const conn = {
    id: 'conn',
    vehicle: {},
    send() {
      if (failNext) { failNext = false; throw new Error('identity unresolved'); }
    },
  };
  const RED = redStub({ conn });
  require('../../nodes/mavlink-move')(RED);
  const Node = RED.nodes.types['mavlink-move'];
  const cfg = {
    delivery: 'stream',
    action: 'steer',
    reference: 'world',
    vNorth: 1,
    vEast: 0,
    vUp: 0,
    connection: 'conn',
    targetSystem: 1,
    targetComponent: 1,
    rateHz: 0.1,
    ttlMs: 0,
  };
  const a = new Node({ ...cfg });
  const b = new Node({ ...cfg });

  a.emit('input', { payload: {} }, () => {}, () => {});
  failNext = true;
  let doneErr;
  a.emit('input', { payload: { target: { sysid: 2, compid: 1 } } }, () => {}, (err) => { doneErr = err; });
  assert.match(doneErr.message, /identity unresolved/);

  // Target 1 is still held by a's surviving stream; target 2 was released on
  // the way out of the failed retarget.
  let held;
  b.emit('input', { payload: {} }, (m) => { held = m; }, () => {});
  assert.match(held[1].detail, /already running/);
  let freed;
  b.emit('input', { payload: { target: { sysid: 2, compid: 1 } } }, (m) => { freed = m; }, () => {});
  assert.equal(freed[1].result, 'streaming', 'the failed retarget freed its scope');
  a.emit('close', () => {});
  b.emit('close', () => {});
});

// ── Reposition carrier (#239): COMMAND_INT / DO_REPOSITION ─────────────────

/** Fake wire connection with the subscribe/resolveSourceIds surface the
 *  confirm tier's AckWaiter consumes. */
function repositionConn() {
  const sends = [];
  const subs = [];
  return {
    id: 'conn',
    vehicle: {},
    sends,
    subs,
    send(message, opts) { sends.push({ message, opts }); },
    subscribe(filter, handler) { subs.push({ filter, handler }); return () => {}; },
    resolveSourceIds() { return { sysid: 255, compid: 190 }; },
  };
}

const repositionCfg = {
  action: 'goto',
  altRef: 'home',
  lat: 47.1234567,
  lon: 8.5,
  alt: 25,
  targetSystem: 1,
  targetComponent: 1,
};




test('mavlink-move goto + Send refuses a yaw rate through the reposition builder\'s own guard', () => {
  // DO_REPOSITION carries a yaw heading only: the node adds no second guard —
  // buildRepositionMessage's refusal is the single deploy-time error path.
  const conn = repositionConn();
  const RED = redStub({ conn });
  require('../../nodes/mavlink-move')(RED);
  const Node = RED.nodes.types['mavlink-move'];
  const node = new Node({ ...repositionCfg, delivery: 'send', connection: 'conn' });

  let out;
  let doneError;
  node.emit('input', { payload: { yawRate: 10 } }, (m) => { out = m; }, (err) => { doneError = err; });
  assert.equal(out[0], null);
  assert.equal(out[1].result, 'failed');
  assert.match(doneError.message, /no yaw rate/);
  assert.equal(conn.sends.length, 0, 'nothing reached the wire');
});





test('mavlink-move reposition confirm refuses a broadcast target (sysid 0): nothing sent, failed record, done(err) (#260)', () => {
  // The ack matcher accepts any source at sysid 0 — the first vehicle to
  // answer would settle the goto for the whole fleet. Thrown before any send
  // or subscription, through the same failInput path as the carrier refusals.
  const conn = repositionConn();
  const RED = redStub({ conn });
  require('../../nodes/mavlink-move')(RED);
  const Node = RED.nodes.types['mavlink-move'];
  const node = new Node({ ...repositionCfg, targetSystem: 0, delivery: 'confirm', connection: 'conn' });

  let out;
  let doneError;
  node.emit('input', { payload: {} }, (m) => { out = m; }, (err) => { doneError = err; });

  assert.equal(conn.sends.length, 0, 'nothing reached the wire');
  assert.equal(conn.subs.length, 0, 'no COMMAND_ACK subscription opened');
  assert.equal(out[0], null, 'output 0 must not fire');
  assert.equal(out[1].result, 'failed');
  assert.match(out[1].detail, /broadcast \(sysid 0\)/);
  assert.ok(doneError instanceof Error);
});





