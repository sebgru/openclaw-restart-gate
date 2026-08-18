import { createServer, DockerSocket, FileState, parseContainer, RestartGate } from './gate.js';

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const cooldownSeconds = Number(process.env.RESTART_GATE_COOLDOWN_SECONDS ?? 1800);
if (!Number.isSafeInteger(cooldownSeconds) || cooldownSeconds < 1) throw new Error('RESTART_GATE_COOLDOWN_SECONDS must be a positive integer');

const gate = new RestartGate({
  container: parseContainer(required('RESTART_GATE_CONTAINER')),
  cooldownMs: cooldownSeconds * 1000,
  state: new FileState(process.env.RESTART_GATE_STATE_PATH ?? '/data/restarts.json'),
  docker: new DockerSocket(process.env.DOCKER_SOCKET ?? '/var/run/docker.sock')
});
const port = Number(process.env.PORT ?? 8080);
createServer({ gate, authToken: required('RESTART_GATE_AUTH_TOKEN') }).listen(port, '0.0.0.0', () => console.log(`docker-restart-gate listening on ${port}`));
