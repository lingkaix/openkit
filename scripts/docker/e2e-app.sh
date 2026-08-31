#!/usr/bin/env bash
set -euo pipefail

IMAGE="${OPENKIT_APP_IMAGE:-openkit/app:dev}"
PORT="${OPENKIT_APP_UI_E2E_PORT:-18081}"
CONTAINER_NAME="${OPENKIT_APP_UI_E2E_CONTAINER:-openkit-app-e2e-$$}"
BASE_URL="http://127.0.0.1:${PORT}"
PROVIDER_ID="${OPENKIT_APP_E2E_PROVIDER_ID:-provider_app_redaction}"
SECRET="${OPENKIT_APP_E2E_SECRET:-sk-openkit-app-e2e-secret}"
DATA_ROOT_CREATED="0"

if [[ -n "${OPENKIT_APP_UI_E2E_DATA_ROOT:-}" ]]; then
  DATA_ROOT="${OPENKIT_APP_UI_E2E_DATA_ROOT}"
  mkdir -p "${DATA_ROOT}"
else
  DATA_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/openkit-app-e2e-data.XXXXXX")"
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

seed_data_root() {
  DATA_ROOT="${DATA_ROOT}" PROVIDER_ID="${PROVIDER_ID}" SECRET="${SECRET}" node <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const dataRoot = process.env.DATA_ROOT;
const providerId = process.env.PROVIDER_ID;
const secret = process.env.SECRET;

if (!dataRoot || !providerId || !secret) {
  throw new Error('Missing app UI e2e seed inputs.');
}

const configRoot = path.join(dataRoot, 'config');
const providersRoot = path.join(configRoot, 'providers');

fs.mkdirSync(providersRoot, { recursive: true });
fs.writeFileSync(
  path.join(configRoot, 'server.jsonc'),
  `${JSON.stringify({ schemaVersion: 1, mode: 'local' }, null, 2)}\n`
);
fs.writeFileSync(
  path.join(providersRoot, 'app-redaction.provider.jsonc'),
  `${JSON.stringify(
    {
      id: providerId,
      displayName: 'App Redaction Provider',
      kind: 'custom',
      baseUrl: 'https://provider.example.com/v1',
      models: ['app-redaction-model'],
      defaultModel: 'app-redaction-model',
      secretRef: 'env:OPENKIT_APP_E2E_SECRET',
      readiness: { status: 'ready' },
    },
    null,
    2
  )}\n`
);
fs.writeFileSync(
  path.join(configRoot, 'gateway.jsonc'),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      enabled: true,
      defaultLogicalModelId: 'app-redaction-model',
      logicalModels: [
        {
          id: 'app-redaction-model',
          displayName: 'App Redaction Model',
          routes: [
            {
              id: 'app-redaction-primary',
              providerProfileId: providerId,
              providerModel: 'app-redaction-model',
            },
          ],
        },
      ],
    },
    null,
    2
  )}\n`
);
NODE
}

start_container() {
  docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
  docker run \
    --detach \
    --name "${CONTAINER_NAME}" \
    --publish "127.0.0.1:${PORT}:8080" \
    --volume "${DATA_ROOT}:/data/openkit" \
    --env OPENKIT_CORE_MODE=local \
    --env OPENKIT_INTERNAL_SELF_CHECK_EXECUTOR=1 \
    --env "OPENKIT_APP_E2E_SECRET=${SECRET}" \
    "${IMAGE}" >/dev/null
}

wait_for_url() {
  local url="$1"

  for attempt in $(seq 1 60); do
    if curl -fsS "${url}" >/dev/null; then
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

run_playwright() {
  OPENKIT_APP_E2E_BASE_URL="${BASE_URL}" \
    OPENKIT_APP_E2E_PROVIDER_ID="${PROVIDER_ID}" \
    OPENKIT_APP_E2E_SECRET="${SECRET}" \
    pnpm --filter @openkit/web e2e:staging
}

trap cleanup EXIT

require_command docker
require_command curl
require_command node
require_command pnpm

docker image inspect "${IMAGE}" >/dev/null
seed_data_root
start_container
wait_for_url "${BASE_URL}/api/health"
run_playwright
