'use strict';

const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');

const { StubConnection } = require('../mission/stubs/connection');
const { decodePayload, OPCODE, NAK_ERROR } = require('../../lib/ftp/items');
const { paramValueToWire } = require('../../lib/codec/param-union');

function loadNode(conn, identity) {
  if (!conn.peerTable) conn.peerTable = { getComponent: () => undefined };
  const RED = {
    nodes: {
      types: {},
      createNode(node, config) {
        Object.setPrototypeOf(node, EventEmitter.prototype);
        EventEmitter.call(node);
        node.id = config.id || 'system-node';
        node.type = 'mavlink-system';
        node.status = () => {};
        node.error = () => {};
        node.log = () => {};
        node.warn = () => {};
      },
      registerType(name, ctor) { this.types[name] = ctor; },
      getNode(id) { return id === 'conn' ? conn : identity; },
    },
  };
  require('../../nodes/mavlink-system')(RED);
  return RED.nodes.types['mavlink-system'];
}

function runInput(node, msg, mutateOutput) {
  return new Promise((resolve) => {
    const outputs = [];
    node.emit('input', msg, (messages) => {
      if (mutateOutput) mutateOutput(messages);
      outputs.push(messages);
    }, (err) => resolve({ outputs, err }));
  });
}

function ftpReply(message, opcode, data = Buffer.alloc(0), options = {}) {
  const request = decodePayload(message.fields.payload);
  const payload = Buffer.alloc(251);
  payload.writeUInt16LE((request.seq + 1) & 0xffff, 0);
  payload[2] = options.session === undefined ? request.session : options.session;
  payload[3] = opcode;
  payload[4] = data.length;
  payload[5] = request.opcode;
  payload.writeUInt32LE(options.offset === undefined ? request.offset : options.offset, 8);
  data.copy(payload, 12);
  return {
    name: 'FILE_TRANSFER_PROTOCOL',
    sysid: 42,
    compid: 191,
    fields: {
      target_system: options.targetSystem === undefined ? 255 : options.targetSystem,
      target_component: options.targetComponent === undefined ? 190 : options.targetComponent,
      payload,
    },
  };
}

function paramValue({ paramId, paramType, paramIndex, paramCount, value, sysid = 42, compid = 1 }) {
  return {
    name: 'PARAM_VALUE',
    sysid,
    compid,
    fields: {
      param_id: paramId,
      param_index: paramIndex,
      param_count: paramCount,
      param_type: paramType,
      param_value: value,
    },
  };
}

const BASE = {
  connection: 'conn',
  service: 'logs',
  targetSystem: 42,
  targetComponent: 1,
  timeoutMs: 20,
  maxRetries: 1,
};

test('companion log download honors the selected component and exact byte length', async () => {
  const conn = new StubConnection();
  conn.onSend((message, deliver) => {
    if (message.name === 'LOG_REQUEST_DATA') {
      deliver({ name: 'LOG_DATA', sysid: 42, compid: 191,
        fields: { id: 7, ofs: 0, count: 90, data: Buffer.alloc(90, 5) } });
    }
  });
  const Node = loadNode(conn, {
    derivesSysidFromVehicle: true, getIdentity: () => ({ sysid: 42 }),
  });
  const node = new Node({ ...BASE, operation: 'download', logId: 7,
    identity: 'companion', targetComponent: 191, maxRetries: 0 });
  const { outputs } = await runInput(node, { payload: { size: 90 } });
  assert.equal(conn.sent[0].message.fields.target_component, 191);
  assert.equal(outputs.at(-1)[1].result, 'succeeded');
  assert.deepEqual(outputs.at(-1)[0].payload, Buffer.alloc(90, 5));
});

test('list confirm returns entries on continue and status on output 1', async () => {
  const conn = new StubConnection();
  conn.onSend((message, deliver) => {
    if (message.name === 'LOG_REQUEST_LIST') {
      deliver({
        name: 'LOG_ENTRY', sysid: 42, compid: 1,
        fields: { id: 1, num_logs: 1, last_log_num: 1, time_utc: 0, size: 15 },
      });
    }
  });
  const Node = loadNode(conn);
  const node = new Node({ ...BASE, operation: 'list' });
  const { outputs, err } = await runInput(node, { payload: {}, filename: 'logs.json' });

  assert.equal(err, undefined);
  assert.deepEqual(outputs.at(-1)[0].payload, [
    { id: 1, numLogs: 1, lastLogNum: 1, timeUtc: 0, size: 15 },
  ]);
  assert.equal(outputs.at(-1)[0].filename, 'logs.json');
  assert.equal(outputs.at(-1)[1].result, 'succeeded');
  assert.equal(outputs.at(-1)[1].node, 'mavlink-system');
});

