#!/usr/bin/env bash
set -euo pipefail

IMAGE="${OPENKIT_APP_IMAGE:-openkit/app:dev}"
PORT="${OPENKIT_APP_SMOKE_PORT:-18080}"
CONTAINER_NAME="${OPENKIT_APP_SMOKE_CONTAINER:-openkit-app-persistence-smoke-$$}"
WORKSPACE_NAME="${OPENKIT_APP_SMOKE_WORKSPACE:-OpenKit app persistence smoke $$}"
BASE_URL="http://127.0.0.1:${PORT}"
DATA_ROOT_CREATED="0"
CHECK_FAILURES=0

if [[ -n "${OPENKIT_APP_SMOKE_DATA_ROOT:-}" ]]; then
  DATA_ROOT="${OPENKIT_APP_SMOKE_DATA_ROOT}"
  mkdir -p "${DATA_ROOT}"
else
  DATA_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/openkit-app-data.XXXXXX")"
  DATA_ROOT_CREATED="1"
fi

require_command() {
  local command_name="$1"

  if ! command -v "${command_name}" >/dev/null 2>&1; then
    echo "Required command not found: ${command_name}" >&2
    exit 127
  fi
}

cleanup() {
  docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true

  if [[ "${DATA_ROOT_CREATED}" == "1" ]]; then
    rm -rf "${DATA_ROOT}"
  fi
}

# Records one successful smoke assertion.
record_pass() {
  local label="$1"

  echo "PASS ${label}"
}

# Records one failed smoke assertion.
record_failure() {
  local label="$1"
  local message="$2"

  CHECK_FAILURES=$((CHECK_FAILURES + 1))
  echo "FAIL ${label}: ${message}" >&2
}

# Prints the final smoke result and returns a failing status when any assertion failed.
finish_checks() {
  if [[ "${CHECK_FAILURES}" -eq 0 ]]; then
    echo "OpenKit app persistence smoke PASS"
    return 0
  fi

  echo "OpenKit app persistence smoke FAIL (${CHECK_FAILURES} checks failed)" >&2
  return 1
}

# Asserts that a file exists under the mounted data root.
assert_file_exists() {
  local path="$1"
  local label="$2"

  if [[ -f "${path}" ]]; then
    record_pass "${label}"
    return
  fi

  record_failure "${label}" "expected file at ${path}"
}

# Asserts that a directory exists under the mounted data root.
assert_directory_exists() {
  local path="$1"
  local label="$2"

  if [[ -d "${path}" ]]; then
    record_pass "${label}"
    return
  fi

  record_failure "${label}" "expected directory at ${path}"
}

# Asserts that at least one persisted file exists below a directory.
assert_any_file_under() {
  local path="$1"
  local label="$2"
  local match

  if [[ ! -d "${path}" ]]; then
    record_failure "${label}" "expected directory at ${path}"
    return
  fi

  match="$(find "${path}" -type f -print -quit 2>/dev/null || true)"
  if [[ -n "${match}" ]]; then
    record_pass "${label}"
    return
  fi

  record_failure "${label}" "expected at least one persisted file below ${path}"
}

# Writes smoke-owned durable markers into canonical runtime and log folders.
write_persistence_markers() {
  local data_root="$1"
  local workspace_id="$2"
  local workspace_root="${data_root}/users/user_local/workspaces/${workspace_id}"

  mkdir -p \
    "${data_root}/server/runtime/agents/openkit-app-smoke/resolved" \
    "${data_root}/server/logs" \
    "${workspace_root}/logs"

  printf '{ "agentId": "openkit-app-smoke" }\n' > \
    "${data_root}/server/runtime/agents/openkit-app-smoke/resolved/latest.json"
  printf 'openkit app smoke server log\n' > \
    "${data_root}/server/logs/app-persistence-smoke.log"
  printf 'openkit app smoke workspace log\n' > \
    "${workspace_root}/logs/app-persistence-smoke.log"
}

