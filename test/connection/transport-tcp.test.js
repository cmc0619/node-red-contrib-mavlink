'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
  TcpTransport,
  TCP_NO_DESTINATION,
  TCP_PEER_GONE,
} = require('../../lib/connection/transport/tcp');

/** @returns {Promise<void>} */
function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

class MockSocket extends EventEmitter {
  /**
   * @param {object} endpoint
   * @param {string} endpoint.address
   * @param {number} endpoint.port
   */
  constructor(endpoint) {
    super();
    this.remoteAddress = endpoint.address;
    this.remotePort = endpoint.port;
    this.writes = [];
    this.closed = false;
    this.nextWriteResult = true;
  }

  /**
   * @param {Buffer} buffer
   * @returns {boolean}
   */
  write(buffer) {
    this.writes.push(Buffer.from(buffer));
    const result = this.nextWriteResult;
    this.nextWriteResult = true;
    return result;
  }

  /** @param {Function} [callback] */
  end(callback) {
    this.closed = true;
    setTimeout(() => {
      this.emit('close');
      if (callback) callback();
    }, 0);
  }

  /** @param {Buffer} buffer */
  receive(buffer) {
    this.emit('data', buffer);
  }
}

class MockServer extends EventEmitter {
  /** @param {object} options */
  constructor(options) {
    super();
    this.options = options;
    this.boundTo = null;
    this.closed = false;
    this.sockets = [];
  }

  /**
   * @param {number} port
   * @param {string} address
   */
  listen(port, address) {
    this.boundTo = { port, address };
    setTimeout(() => this.emit('listening'), 0);
  }

  /** @param {Function} callback */
  close(callback) {
    this.closed = true;
    setTimeout(() => {
      this.emit('close');
      callback();
    }, 0);
  }

  /** @returns {{address: string, port: number}} */
  address() {
    return this.boundTo;
  }

  /** @param {MockSocket} socket */
  accept(socket) {
    this.sockets.push(socket);
    this.emit('connection', socket);
  }
}

/**
 * @returns {{module: object, servers: MockServer[], clients: MockSocket[]}}
 */
function mockNet() {
  const servers = [];
  const clients = [];
  const module = {
    createServer(options, listener) {
      const server = new MockServer(options);
      if (listener) server.on('connection', listener);
      servers.push(server);
      return server;
    },
    createConnection(options, listener) {
      const socket = new MockSocket({ address: options.host, port: options.port });
      socket.options = options;
      if (listener) socket.once('connect', listener);
      clients.push(socket);
      setTimeout(() => socket.emit('connect'), 0);
      return socket;
    },
  };
  module.connect = module.createConnection;
  return { module, servers, clients };
}

test('server listens, receives from a client, and writes back to the matching endpoint', async () => {
  const net = mockNet();
  const transport = new TcpTransport({ bindPort: 5760 }, { net: net.module });
  const heard = [];
  transport.on('message', (message) => heard.push(message));

  await transport.open();
  assert.equal(net.servers.length, 1);
  assert.deepEqual(net.servers[0].boundTo, { port: 5760, address: '0.0.0.0' });
  assert.equal(net.servers[0].options.highWaterMark, 1024);

  const client = new MockSocket({ address: '10.0.0.21', port: 49000 });
  net.servers[0].accept(client);
  client.receive(Buffer.from('inbound'));

  assert.equal(heard.length, 1);
  assert.equal(heard[0].buffer.toString(), 'inbound');
  assert.deepEqual({ address: heard[0].address, port: heard[0].port }, { address: '10.0.0.21', port: 49000 });

  let sent = false;
  transport.send(Buffer.from('reply'), { address: '10.0.0.21', port: 49000 }, (err) => {
    assert.ifError(err);
    sent = true;
  });

  assert.equal(sent, true);
  assert.equal(client.writes.length, 1);
  assert.equal(client.writes[0].toString(), 'reply');

  let targetedGone = false;
  transport.send(Buffer.from('stale-target'), { address: 'missing', port: 1 }, (err) => {
    assert.equal(err.code, TCP_PEER_GONE);
    targetedGone = true;
  });
  assert.equal(targetedGone, true);
  assert.equal(client.writes.length, 1);

  let fallbackSent = false;
  transport.send(Buffer.from('single-client'), null, (err) => {
    assert.ifError(err);
    fallbackSent = true;
  });

  assert.equal(fallbackSent, true);
  assert.equal(client.writes.length, 2);
  assert.equal(client.writes[1].toString(), 'single-client');
});

