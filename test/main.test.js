import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig, main } from '../src/main.js';

const baseEnv = () => ({
  RESTART_GATE_CONTAINER: 'sample-container',
  RESTART_GATE_AUTH_TOKEN: 'secret'
});

test('loadConfig applies defaults', () => {
  const config = loadConfig(baseEnv());
  assert.equal(config.container, 'sample-container');
  assert.equal(config.cooldownMs, 1_800_000);
  assert.equal(config.statePath, '/data/restarts.json');
  assert.equal(config.dockerSocket, '/var/run/docker.sock');
  assert.equal(config.port, 8080);
  assert.equal(config.authToken, 'secret');
});

test('loadConfig honors overrides', () => {
  const config = loadConfig({
    ...baseEnv(),
    RESTART_GATE_COOLDOWN_SECONDS: '60',
    RESTART_GATE_STATE_PATH: '/tmp/state.json',
    DOCKER_SOCKET: '/tmp/docker.sock',
    PORT: '9090'
  });
  assert.equal(config.cooldownMs, 60_000);
  assert.equal(config.statePath, '/tmp/state.json');
  assert.equal(config.dockerSocket, '/tmp/docker.sock');
  assert.equal(config.port, 9090);
});

test('loadConfig requires RESTART_GATE_CONTAINER', () => {
  const env = baseEnv();
  delete env.RESTART_GATE_CONTAINER;
  assert.throws(() => loadConfig(env), /RESTART_GATE_CONTAINER is required/);
});

test('loadConfig requires RESTART_GATE_AUTH_TOKEN', () => {
  const env = baseEnv();
  delete env.RESTART_GATE_AUTH_TOKEN;
  assert.throws(() => loadConfig(env), /RESTART_GATE_AUTH_TOKEN is required/);
});

test('loadConfig rejects an invalid container name', () => {
  assert.throws(() => loadConfig({ ...baseEnv(), RESTART_GATE_CONTAINER: '../etc' }), /safe Docker container name/);
});

test('loadConfig rejects a non-positive-integer cooldown', () => {
  assert.throws(() => loadConfig({ ...baseEnv(), RESTART_GATE_COOLDOWN_SECONDS: '0' }), /positive integer/);
  assert.throws(() => loadConfig({ ...baseEnv(), RESTART_GATE_COOLDOWN_SECONDS: 'abc' }), /positive integer/);
});

test('main starts an HTTP server wired to a real gate', async (t) => {
  const statePath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'gate-')), 'restarts.json');
  const server = await main({
    ...baseEnv(),
    RESTART_GATE_STATE_PATH: statePath,
    DOCKER_SOCKET: '/nonexistent.sock',
    PORT: '0'
  });
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${origin}/healthz`);
  assert.equal(response.status, 200);
});