test('download confirm emits a Buffer carrying the selected log id and closes the transfer', async () => {
  const conn = new StubConnection();
  conn.onSend((message, deliver) => {
    if (message.name === 'LOG_REQUEST_DATA') {
      deliver({
        name: 'LOG_DATA', sysid: 42, compid: 1,
        fields: { id: 7, ofs: 0, count: 3, data: Buffer.from('log') },
      });
    }
  });
  const Node = loadNode(conn);
  const node = new Node({ ...BASE, operation: 'download', logId: 7 });
  const { outputs, err } = await runInput(node, { payload: {}, filename: 'log.bin', topic: 'download' });

  assert.equal(err, undefined);
  const result = outputs.at(-1);
  assert.ok(Buffer.isBuffer(result[0].payload));
  assert.deepEqual(result[0].payload, Buffer.from('log'));
  assert.equal(result[0].logId, 7);
  assert.equal(result[0].filename, 'log.bin');
  assert.equal(result[0].topic, 'download');
  assert.equal(result[1].result, 'succeeded');
  assert.deepEqual(conn.sentNames(), ['LOG_REQUEST_DATA', 'LOG_REQUEST_END']);
});

test('payload id overrides the configured log id without changing target addressing', async () => {
  const conn = new StubConnection();
  conn.onSend((message, deliver) => {
    if (message.name === 'LOG_REQUEST_DATA') {
      assert.equal(message.fields.id, 9);
      deliver({
        name: 'LOG_DATA', sysid: 42, compid: 1,
        fields: { id: 9, ofs: 0, count: 0, data: Buffer.alloc(90) },
      });
    }
  });
  const Node = loadNode(conn);
  const node = new Node({ ...BASE, operation: 'download', logId: 7 });
  const { outputs } = await runInput(node, { payload: { id: 9 } });

  assert.equal(outputs.at(-1)[0].logId, 9);
  assert.equal(conn.sent[0].message.fields.target_system, 42);
  assert.equal(conn.sent[0].message.fields.target_component, 1);
});

test('a second log operation for the same connection and target is reported busy', async (t) => {
  const conn = new StubConnection();
  conn.onSend(() => {});
  const Node = loadNode(conn);
  const first = new Node({ ...BASE, operation: 'download', logId: 7, id: 'first' });
  const second = new Node({ ...BASE, operation: 'list', id: 'second' });
  t.after(() => first.emit('close', () => {}));

  first.emit('input', { payload: {} }, () => {}, () => {});
  const { outputs } = await runInput(second, { payload: {} });

  assert.equal(outputs.at(-1)[1].phase, 'locked');
  assert.equal(conn.sentNames().filter((name) => name === 'LOG_REQUEST_LIST').length, 0);
});

test('status target records are detached from the active log target', async () => {
  const conn = new StubConnection();
  conn.onSend((message, deliver) => {
    if (message.name === 'LOG_REQUEST_LIST') {
      deliver({
        name: 'LOG_ENTRY', sysid: 42, compid: 1,
        fields: { id: 1, num_logs: 1, last_log_num: 1, time_utc: 0, size: 4 },
      });
    }
  });
  const Node = loadNode(conn);
  const node = new Node({ ...BASE, operation: 'list', targetComponent: 1 });
  let changed = false;
  await runInput(node, { payload: {} }, (messages) => {
    if (!changed && messages[1] && messages[1].result === 'progress') {
      changed = true;
      messages[1].target.compid = 191;
    }
  });

  assert.equal(changed, true);
  assert.equal(conn.sent[0].options.target.compid, 1);
  assert.equal(conn.sent[0].message.fields.target_component, 1);
});