# Seeds the server config for temporary smoke data roots.
seed_server_config() {
  local data_root="$1"
  local config_path="${data_root}/config/server.jsonc"

  mkdir -p "${data_root}/config"

  if [[ -f "${config_path}" ]]; then
    return
  fi

  cat >"${config_path}" <<'JSON'
{
  "schemaVersion": 1,
  "mode": "local",
  "auth": {
    "enabled": false,
    "provider": "better-auth",
    "localModeUserId": "user_local"
  },
  "data": {
    "layoutVersion": 1
  },
  "diagnostics": {
    "redactSecrets": true,
    "emitConfigOrigins": true
  }
}
JSON
}

# Verifies the mounted target data-root layout and persistence markers.
assert_data_root_layout() {
  local data_root="$1"
  local workspace_id="$2"
  local workspace_root="${data_root}/users/user_local/workspaces/${workspace_id}"

  assert_file_exists "${data_root}/server/db/core.sqlite" "data-root server/db/core.sqlite"
  assert_file_exists "${data_root}/config/server.jsonc" "data-root config/server.jsonc"
  assert_directory_exists "${data_root}/config/providers" "data-root config/providers"
  assert_directory_exists "${data_root}/config/agents" "data-root config/agents"
  assert_directory_exists "${data_root}/server/files" "data-root server/files"
  assert_directory_exists "${data_root}/server/db" "data-root server/db"
  assert_directory_exists "${data_root}/server/evidence" "data-root server/evidence"
  assert_directory_exists "${data_root}/server/exports" "data-root server/exports"
  assert_directory_exists "${data_root}/server/logs" "data-root server/logs"
  assert_directory_exists "${data_root}/server/runtime" "data-root server/runtime"
  assert_directory_exists "${data_root}/server/runtime/config" "data-root server/runtime/config"
  assert_directory_exists "${data_root}/server/runtime/agents" "data-root server/runtime/agents"
  assert_directory_exists "${data_root}/server/runtime/sessions" "data-root server/runtime/sessions"
  assert_directory_exists "${data_root}/server/migrations" "data-root server/migrations"
  assert_directory_exists "${data_root}/server/vendor" "data-root server/vendor"
  assert_directory_exists "${data_root}/server/vendor/models.dev" "data-root server/vendor/models.dev"
  assert_directory_exists "${data_root}/users/user_local" "data-root users/user_local"
  assert_directory_exists "${data_root}/users/user_local/files" "data-root users/user_local/files"
  assert_directory_exists "${data_root}/users/user_local/data" "data-root users/user_local/data"
  assert_directory_exists "${data_root}/users/user_local/db" "data-root users/user_local/db"
  assert_directory_exists "${data_root}/users/user_local/logs" "data-root users/user_local/logs"
  assert_directory_exists "${data_root}/users/user_local/config" "data-root users/user_local/config"
  assert_directory_exists "${data_root}/users/user_local/workspaces" "data-root users/user_local/workspaces"
  assert_directory_exists "${workspace_root}" "data-root users/user_local/workspaces/${workspace_id}"
  assert_directory_exists "${workspace_root}/files" "data-root users/user_local/workspaces/${workspace_id}/files"
  assert_directory_exists "${workspace_root}/data" "data-root users/user_local/workspaces/${workspace_id}/data"
  assert_directory_exists "${workspace_root}/db" "data-root users/user_local/workspaces/${workspace_id}/db"
  assert_directory_exists "${workspace_root}/logs" "data-root users/user_local/workspaces/${workspace_id}/logs"
  assert_directory_exists "${workspace_root}/artifacts" "data-root users/user_local/workspaces/${workspace_id}/artifacts"
  assert_directory_exists "${workspace_root}/knowledge" "data-root users/user_local/workspaces/${workspace_id}/knowledge"
  assert_directory_exists "${workspace_root}/sources" "data-root users/user_local/workspaces/${workspace_id}/sources"
  assert_directory_exists "${workspace_root}/threads" "data-root users/user_local/workspaces/${workspace_id}/threads"
  assert_directory_exists "${workspace_root}/runtime" "data-root users/user_local/workspaces/${workspace_id}/runtime"
  assert_directory_exists "${workspace_root}/reviews" "data-root users/user_local/workspaces/${workspace_id}/reviews"
  assert_directory_exists "${workspace_root}/evidence" "data-root users/user_local/workspaces/${workspace_id}/evidence"
  assert_directory_exists "${workspace_root}/indexes" "data-root users/user_local/workspaces/${workspace_id}/indexes"
  assert_any_file_under "${data_root}/server/runtime/agents" "data-root agent resolved snapshot"
  assert_any_file_under "${data_root}/server/logs" "data-root server log"
  assert_any_file_under "${workspace_root}/logs" "data-root workspace log"
}

