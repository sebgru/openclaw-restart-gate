import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createServer, DockerSocket, FileState, parseContainer, RestartGate } from '../src/gate.js';

class MemoryState {
  constructor() {
    this.value = {};
  }
  async read() {
    return { ...this.value };
  }
  async write(v) {
    this.value = { ...v };
  }
}
class Docker {
  constructor() {
    this.calls = [];
  }
  async restart(name) {
    this.calls.push(name);
  }
}

test('Docker receives only the configured container name', async () => {
  const docker = new Docker();
  const state = new MemoryState();
  const gate = new RestartGate({ container: parseContainer('sample-container'), state, docker, now: () => 1000 });
  assert.equal((await gate.restart()).status, 202);
  assert.deepEqual(docker.calls, ['sample-container']);
});

test('cooldown persists and produces retry metadata', async () => {
  let now = 1000;
  const docker = new Docker();
  const state = new MemoryState();
  const gate = new RestartGate({ container: 'sample-container', cooldownMs: 1800000, state, docker, now: () => now });
  await gate.restart();
  now += 1000;
  const blocked = await gate.restart();
  assert.equal(blocked.status, 429);
  assert.equal(blocked.retryAfter, 1799);
});

test('failed Docker restart does not start a cooldown', async () => {
  const state = new MemoryState();
  const docker = {
    async restart() {
      throw new Error('socket unavailable');
    }
  };
  const gate = new RestartGate({ container: 'sample-container', state, docker, now: () => 1000 });
  assert.equal((await gate.restart()).status, 502);
  assert.deepEqual(state.value, {});
});

test('Docker socket permission failures are identified', async () => {
  const state = new MemoryState();
  const error = Object.assign(new Error('permission denied'), { code: 'EACCES' });
  const gate = new RestartGate({
    container: 'sample-container',
    state,
    docker: {
      restart: async () => {
        throw error;
      }
    },
    now: () => 1000
  });
  assert.deepEqual((await gate.restart()).body, { error: 'docker_socket_permission_denied' });
});

