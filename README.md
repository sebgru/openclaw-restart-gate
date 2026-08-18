# docker-restart-gate

A minimal, secure Docker restart gateway with allowlisted targets, authenticated requests, and per-target cooldowns to prevent restart loops.

## What it does

`POST /v1/restarts/{target}` restarts one configured Docker container. `target` is a logical ID from `RESTART_GATE_TARGETS_JSON`, never a caller-supplied container name. The only Docker API call this service makes is `POST /containers/{configured-name}/restart`.

Successful restarts are persisted by target. A target cannot be restarted again for 30 minutes by default; the gate returns `429` and `Retry-After` during that period. Failed Docker calls do **not** start the cooldown.

## Configuration

Copy `.env.example`, set a high-entropy `RESTART_GATE_AUTH_TOKEN`, and configure only containers you intend to allow. Keep this configuration and its persistent state private.

| Variable | Required | Default |
| --- | --- | --- |
| `RESTART_GATE_AUTH_TOKEN` | yes | — |
| `RESTART_GATE_TARGETS_JSON` | yes | — |
| `RESTART_GATE_COOLDOWN_SECONDS` | no | `1800` |
| `RESTART_GATE_STATE_PATH` | no | `/data/restarts.json` |
| `DOCKER_SOCKET` | no | `/var/run/docker.sock` |
| `PORT` | no | `8080` |

Example request:

```sh
curl -i -X POST http://restart-gate.internal:8080/v1/restarts/katja \
  -H "Authorization: Bearer $RESTART_GATE_AUTH_TOKEN"
```

`GET /healthz` is unauthenticated and reports only `{ "status": "ok" }`.

## Deployment boundary

Run this on a private network, bind it only where the callers need it, and mount only a dedicated Docker Socket Proxy endpoint that permits the restart route required by this service. Do not publish its port to the Internet. The service needs a writable persistent `/data` volume so cooldowns survive restarts.

The repository is intentionally public; never commit target mappings, tokens, hostnames, or deployment compose files.

## Development

```sh
npm test
npm start
```
