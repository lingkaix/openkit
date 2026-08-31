#!/usr/bin/env bash
set -euo pipefail

INITIAL_DATA_ROOT="${OPENKIT_APP_DATA_ROOT:-${HOME}/nano-data}"
APP_ENV_FILE="${OPENKIT_APP_ENV_FILE:-${INITIAL_DATA_ROOT}/secrets/openkit.env}"

if [[ -f "${APP_ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${APP_ENV_FILE}"
  set +a
fi

DATA_ROOT="${OPENKIT_APP_DATA_ROOT:-${INITIAL_DATA_ROOT}}"
IMAGE="${OPENKIT_APP_IMAGE:-openkit/app:dev}"
CONTAINER_NAME="${OPENKIT_APP_CONTAINER:-openkit-app}"
PORT="${OPENKIT_APP_PORT:-7080}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
REBUILD="0"
SEED_ONLY="${OPENKIT_APP_SEED_ONLY:-0}"

usage() {
  cat <<'EOF'
Usage: pnpm run app:run [--rebuild]

Starts the OpenKit app container on http://127.0.0.1:7080 using ~/nano-data.

Options:
  --rebuild   Rebuild the openkit/app:dev image before starting the container.
  -h, --help  Show this help.
EOF
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --)
      ;;
    --rebuild)
      REBUILD="1"
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

require_command() {
  local command_name="$1"

  if ! command -v "${command_name}" >/dev/null 2>&1; then
    echo "Required command not found: ${command_name}" >&2
    exit 127
  fi
}

seed_data_root() {
  APP_DATA_ROOT="${DATA_ROOT}" APP_REPO_ROOT="${REPO_ROOT}" node <<'NODE'
const fs = require('fs');
const path = require('path');

const dataRoot = process.env.APP_DATA_ROOT;
const repoRoot = process.env.APP_REPO_ROOT;
const { parse, printParseErrorCode } = require(path.join(
  repoRoot,
  'apps',
  'nanocore',
  'node_modules',
  'jsonc-parser'
));
const models = [
  'deepseek/deepseek-v4-flash:free',
  'google/gemma-4-26b-a4b-it:free',
  'google/gemma-4-31b-it:free',
  'z-ai/glm-4.5-air:free',
  'arcee-ai/trinity-large-thinking:free',
  'cognitivecomputations/dolphin-mistral-24b-venice-edition:free',
];
const defaultModel = 'z-ai/glm-4.5-air:free';
const defaultSecretRef = 'env:OPENROUTER_API_KEY';
const inlineSecretFields = ['apiKey', 'clientSecret', 'secret', 'token'];

function mkdirp(target) {
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
}

function writeFileIfMissing(target, content) {
  if (fs.existsSync(target)) {
    return false;
  }

  fs.writeFileSync(target, content, { mode: 0o600 });
  return true;
}

function readJsoncObject(configPath) {
  const errors = [];
  const text = fs.readFileSync(configPath, 'utf8');
  const parsed = parse(text, errors, { allowTrailingComma: true });

  if (errors.length > 0) {
    const details = errors
      .map((error) => `${printParseErrorCode(error.error)} at offset ${error.offset}`)
      .join(', ');
    throw new Error(`Failed to parse ${configPath}: ${details}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${configPath} must contain a JSON object.`);
  }
  return parsed;
}

function validateNoInlineProviderSecrets(provider) {
  for (const field of inlineSecretFields) {
    if (Object.hasOwn(provider, field)) {
      const providerId = typeof provider.id === 'string' ? provider.id : 'unknown-provider';
      throw new Error(
        `${field} is not supported in app provider config for ${providerId}; use secretRef such as "${defaultSecretRef}" instead.`
      );
    }
  }
}

function serverConfig() {
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      mode: 'local',
      defaults: {
        defaultAgentId: 'agent_codex_host',
      },
    },
    null,
    2
  )}\n`;
}

function providerConfig() {
  return `${JSON.stringify(
    {
      id: 'openrouter',
      displayName: 'OpenRouter',
      vendor: 'openrouter',
      kind: 'custom',
      baseUrl: 'https://openrouter.ai/api/v1',
      models,
      defaultModel,
      secretRef: defaultSecretRef,
    },
    null,
    2
  )}\n`;
}

function gatewayConfig() {
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      enabled: true,
      defaultLogicalModelId: 'reasoning-free',
      logicalModels: [
        {
          id: 'reasoning-free',
          displayName: 'Reasoning Free',
          routes: [
            { id: 'openrouter-primary', providerProfileId: 'openrouter', providerModel: defaultModel },
          ],
        },
      ],
      requiredFeatures: [],
    },
    null,
    2
  )}\n`;
}