test('client connects, emits a uniform listening event, and sends on the connected socket', async () => {
  const net = mockNet();
  const transport = new TcpTransport(
    { remoteAddress: '192.168.2.10', remotePort: 5762, bindAddress: '127.0.0.1' },
    { net: net.module }
  );
  const events = [];
  const heard = [];
  transport.on('connect', () => events.push('connect'));
  transport.on('listening', () => events.push('listening'));
  transport.on('message', (message) => heard.push(message));

  await transport.open();
  assert.deepEqual(events, ['connect', 'listening']);
  assert.equal(net.clients[0].options.host, '192.168.2.10');
  assert.equal(net.clients[0].options.port, 5762);
  assert.equal(net.clients[0].options.localAddress, '127.0.0.1');
  assert.equal(net.clients[0].options.highWaterMark, 1024);

  net.clients[0].receive(Buffer.from('from-server'));
  assert.equal(heard.length, 1);
  assert.equal(heard[0].buffer.toString(), 'from-server');
  assert.deepEqual({ address: heard[0].address, port: heard[0].port }, { address: '192.168.2.10', port: 5762 });

  let sent = false;
  transport.send(Buffer.from('outbound'), { address: 'ignored', port: 1 }, (err) => {
    assert.ifError(err);
    sent = true;
  });

  assert.equal(sent, true);
  assert.equal(net.clients[0].writes.length, 1);
  assert.equal(net.clients[0].writes[0].toString(), 'outbound');
});

test('write backpressure waits for drain before releasing the callback', async () => {
  const net = mockNet();
  const transport = new TcpTransport({ remoteAddress: '127.0.0.1', remotePort: 5760 }, { net: net.module });
  await transport.open();

  net.clients[0].nextWriteResult = false;
  let released = false;
  transport.send(Buffer.from('large'), null, (err) => {
    assert.ifError(err);
    released = true;
  });

  assert.equal(released, false);
  net.clients[0].emit('drain');
  assert.equal(released, true);
});

test('socket close during backpressure releases the pending send callback', async () => {
  const net = mockNet();
  const transport = new TcpTransport({ remoteAddress: '127.0.0.1', remotePort: 5760 }, { net: net.module });
  await transport.open();
  transport.on('error', () => {});

  net.clients[0].nextWriteResult = false;
  let errCode = null;
  transport.send(Buffer.from('large'), null, (err) => {
    errCode = err && err.code;
  });
  assert.equal(errCode, null);
  net.clients[0].emit('close');
  assert.equal(errCode, 'TCP_DISCONNECTED');
});

test('client disconnect emits error so the runtime can leave CONNECTED', async () => {
  const net = mockNet();
  const transport = new TcpTransport({ remoteAddress: '127.0.0.1', remotePort: 5760 }, { net: net.module });
  await transport.open();

  const err = await new Promise((resolve) => {
    transport.once('error', resolve);
    net.clients[0].emit('close');
  });
  assert.equal(err.code, 'TCP_DISCONNECTED');
});

test('server peer error does not emit transport error for remaining clients', async () => {
  const net = mockNet();
  const transport = new TcpTransport({ bindPort: 5760 }, { net: net.module });
  await transport.open();

  const a = new MockSocket({ address: '10.0.0.1', port: 1 });
  const b = new MockSocket({ address: '10.0.0.2', port: 2 });
  net.servers[0].accept(a);
  net.servers[0].accept(b);

  let transportErrors = 0;
  transport.on('error', () => {
    transportErrors += 1;
  });

  a.emit('error', new Error('peer a failed'));
  assert.equal(transportErrors, 0);

  let sent = false;
  transport.send(Buffer.from('to-b'), { address: '10.0.0.2', port: 2 }, (err) => {
    assert.ifError(err);
    sent = true;
  });
  assert.equal(sent, true);
  assert.equal(b.writes[0].toString(), 'to-b');
});

test('targeted send to a removed server peer fails loud with TCP_PEER_GONE', async () => {
  const net = mockNet();
  const transport = new TcpTransport({ bindPort: 5760 }, { net: net.module });
  await transport.open();

  const a = new MockSocket({ address: '10.0.0.1', port: 1 });
  net.servers[0].accept(a);
  a.emit('error', new Error('peer a failed'));

  await new Promise((resolve) => {
    transport.send(Buffer.from('stale'), { address: '10.0.0.1', port: 1 }, (err) => {
      assert.equal(err.code, TCP_PEER_GONE);
      resolve();
    });
  });
});