test('HTTP trigger requires bearer auth and returns Retry-After', async (t) => {
  const gate = new RestartGate({
    container: 'sample-container',
    cooldownMs: 1800000,
    state: new MemoryState(),
    docker: new Docker(),
    now: () => 1000
  });
  const server = createServer({ gate, authToken: 'secret' });
  await new Promise((resolve) => server.listen(0, resolve));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${origin}/v1/restart`, { method: 'POST' })).status, 401);
  assert.equal((await fetch(`${origin}/v1/restart`, { method: 'POST', headers: { authorization: 'Bearer secret' } })).status, 202);
  const response = await fetch(`${origin}/v1/restart`, { method: 'POST', headers: { authorization: 'Bearer secret' } });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '1800');
});

test('parseContainer rejects unsafe or non-string values', () => {
  assert.throws(() => parseContainer('../etc'), /safe Docker container name/);
  assert.throws(() => parseContainer(''), /safe Docker container name/);
  assert.throws(() => parseContainer(undefined), /safe Docker container name/);
  assert.equal(parseContainer('my_container-1.2'), 'my_container-1.2');
});

test('concurrent restart calls are serialized through the queue', async () => {
  const docker = new Docker();
  const state = new MemoryState();
  const gate = new RestartGate({ container: 'sample-container', cooldownMs: 1800000, state, docker, now: () => 1000 });
  const [first, second] = await Promise.all([gate.restart(), gate.restart()]);
  assert.equal(first.status, 202);
  assert.equal(second.status, 429);
  assert.deepEqual(docker.calls, ['sample-container']);
});

test('FileState reads missing files as an empty object', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gate-state-'));
  const state = new FileState(path.join(dir, 'nested', 'restarts.json'));
  assert.deepEqual(await state.read(), {});
});

test('FileState treats non-object JSON as an empty object', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gate-state-'));
  const file = path.join(dir, 'restarts.json');
  await fs.writeFile(file, JSON.stringify([1, 2, 3]));
  const state = new FileState(file);
  assert.deepEqual(await state.read(), {});
});

test('FileState surfaces non-ENOENT read errors', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gate-state-'));
  const state = new FileState(dir);
  await assert.rejects(() => state.read(), /cannot read restart state/);
});

test('FileState writes and reads back JSON, creating parent directories', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gate-state-'));
  const file = path.join(dir, 'nested', 'restarts.json');
  const state = new FileState(file);
  await state.write({ lastRestart: 42 });
  assert.deepEqual(await state.read(), { lastRestart: 42 });
});

test('DockerSocket resolves on a successful HTTP response and rejects otherwise', async (t) => {
  const server = http.createServer((request, response) => {
    if (request.url.includes('fail')) {
      response.writeHead(500);
      return response.end();
    }
    response.writeHead(204);
    response.end();
  });
  const socketPath = path.join(os.tmpdir(), `gate-docker-${process.pid}-${Date.now()}.sock`);
  await new Promise((resolve) => server.listen(socketPath, resolve));
  t.after(() => {
    server.close();
    return fs.rm(socketPath, { force: true });
  });

  const docker = new DockerSocket(socketPath);
  await assert.doesNotReject(() => docker.restart('sample-container'));

  const failingServer = new DockerSocket(socketPath);
  await assert.rejects(() => failingServer.restart('fail-container'), /Docker returned HTTP 500/);
});

test('DockerSocket rejects when the socket is unreachable', async () => {
  const docker = new DockerSocket(path.join(os.tmpdir(), 'does-not-exist.sock'));
  await assert.rejects(() => docker.restart('sample-container'));
});

test('DockerSocket and RestartGate fall back to their default constructor options', async () => {
  const docker = new DockerSocket();
  await assert.rejects(() => docker.restart('sample-container'));

  const gate = new RestartGate({ container: 'sample-container', state: new MemoryState(), docker: new Docker() });
  const result = await gate.restart();
  assert.equal(result.status, 202);
});

test('createServer returns 404 for unknown routes and methods', async (t) => {
  const gate = new RestartGate({ container: 'sample-container', state: new MemoryState(), docker: new Docker(), now: () => 1000 });
  const server = createServer({ gate, authToken: 'secret' });
  await new Promise((resolve) => server.listen(0, resolve));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${origin}/unknown`)).status, 404);
  assert.equal((await fetch(`${origin}/v1/restart`, { method: 'GET' })).status, 404);
});

test('createServer rejects malformed or mismatched authorization headers', async (t) => {
  const gate = new RestartGate({ container: 'sample-container', state: new MemoryState(), docker: new Docker(), now: () => 1000 });
  const server = createServer({ gate, authToken: 'secret' });
  await new Promise((resolve) => server.listen(0, resolve));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const noBearer = await fetch(`${origin}/v1/restart`, { method: 'POST', headers: { authorization: 'Basic secret' } });
  assert.equal(noBearer.status, 401);
  const wrongLength = await fetch(`${origin}/v1/restart`, { method: 'POST', headers: { authorization: 'Bearer wrong' } });
  assert.equal(wrongLength.status, 401);
});

test('createServer returns 500 state_error when the gate throws', async (t) => {
  const gate = {
    restart: async () => {
      throw new Error('boom');
    }
  };
  const server = createServer({ gate, authToken: 'secret' });
  await new Promise((resolve) => server.listen(0, resolve));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${origin}/v1/restart`, { method: 'POST', headers: { authorization: 'Bearer secret' } });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'state_error' });
});

test('healthz is unauthenticated', async (t) => {
  const gate = new RestartGate({ container: 'sample-container', state: new MemoryState(), docker: new Docker(), now: () => 1000 });
  const server = createServer({ gate, authToken: 'secret' });
  await new Promise((resolve) => server.listen(0, resolve));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${origin}/healthz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
});