start_container() {
  docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
  docker run \
    --detach \
    --name "${CONTAINER_NAME}" \
    --publish "127.0.0.1:${PORT}:8080" \
    --volume "${DATA_ROOT}:/data/openkit" \
    --env OPENKIT_CORE_MODE=local \
    "${IMAGE}" >/dev/null
}

wait_for_url() {
  local url="$1"

  for attempt in $(seq 1 60); do
    if curl -fsS "${url}" >/dev/null 2>&1; then
      return 0
    fi

    if ! docker ps --format '{{.Names}}' | grep -Fx "${CONTAINER_NAME}" >/dev/null; then
      echo "Container exited before ${url} became reachable." >&2
      docker logs "${CONTAINER_NAME}" >&2 || true
      return 1
    fi

    if [[ "${attempt}" -eq 60 ]]; then
      echo "Timed out waiting for ${url}." >&2
      docker logs "${CONTAINER_NAME}" >&2 || true
      return 1
    fi

    sleep 1
  done
}

create_workspace() {
  local payload

  payload="$(
    WORKSPACE_NAME="${WORKSPACE_NAME}" node -e \
      'process.stdout.write(JSON.stringify({ name: process.env.WORKSPACE_NAME }));'
  )"

  curl -fsS \
    --request POST \
    --header 'content-type: application/json' \
    --data "${payload}" \
    "${BASE_URL}/api/workspaces"
}

read_workspace_id() {
  node -e "const data = JSON.parse(process.argv[1]); if (!data.id) process.exit(1); process.stdout.write(data.id);" "$1"
}

assert_workspace_exists() {
  node -e "const data = JSON.parse(process.argv[1]); const id = process.argv[2]; const found = Array.isArray(data.items) && data.items.some((item) => item.id === id); if (!found) process.exit(1);" "$1" "$2"
}

if [[ "${OPENKIT_APP_SMOKE_ASSERT_ONLY:-0}" == "1" ]]; then
  assert_data_root_layout "${DATA_ROOT}" "${OPENKIT_APP_SMOKE_WORKSPACE_ID:-}"
  finish_checks
  exit $?
fi

trap cleanup EXIT

require_command docker
require_command curl
require_command node

docker image inspect "${IMAGE}" >/dev/null

seed_server_config "${DATA_ROOT}"
start_container
wait_for_url "${BASE_URL}/api/health"

root_html="$(curl -fsS "${BASE_URL}/")"
if [[ "${root_html}" != *"<html"* ]]; then
  record_failure "http spa root" "expected HTML from ${BASE_URL}/"
else
  record_pass "http spa root"
fi

workspace_response="$(create_workspace)"
workspace_id="$(read_workspace_id "${workspace_response}")"
record_pass "api workspace created"

write_persistence_markers "${DATA_ROOT}" "${workspace_id}"
assert_data_root_layout "${DATA_ROOT}" "${workspace_id}"

docker rm -f "${CONTAINER_NAME}" >/dev/null

start_container
wait_for_url "${BASE_URL}/api/health"

workspace_list="$(curl -fsS "${BASE_URL}/api/workspaces")"
if assert_workspace_exists "${workspace_list}" "${workspace_id}"; then
  record_pass "api workspace persisted"
else
  record_failure "api workspace persisted" "workspace ${workspace_id} was not returned after restart"
fi

assert_data_root_layout "${DATA_ROOT}" "${workspace_id}"

finish_checks