test('server peer error removes the socket before pending write callbacks resume', async () => {
  const net = mockNet();
  const transport = new TcpTransport({ bindPort: 5760 }, { net: net.module });
  await transport.open();

  const a = new MockSocket({ address: '10.0.0.1', port: 1 });
  const b = new MockSocket({ address: '10.0.0.2', port: 2 });
  net.servers[0].accept(a);
  net.servers[0].accept(b);

  a.nextWriteResult = false;
  let pendingErr = null;
  let sawPeerGone = false;
  let sentToB = false;
  transport.send(Buffer.from('backpressured'), { address: '10.0.0.1', port: 1 }, (err) => {
    pendingErr = err;
    // Resumed pump path: failed peer must already be gone; remaining peer works.
    transport.send(Buffer.from('to-b'), { address: '10.0.0.2', port: 2 }, (sendErr) => {
      assert.ifError(sendErr);
      sentToB = true;
    });
    transport.send(Buffer.from('to-a'), { address: '10.0.0.1', port: 1 }, (sendErr) => {
      assert.equal(sendErr.code, TCP_PEER_GONE);
      sawPeerGone = true;
    });
  });

  a.emit('error', new Error('peer a failed'));
  assert.ok(pendingErr);
  assert.equal(sentToB, true);
  assert.equal(sawPeerGone, true);
  assert.equal(b.writes[0].toString(), 'to-b');
});

test('client disconnect emits error before pending write callbacks resume', async () => {
  const net = mockNet();
  const transport = new TcpTransport({ remoteAddress: '127.0.0.1', remotePort: 5760 }, { net: net.module });
  await transport.open();

  net.clients[0].nextWriteResult = false;
  let errorBeforeCallback = false;
  let sawError = false;
  let callbackRan = false;
  transport.on('error', () => {
    sawError = true;
  });
  transport.send(Buffer.from('large'), null, (err) => {
    errorBeforeCallback = sawError;
    callbackRan = true;
    assert.equal(err.code, 'TCP_DISCONNECTED');
    // After the error event, client mode has no destination.
    transport.send(Buffer.from('next'), null, (sendErr) => {
      assert.equal(sendErr.code, TCP_NO_DESTINATION);
    });
  });

  net.clients[0].emit('close');
  assert.equal(sawError, true);
  assert.equal(callbackRan, true);
  assert.equal(errorBeforeCallback, true);
});

test('no destination returns the quiet TCP_NO_DESTINATION code', async () => {
  const net = mockNet();
  const serverTransport = new TcpTransport({ bindPort: 5760 }, { net: net.module });
  await serverTransport.open();

  await new Promise((resolve) => {
    serverTransport.send(Buffer.from('nowhere'), null, (err) => {
      assert.equal(err.code, TCP_NO_DESTINATION);
      resolve();
    });
  });

  const clientTransport = new TcpTransport({ remoteAddress: '127.0.0.1', remotePort: 5760 }, { net: net.module });
  let clientNoDestination = false;
  clientTransport.send(Buffer.from('early'), null, (err) => {
    assert.equal(err.code, TCP_NO_DESTINATION);
    clientNoDestination = true;
  });
  assert.equal(clientNoDestination, true);
});

test('close ends tracked sockets, closes the listener, and removes clients on socket close', async () => {
  const net = mockNet();
  const transport = new TcpTransport({ bindPort: 5760 }, { net: net.module });
  await transport.open();

  const client = new MockSocket({ address: '10.0.0.44', port: 49001 });
  net.servers[0].accept(client);
  client.emit('close');

  await new Promise((resolve) => {
    transport.send(Buffer.from('after-close'), { address: '10.0.0.44', port: 49001 }, (err) => {
      assert.equal(err.code, TCP_PEER_GONE);
      resolve();
    });
  });

  const remainingClient = new MockSocket({ address: '10.0.0.45', port: 49002 });
  net.servers[0].accept(remainingClient);

  let closed = false;
  transport.close(() => {
    closed = true;
  });
  await tick();

  assert.equal(closed, true);
  assert.equal(net.servers[0].closed, true);
  assert.equal(remainingClient.closed, true);
});
