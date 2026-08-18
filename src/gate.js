import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

const json = (response, status, body, headers = {}) => {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  response.end(JSON.stringify(body));
};

export function parseContainer(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value)) {
    throw new Error('RESTART_GATE_CONTAINER must be an exact safe Docker container name');
  }
  return value;
}

export class FileState {
  constructor(path) {
    this.path = path;
  }
  async read() {
    try {
      const raw = await fs.readFile(this.path, 'utf8');
      const value = JSON.parse(raw);
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch (error) {
      if (error.code === 'ENOENT') return {};
      throw new Error(`cannot read restart state: ${error.message}`);
    }
  }
  async write(value) {
    const temporary = `${this.path}.tmp-${process.pid}`;
    await fs.mkdir(path.dirname(this.path), { recursive: true });
    await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    await fs.rename(temporary, this.path);
  }
}

export class DockerSocket {
  constructor(socketPath = '/var/run/docker.sock') {
    this.socketPath = socketPath;
  }
  restart(containerName) {
    return new Promise((resolve, reject) => {
      const request = http.request(
        { socketPath: this.socketPath, method: 'POST', path: `/v1.41/containers/${encodeURIComponent(containerName)}/restart` },
        (response) => {
          response.resume();
          response.on('end', () =>
            response.statusCode >= 200 && response.statusCode < 300
              ? resolve()
              : reject(new Error(`Docker returned HTTP ${response.statusCode}`))
          );
        }
      );
      request.once('error', reject);
      request.end();
    });
  }
}

export class RestartGate {
  constructor({ container, cooldownMs = 1_800_000, state, docker, now = () => Date.now() }) {
    this.container = container;
    this.cooldownMs = cooldownMs;
    this.state = state;
    this.docker = docker;
    this.now = now;
    this.queue = Promise.resolve();
  }
  restart() {
    const previous = this.queue;
    const current = previous.catch(() => {}).then(() => this.#restart());
    this.queue = current.catch(() => {});
    return current;
  }
  async #restart() {
    const state = await this.state.read();
    const now = this.now();
    const hasLastRestart = Object.hasOwn(state, 'lastRestart');
    const last = Number(state.lastRestart);
    const remaining = hasLastRestart && Number.isFinite(last) ? this.cooldownMs - (now - last) : 0;
    if (remaining > 0)
      return {
        status: 429,
        body: { error: 'cooldown_active', retry_after_seconds: Math.ceil(remaining / 1000) },
        retryAfter: Math.ceil(remaining / 1000)
      };
    try {
      await this.docker.restart(this.container);
    } catch (error) {
      const permissionDenied = error?.code === 'EACCES' || error?.code === 'EPERM';
      return {
        status: 502,
        body: { error: permissionDenied ? 'docker_socket_permission_denied' : 'restart_failed' },
        cause: error
      };
    }
    state.lastRestart = now;
    await this.state.write(state);
    return { status: 202, body: { status: 'restart_requested' } };
  }
}

function authorized(request, token) {
  const match = request.headers.authorization?.match(/^Bearer (.+)$/);
  const provided = match?.[1] ?? '';
  return Buffer.byteLength(provided) === Buffer.byteLength(token) && crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(token));
}

export function createServer({ gate, authToken }) {
  return http.createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/healthz') return json(response, 200, { status: 'ok' });
    if (request.method !== 'POST' || request.url !== '/v1/restart') return json(response, 404, { error: 'not_found' });
    if (!authorized(request, authToken)) return json(response, 401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer' });
    try {
      const result = await gate.restart();
      return json(response, result.status, result.body, result.retryAfter ? { 'retry-after': String(result.retryAfter) } : {});
    } catch {
      return json(response, 500, { error: 'state_error' });
    }
  });
}
