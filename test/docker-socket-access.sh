#!/usr/bin/env bash
set -euo pipefail

image="${RESTART_GATE_IMAGE:-docker-restart-gate:test}"
work_dir="$(mktemp -d)"
socket_path="$work_dir/docker.sock"
ready_path="$work_dir/ready"
with_group_container="restart-gate-with-group-$$"
without_group_container="restart-gate-without-group-$$"
fake_server_pid=""

cleanup() {
  docker rm -f "$with_group_container" "$without_group_container" >/dev/null 2>&1 || true
  if [[ -n "$fake_server_pid" ]]; then kill "$fake_server_pid" >/dev/null 2>&1 || true; fi
  rm -rf "$work_dir"
}
trap cleanup EXIT

if ! docker image inspect "$image" >/dev/null 2>&1; then
  docker build --tag "$image" .
fi

socket_group_id="$(stat -c '%g' /var/run/docker.sock)"
node_groups="$(docker run --rm --entrypoint id "$image" -G)"
if grep -Eq "(^| )${socket_group_id}( |$)" <<<"$node_groups"; then
  echo "test setup error: image node user already has Docker socket group ${socket_group_id}" >&2
  exit 1
fi

node scripts/fake-docker-api.mjs "$socket_path" "$socket_group_id" "$ready_path" &
fake_server_pid=$!
for _ in {1..50}; do
  if [[ -f "$ready_path" ]]; then break; fi
  sleep 0.1
done
[[ -f "$ready_path" ]] || { echo 'fake Docker API did not start' >&2; exit 1; }

run_gate() {
  local container_name="$1"
  shift
  docker run --detach --rm --name "$container_name" --user node \
    --mount "type=bind,src=$socket_path,dst=/var/run/docker.sock" \
    --env RESTART_GATE_AUTH_TOKEN=integration-secret \
    --env RESTART_GATE_CONTAINER=sample-container \
    --env RESTART_GATE_STATE_PATH=/tmp/restarts.json \
    --env PORT=8080 \
    --publish 127.0.0.1::8080 "$@" "$image"
}

wait_for_gate() {
  local port="$1"
  local container_id="$2"
  for _ in {1..50}; do
    if curl --silent --fail "http://127.0.0.1:${port}/healthz" >/dev/null; then return; fi
    sleep 0.1
  done
  docker logs "$container_id" >&2
  return 1
}

assert_runtime_user() {
  local container_id="$1"
  [[ "$(docker exec "$container_id" id -u)" == '1000' ]]
  [[ "$(docker exec "$container_id" id -un)" == 'node' ]]
}

with_group_id="$(run_gate "$with_group_container" --group-add "$socket_group_id" | tr -d '\n')"
with_group_port="$(docker port "$with_group_id" 8080/tcp | sed 's/.*://')"
wait_for_gate "$with_group_port" "$with_group_id"
assert_runtime_user "$with_group_id"
with_group_response="$(curl --silent --show-error --request POST --header 'Authorization: Bearer integration-secret' "http://127.0.0.1:${with_group_port}/v1/restart")"
[[ "$with_group_response" == '{"status":"restart_requested"}' ]]

docker rm -f "$with_group_id" >/dev/null
without_group_id="$(run_gate "$without_group_container" | tr -d '\n')"
without_group_port="$(docker port "$without_group_id" 8080/tcp | sed 's/.*://')"
wait_for_gate "$without_group_port" "$without_group_id"
assert_runtime_user "$without_group_id"
without_group_response="$(curl --silent --show-error --request POST --header 'Authorization: Bearer integration-secret' "http://127.0.0.1:${without_group_port}/v1/restart")"
[[ "$without_group_response" == '{"error":"docker_socket_permission_denied"}' ]]

echo "Docker socket supplemental-group access passed for image ${image}"
