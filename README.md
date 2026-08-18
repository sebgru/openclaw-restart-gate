# docker-restart-gate

A minimal, secure Docker restart gateway with one fixed configured target, authenticated requests, and a cooldown to prevent restart loops.

## What it does

`POST /v1/restart` restarts this gate instance's one configured Docker container. Callers cannot select or supply a container name. The only Docker API call this service makes is `POST /containers/{configured-name}/restart`.

Successful restarts are persisted. The configured container cannot be restarted again for 30 minutes by default; the gate returns `429` and `Retry-After` during that period. Failed Docker calls do **not** start the cooldown.

## Configuration

Copy `.env.example`, set a high-entropy `RESTART_GATE_AUTH_TOKEN`, and set `RESTART_GATE_CONTAINER` to the one exact container name this gate may restart. Keep this configuration and its persistent state private.

| Variable | Required | Default |
| --- | --- | --- |
| `RESTART_GATE_AUTH_TOKEN` | yes | — |
| `RESTART_GATE_CONTAINER` | yes | — |
| `RESTART_GATE_COOLDOWN_SECONDS` | no | `1800` |
| `RESTART_GATE_STATE_PATH` | no | `/data/restarts.json` |
| `DOCKER_SOCKET` | no | `/var/run/docker.sock` |
| `PORT` | no | `8080` |

Example request:

```sh
curl -i -X POST http://restart-gate.internal:8080/v1/restart \
  -H "Authorization: Bearer $RESTART_GATE_AUTH_TOKEN"
```

`GET /healthz` is unauthenticated and reports only `{ "status": "ok" }`.

## Deployment boundary

Run one gate container for each restartable service. Each gate instance has its own `RESTART_GATE_CONTAINER`, authentication token, and writable persistent `/data` volume, so its cooldown survives restarts. This keeps deployments simple: for example, two independently configured gate containers can each restart one fixed service without user management or target selection.

Run gates on a private network, bind them only where callers need them, and mount only a dedicated Docker Socket Proxy endpoint that permits the restart route required by this service. Do not publish a gate port to the Internet.

The repository is intentionally public; never commit configured container names, tokens, hostnames, or deployment compose files.

## Development

```sh
npm test
npm start
```