test('files list uses the configured source identity, path override, and bulk band', async () => {
  const conn = new StubConnection();
  conn._sourceIds = { sysid: 255, compid: 190 };
  conn.onSend((message, deliver, options) => {
    assert.equal(options.band, 4);
    const request = decodePayload(message.fields.payload);
    if (request.opcode === OPCODE.LIST_DIRECTORY && request.offset === 0) {
      deliver(ftpReply(message, OPCODE.ACK, Buffer.from('Ffirst.bin\t3\0')));
    } else if (request.opcode === OPCODE.LIST_DIRECTORY && request.offset === 1) {
      deliver(ftpReply(message, OPCODE.NAK, Buffer.from([NAK_ERROR.EOF])));
    }
  });
  const Node = loadNode(conn);
  const node = new Node({ ...BASE, service: 'files', operation: 'list', path: '/configured', targetComponent: 191 });
  const { outputs, err } = await runInput(node, { payload: { path: '/override' } });

  assert.equal(err, undefined);
  assert.deepEqual(outputs.at(-1)[0].payload, [{ name: 'first.bin', type: 'file', size: 3 }]);
  assert.equal(outputs.at(-1)[1].result, 'succeeded');
  assert.equal(conn.sent[0].message.fields.target_system, 42);
  assert.equal(conn.sent[0].message.fields.target_component, 191);
  assert.deepEqual(conn.sent[0].options.target, { sysid: 42, compid: 191 });
  assert.equal(decodePayload(conn.sent[0].message.fields.payload).data.toString(), '/override');
});

test('files download returns a Buffer and upload accepts msg.path plus a Buffer payload', async () => {
  const downloadConn = new StubConnection();
  downloadConn._sourceIds = { sysid: 255, compid: 190 };
  downloadConn.onSend((message, deliver) => {
    const request = decodePayload(message.fields.payload);
    if (request.opcode === OPCODE.OPEN_FILE_RO) {
      deliver(ftpReply(message, OPCODE.ACK, Buffer.from([3, 0, 0, 0]), { session: 5 }));
    } else if (request.opcode === OPCODE.READ_FILE && request.offset === 0) {
      deliver(ftpReply(message, OPCODE.ACK, Buffer.from('abc'), { session: 5 }));
    } else if (request.opcode === OPCODE.READ_FILE && request.offset === 3) {
      deliver(ftpReply(message, OPCODE.NAK, Buffer.from([NAK_ERROR.EOF]), { session: 5 }));
    } else if (request.opcode === OPCODE.TERMINATE_SESSION) {
      deliver(ftpReply(message, OPCODE.ACK, Buffer.alloc(0), { session: 5 }));
    }
  });
  const Node = loadNode(downloadConn);
  const downloadNode = new Node({ ...BASE, service: 'files', operation: 'download', path: '/configured', targetComponent: 191 });
  const downloaded = await runInput(downloadNode, { payload: { path: '/download.bin' } });
  assert.deepEqual(downloaded.outputs.at(-1)[0].payload, Buffer.from('abc'));
  assert.equal(downloaded.outputs.at(-1)[1].result, 'succeeded');

  const uploadConn = new StubConnection();
  uploadConn._sourceIds = { sysid: 255, compid: 190 };
  uploadConn.onSend((message, deliver, options) => {
    assert.equal(options.band, 4);
    const request = decodePayload(message.fields.payload);
    if (request.opcode === OPCODE.CREATE_FILE) {
      deliver(ftpReply(message, OPCODE.ACK, Buffer.alloc(0), { session: 6 }));
    } else if (request.opcode === OPCODE.WRITE_FILE) {
      deliver(ftpReply(message, OPCODE.ACK, Buffer.alloc(0), { session: 6 }));
    } else if (request.opcode === OPCODE.TERMINATE_SESSION) {
      deliver(ftpReply(message, OPCODE.ACK, Buffer.alloc(0), { session: 6 }));
    }
  });
  const UploadNode = loadNode(uploadConn);
  const uploadNode = new UploadNode({ ...BASE, service: 'files', operation: 'upload', path: '/configured', targetComponent: 191 });
  const uploaded = await runInput(uploadNode, { payload: Buffer.from('upload'), path: '/upload.bin' });
  assert.deepEqual(uploaded.outputs.at(-1)[0].payload, { bytes: 6 });
  assert.equal(uploaded.outputs.at(-1)[1].result, 'succeeded');
  const create = decodePayload(uploadConn.sent[0].message.fields.payload);
  assert.equal(create.data.toString(), '/upload.bin');
});

