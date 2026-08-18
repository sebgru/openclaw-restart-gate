import { createServer, DockerSocket, FileState, parseContainer, RestartGate } from './gate.js';

const required = (env, name) => {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

export function loadConfig(env = process.env) {
  const cooldownSeconds = Number(env.RESTART_GATE_COOLDOWN_SECONDS ?? 1800);
  if (!Number.isSafeInteger(cooldownSeconds) || cooldownSeconds < 1)
    throw new Error('RESTART_GATE_COOLDOWN_SECONDS must be a positive integer');
  return {
    container: parseContainer(required(env, 'RESTART_GATE_CONTAINER')),
    cooldownMs: cooldownSeconds * 1000,
    statePath: env.RESTART_GATE_STATE_PATH ?? '/data/restarts.json',
    dockerSocket: env.DOCKER_SOCKET ?? '/var/run/docker.sock',
    port: Number(env.PORT ?? 8080),
    authToken: required(env, 'RESTART_GATE_AUTH_TOKEN')
  };
}

export function main(env = process.env) {
  const config = loadConfig(env);
  const gate = new RestartGate({
    container: config.container,
    cooldownMs: config.cooldownMs,
    state: new FileState(config.statePath),
    docker: new DockerSocket(config.dockerSocket)
  });
  const server = createServer({ gate, authToken: config.authToken });
  return new Promise((resolve) => {
    server.listen(config.port, '0.0.0.0', () => {
      console.log(`docker-restart-gate listening on ${config.port}`);
      resolve(server);
    });
  });
}

/* c8 ignore next 3 */
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