function internalRoleProfiles() {
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      defaultLogicalModelId: 'reasoning-free',
      profiles: [],
    },
    null,
    2
  )}\n`;
}

if (!dataRoot) {
  throw new Error('APP_DATA_ROOT is required.');
}

mkdirp(dataRoot);
mkdirp(path.join(dataRoot, 'config', 'providers'));
mkdirp(path.join(dataRoot, 'users', 'user_local'));
mkdirp(path.join(dataRoot, 'workspaces'));

const serverConfigPath = path.join(dataRoot, 'config', 'server.jsonc');
const providerConfigPath = path.join(dataRoot, 'config', 'providers', 'openrouter.provider.jsonc');
const gatewayConfigPath = path.join(dataRoot, 'config', 'gateway.jsonc');
const internalRoleProfilesPath = path.join(dataRoot, 'config', 'internal-role-profiles.jsonc');
const wroteServerConfig = writeFileIfMissing(serverConfigPath, serverConfig());
writeFileIfMissing(providerConfigPath, providerConfig());
writeFileIfMissing(gatewayConfigPath, gatewayConfig());
writeFileIfMissing(internalRoleProfilesPath, internalRoleProfiles());
readJsoncObject(serverConfigPath);
validateNoInlineProviderSecrets(readJsoncObject(providerConfigPath));

if (wroteServerConfig) {
  console.log(`Created ${serverConfigPath} with secretRef env references.`);
} else {
  console.log(`Using existing ${serverConfigPath}.`);
}
NODE
}

resolve_provider_secret_env_names() {
  APP_DATA_ROOT="${DATA_ROOT}" APP_REPO_ROOT="${REPO_ROOT}" node <<'NODE'
const fs = require('fs');
const path = require('path');

const dataRoot = process.env.APP_DATA_ROOT;
const repoRoot = process.env.APP_REPO_ROOT;
const { parse } = require(path.join(
  repoRoot,
  'apps',
  'nanocore',
  'node_modules',
  'jsonc-parser'
));
const providersRoot = path.join(dataRoot, 'config', 'providers');

if (!fs.existsSync(providersRoot)) {
  process.exit(0);
}
const envNames = new Set();
for (const fileName of fs.readdirSync(providersRoot).filter((name) => name.endsWith('.provider.jsonc'))) {
  const provider = parse(fs.readFileSync(path.join(providersRoot, fileName), 'utf8'), [], {
    allowTrailingComma: true,
  });
  if (typeof provider?.secretRef === 'string' && provider.secretRef.startsWith('env:')) {
    const envName = provider.secretRef.slice('env:'.length);
    if (envName) {
      envNames.add(envName);
    }
  }
}

process.stdout.write([...envNames].join('\n'));
NODE
}

wait_for_health() {
  local base_url="http://127.0.0.1:${PORT}"

  for _attempt in $(seq 1 45); do
    if curl -fsS "${base_url}/api/health" >/dev/null 2>&1; then
      echo "OpenKit app is ready at ${base_url}"
      return 0
    fi

    sleep 1
  done

  echo "OpenKit app did not become healthy on ${base_url}." >&2
  return 1
}

seed_data_root
PROVIDER_SECRET_ENV_NAMES="$(resolve_provider_secret_env_names)"

if [[ "${SEED_ONLY}" == "1" ]]; then
  echo "Seed-only mode complete."
  exit 0
fi

require_command docker
require_command curl

if [[ "${REBUILD}" == "1" ]]; then
  scripts/docker/build-image.sh app "${IMAGE}"
elif ! docker image inspect "${IMAGE}" >/dev/null 2>&1; then
  echo "Image ${IMAGE} was not found; building it now."
  scripts/docker/build-image.sh app "${IMAGE}"
fi

docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
docker_env_args=(
  --env OPENKIT_CORE_MODE=local
  --env OPENKIT_DATA_ROOT=/data/openkit
)

while IFS= read -r env_name; do
  if [[ -n "${env_name}" && -n "${!env_name:-}" ]]; then
    docker_env_args+=(--env "${env_name}")
  fi
done <<<"${PROVIDER_SECRET_ENV_NAMES}"

docker run \
  -d \
  --name "${CONTAINER_NAME}" \
  --publish "127.0.0.1:${PORT}:8080" \
  --volume "${DATA_ROOT}:/data/openkit" \
  "${docker_env_args[@]}" \
  "${IMAGE}" >/dev/null

wait_for_health