test('parameter backup and restore use resolved encoding, preserve metadata, and select their bands', async () => {
  const backupConn = new StubConnection();
  backupConn.vehicle = { firmware: 'ardupilot', targetSystem: 42, targetComponent: 1 };
  backupConn.onSend((message, deliver, options) => {
    assert.equal(options.band, 4);
    if (message.name !== 'PARAM_REQUEST_LIST') return;
    deliver(paramValue({ paramId: 'B', paramType: 6, paramIndex: 1, paramCount: 2, value: 2 }));
    deliver(paramValue({ paramId: 'A', paramType: 9, paramIndex: 0, paramCount: 2, value: 1.5 }));
  });
  const Node = loadNode(backupConn);
  const backupNode = new Node({ ...BASE, service: 'parameters', operation: 'backup', paramEncoding: 'c-cast' });
  const backup = await runInput(backupNode, { payload: {}, filename: 'params.json' });
  assert.deepEqual(backup.outputs.at(-1)[0].payload, [
    { paramId: 'A', paramType: 9, value: 1.5 },
    { paramId: 'B', paramType: 6, value: 2 },
  ]);
  assert.equal(backup.outputs.at(-1)[0].filename, 'params.json');
  assert.equal(backup.outputs.at(-1)[1].params, undefined, 'large backup payload stays off status output');

  const restoreConn = new StubConnection();
  restoreConn.vehicle = { firmware: 'px4', targetSystem: 42, targetComponent: 1 };
  const params = [
    { paramId: 'I', paramType: 6, value: -4 },
    { paramId: 'U', paramType: 5, value: 12 },
  ];
  restoreConn.onSend((message, deliver, options) => {
    assert.equal(options.band, 2);
    if (message.name !== 'PARAM_SET') return;
    const sent = params.find((param) => param.paramId === message.fields.param_id);
    deliver(paramValue({
      paramId: sent.paramId,
      paramType: sent.paramType,
      paramIndex: 0,
      paramCount: 1,
      value: paramValueToWire(sent.value, sent.paramType),
    }));
  });
  const RestoreNode = loadNode(restoreConn);
  const restoreNode = new RestoreNode({ ...BASE, service: 'parameters', operation: 'restore', paramEncoding: 'bytewise' });
  const restored = await runInput(restoreNode, { payload: params, topic: 'restore' });
  assert.deepEqual(restored.outputs.at(-1)[0].payload, { restored: 2 });
  assert.equal(restored.outputs.at(-1)[0].topic, 'restore');
  assert.equal(restored.outputs.at(-1)[1].params, undefined);
  assert.equal(restored.outputs.at(-1)[1].restored, 2);
});

test('mission services backup and restore use the matching mission type', async () => {
  const backupConn = new StubConnection();
  backupConn.onSend((message, deliver, options) => {
    assert.equal(options.band, 4);
    if (message.name === 'MISSION_REQUEST_LIST') {
      assert.equal(message.fields.mission_type, 1);
      deliver({ name: 'MISSION_COUNT', sysid: 42, compid: 1, fields: { count: 0, mission_type: 1 } });
    }
  });
  const Node = loadNode(backupConn);
  const backupNode = new Node({ ...BASE, service: 'fences', operation: 'backup' });
  const backup = await runInput(backupNode, { payload: {} });
  assert.deepEqual(backup.outputs.at(-1)[0].payload, []);
  assert.equal(backup.outputs.at(-1)[1].missionType, 1);

  const restoreConn = new StubConnection();
  restoreConn.onSend((message, deliver, options) => {
    assert.equal(options.band, 4);
    if (message.name === 'MISSION_COUNT') {
      assert.equal(message.fields.mission_type, 2);
      deliver({ name: 'MISSION_REQUEST_INT', sysid: 42, compid: 1, fields: { seq: 0, mission_type: 2 } });
    } else if (message.name === 'MISSION_ITEM_INT') {
      assert.equal(message.fields.mission_type, 2);
      deliver({ name: 'MISSION_ACK', sysid: 42, compid: 1, fields: { type: 0, mission_type: 2 } });
    }
  });
  const RestoreNode = loadNode(restoreConn);
  const restoreNode = new RestoreNode({ ...BASE, service: 'rally', operation: 'restore' });
  const restored = await runInput(restoreNode, {
    payload: [{ frame: 3, command: 5100, current: 0, autocontinue: 1, param1: 0, param2: 0, param3: 0, param4: 0, x: 1, y: 2, z: 3 }],
  });
  assert.equal(restored.outputs.at(-1)[0].payload.restored, 1);
  assert.equal(restored.outputs.at(-1)[1].missionType, 2);
});

