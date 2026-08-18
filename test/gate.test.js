import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, parseTargets, RestartGate } from '../src/gate.js';

class MemoryState { constructor() { this.value = {}; } async read() { return { ...this.value }; } async write(v) { this.value = { ...v }; } }
class Docker { constructor() { this.calls = []; } async restart(name) { this.calls.push(name); } }

test('targets are allowlisted and Docker receives only configured name', async () => {
  const docker = new Docker(); const state = new MemoryState();
  const gate = new RestartGate({ targets: parseTargets('{"katja":"openclaw-katja"}'), state, docker, now: () => 1000 });
  assert.deepEqual(await gate.restart('missing'), { status: 404, body: { error: 'unknown_target' } });
  assert.equal((await gate.restart('katja')).status, 202);
  assert.deepEqual(docker.calls, ['openclaw-katja']);
});

test('cooldown persists per target and produces retry metadata', async () => {
  let now = 1000; const docker = new Docker(); const state = new MemoryState();
  const gate = new RestartGate({ targets: { a: 'one', b: 'two' }, cooldownMs: 1800000, state, docker, now: () => now });
  await gate.restart('a'); now += 1000;
  const blocked = await gate.restart('a');
  assert.equal(blocked.status, 429); assert.equal(blocked.retryAfter, 1799);
  assert.equal((await gate.restart('b')).status, 202);
});

test('failed Docker restart does not start a cooldown', async () => {
  const state = new MemoryState();
  const docker = { async restart() { throw new Error('socket unavailable'); } };
  const gate = new RestartGate({ targets: { a: 'one' }, state, docker, now: () => 1000 });
  assert.equal((await gate.restart('a')).status, 502);
  assert.deepEqual(state.value, {});
});

test('HTTP trigger requires bearer auth and returns Retry-After', async (t) => {
  const gate = new RestartGate({ targets: { a: 'one' }, cooldownMs: 1800000, state: new MemoryState(), docker: new Docker(), now: () => 1000 });
  const server = createServer({ gate, authToken: 'secret' });
  await new Promise((resolve) => server.listen(0, resolve)); t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${origin}/v1/restarts/a`, { method: 'POST' })).status, 401);
  assert.equal((await fetch(`${origin}/v1/restarts/a`, { method: 'POST', headers: { authorization: 'Bearer secret' } })).status, 202);
  const response = await fetch(`${origin}/v1/restarts/a`, { method: 'POST', headers: { authorization: 'Bearer secret' } });
  assert.equal(response.status, 429); assert.equal(response.headers.get('retry-after'), '1800');
});
