import fs from 'node:fs/promises';
import http from 'node:http';

const [, , socketPath, groupId, readyPath] = process.argv;

if (!socketPath || !groupId || !readyPath) throw new Error('socket path, group ID, and ready path are required');

await fs.rm(socketPath, { force: true });
const server = http.createServer((request, response) => {
  if (request.method === 'POST' && request.url === '/v1.41/containers/sample-container/restart') {
    response.writeHead(204);
  } else {
    response.writeHead(404);
  }
  response.end();
});

server.listen(socketPath, async () => {
  await fs.chmod(socketPath, 0o660);
  await fs.chown(socketPath, process.getuid(), Number(groupId));
  await fs.writeFile(readyPath, 'ready');
});

const close = () => server.close();
process.once('SIGTERM', close);
process.once('SIGINT', close);