test('mission backup keeps NaN and negative zero item values through JSON round trips', async () => {
  const conn = new StubConnection();
  conn.onSend((message, deliver) => {
    if (message.name === 'MISSION_REQUEST_LIST') {
      deliver({ name: 'MISSION_COUNT', sysid: 42, compid: 1, fields: { count: 1, mission_type: 0 } });
    } else if (message.name === 'MISSION_REQUEST_INT') {
      deliver({
        name: 'MISSION_ITEM',
        sysid: 42,
        compid: 1,
        fields: {
          seq: 0, frame: 3, command: 16, current: 0, autocontinue: 1,
          param1: NaN, param2: -0, param3: 1, param4: 2, x: NaN, y: -0, z: NaN,
          mission_type: 0,
        },
      });
    }
  });
  const Node = loadNode(conn);
  const node = new Node({ ...BASE, service: 'missions', operation: 'backup' });
  const result = await runInput(node, { payload: {} });
  const roundTripped = JSON.parse(JSON.stringify(result.outputs.at(-1)[0].payload));
  assert.equal(roundTripped[0].param1, 'NaN');
  assert.equal(roundTripped[0].param2, '-0');
  assert.equal(roundTripped[0].z, 'NaN');
});

test('mission service locks include the selected plan type', async (t) => {
  const conn = new StubConnection();
  conn.onSend(() => {});
  const Node = loadNode(conn);
  const first = new Node({ ...BASE, service: 'fences', operation: 'backup', id: 'first-fence-backup' });
  const second = new Node({ ...BASE, service: 'fences', operation: 'backup', id: 'second-fence-backup' });
  t.after(() => first.emit('close', () => {}));

  first.emit('input', { payload: {} }, () => {}, () => {});
  const result = await runInput(second, { payload: {} });
  assert.equal(result.outputs.at(-1)[1].phase, 'locked');
  assert.equal(conn.sentNames().filter((name) => name === 'MISSION_REQUEST_LIST').length, 1);
});

test('files backup and restore use the FTP bundle contract and preserve metadata', async () => {
  const backupConn = new StubConnection();
  backupConn._sourceIds = { sysid: 255, compid: 190 };
  backupConn.onSend((message, deliver) => {
    const request = decodePayload(message.fields.payload);
    if (request.opcode === OPCODE.LIST_DIRECTORY && request.offset === 0) {
      deliver(ftpReply(message, OPCODE.NAK, Buffer.from([NAK_ERROR.EOF])));
    }
  });
  const Node = loadNode(backupConn);
  const backupNode = new Node({ ...BASE, service: 'files', operation: 'backup', path: '/config', targetComponent: 191 });
  const backup = await runInput(backupNode, { payload: {}, topic: 'backup' });
  assert.deepEqual(backup.outputs.at(-1)[0].payload, { root: '/config', directories: [], files: [] });
  assert.equal(backup.outputs.at(-1)[0].topic, 'backup');

  const restoreConn = new StubConnection();
  restoreConn._sourceIds = { sysid: 255, compid: 190 };
  restoreConn.onSend((message, deliver) => {
    const request = decodePayload(message.fields.payload);
    if (request.opcode === OPCODE.CREATE_DIRECTORY) {
      deliver(ftpReply(message, OPCODE.ACK));
    }
  });
  const RestoreNode = loadNode(restoreConn);
  const restoreNode = new RestoreNode({ ...BASE, service: 'files', operation: 'restore', path: '/restore', targetComponent: 191 });
  const restored = await runInput(restoreNode, {
    payload: { version: 1, root: '/config', directories: [], files: [] },
    topic: 'restore',
  });
  assert.deepEqual(restored.outputs.at(-1)[0].payload, {
    bytes: 0,
    restoredFiles: 0,
    restoredDirectories: 0,
  });
  assert.equal(restored.outputs.at(-1)[0].topic, 'restore');
});
