import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, parseContainer, RestartGate } from '../src/gate.js';

class MemoryState { constructor() { this.value = {}; } async read() { return { ...this.value }; } async write(v) { this.value = { ...v }; } }
class Docker { constructor() { this.calls = []; } async restart(name) { this.calls.push(name); } }

test('Docker receives only the configured container name', async () => {
  const docker = new Docker(); const state = new MemoryState();
  const gate = new RestartGate({ container: parseContainer('sample-container'), state, docker, now: () => 1000 });
  assert.equal((await gate.restart()).status, 202);
  assert.deepEqual(docker.calls, ['sample-container']);
});

test('cooldown persists and produces retry metadata', async () => {
  let now = 1000; const docker = new Docker(); const state = new MemoryState();
  const gate = new RestartGate({ container: 'sample-container', cooldownMs: 1800000, state, docker, now: () => now });
  await gate.restart(); now += 1000;
  const blocked = await gate.restart();
  assert.equal(blocked.status, 429); assert.equal(blocked.retryAfter, 1799);
});

test('failed Docker restart does not start a cooldown', async () => {
  const state = new MemoryState();
  const docker = { async restart() { throw new Error('socket unavailable'); } };
  const gate = new RestartGate({ container: 'sample-container', state, docker, now: () => 1000 });
  assert.equal((await gate.restart()).status, 502);
  assert.deepEqual(state.value, {});
});

test('HTTP trigger requires bearer auth and returns Retry-After', async (t) => {
  const gate = new RestartGate({ container: 'sample-container', cooldownMs: 1800000, state: new MemoryState(), docker: new Docker(), now: () => 1000 });
  const server = createServer({ gate, authToken: 'secret' });
  await new Promise((resolve) => server.listen(0, resolve)); t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${origin}/v1/restart`, { method: 'POST' })).status, 401);
  assert.equal((await fetch(`${origin}/v1/restart`, { method: 'POST', headers: { authorization: 'Bearer secret' } })).status, 202);
  const response = await fetch(`${origin}/v1/restart`, { method: 'POST', headers: { authorization: 'Bearer secret' } });
  assert.equal(response.status, 429); assert.equal(response.headers.get('retry-after'), '1800');
});
