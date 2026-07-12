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

function readAgentSecretEnvName(serverConfigPath) {
  if (!fs.existsSync(serverConfigPath)) {
    return null;
  }

  const serverConfig = readServerConfig(serverConfigPath);
  const providers = Array.isArray(serverConfig.providers) ? serverConfig.providers : [];
  const provider = providers.find((entry) => entry?.id === 'nano-agent-openrouter');

  if (!provider?.secretRef) {
    return null;
  }

  return readEnvSecretName(provider.secretRef, provider.id);
}

function readServerConfig(serverConfigPath) {
  const errors = [];
  const text = fs.readFileSync(serverConfigPath, 'utf8');
  const parsed = parse(text, errors, { allowTrailingComma: true });

  if (errors.length > 0) {
    const details = errors
      .map((error) => `${printParseErrorCode(error.error)} at offset ${error.offset}`)
      .join(', ');
    throw new Error(`Failed to parse ${serverConfigPath}: ${details}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${serverConfigPath} must contain a JSON object.`);
  }

  validateNoInlineProviderSecrets(parsed);

  return parsed;
}

function validateNoInlineProviderSecrets(serverConfig) {
  const providers = Array.isArray(serverConfig.providers) ? serverConfig.providers : [];

  for (const [index, provider] of providers.entries()) {
    if (!provider || typeof provider !== 'object' || Array.isArray(provider)) {
      continue;
    }

    for (const field of inlineSecretFields) {
      if (Object.hasOwn(provider, field)) {
        const providerId = typeof provider.id === 'string' ? provider.id : `providers[${index}]`;
        throw new Error(
          `${field} is not supported in app provider config for ${providerId}; use secretRef such as "${defaultSecretRef}" instead.`
        );
      }
    }
  }
}

function readEnvSecretName(secretRef, providerId) {
  if (typeof secretRef !== 'string' || !secretRef.startsWith('env:')) {
    throw new Error(
      `App provider ${providerId} must use an env: secretRef such as "${defaultSecretRef}".`
    );
  }

  const envName = secretRef.slice('env:'.length);

  if (!envName) {
    throw new Error(`App provider ${providerId} has an empty env: secretRef.`);
  }

  return envName;
}

function serverConfig() {
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      mode: 'local',
      data: {
        layoutVersion: 1,
        root: '/data/openkit',
      },
      defaults: {
        coreProviderId: 'nanocore-openrouter',
        coreModel: defaultModel,
        gatewayProviderId: 'nano-agent-openrouter',
        gatewayModel: defaultModel,
        agentId: 'agent_codex_host',
      },
      providers: [
        {
          id: 'nanocore-openrouter',
          displayName: 'NanoCore OpenRouter',
          vendor: 'openrouter',
          kind: 'custom',
          baseUrl: 'https://openrouter.ai/api/v1',
          models,
          defaultModel,
          secretRef: defaultSecretRef,
        },
        {
          id: 'nano-agent-openrouter',
          displayName: 'Nano Agent OpenRouter',
          vendor: 'openrouter',
          kind: 'custom',
          baseUrl: 'https://openrouter.ai/api/v1',
          models,
          defaultModel,
          secretRef: defaultSecretRef,
        },
      ],
      gateway: {
        openaiCompatible: {
          enabled: true,
          defaultProviderId: 'nano-agent-openrouter',
          defaultModel,
          allowedProviderIds: ['nano-agent-openrouter'],
        },
      },
      internal: {
        openaiCompatFacade: {
          enabled: true,
          defaultProviderId: 'nano-agent-openrouter',
          defaultModel,
        },
      },
      diagnostics: {
        redactSecrets: true,
      },
    },
    null,
    2
  )}\n`;
}

function agentConfig(id, displayName, kind, adapter) {
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      id,
      displayName,
      mode: 'host',
      runtime: {
        kind,
        adapter,
      },
      provider: {
        ref: 'nano-agent-openrouter',
        model: defaultModel,
      },
      deployment: {
        host:
          kind === 'codex'
            ? { command: 'codex', args: ['app-server', '--listen', 'stdio://'] }
            : { command: 'opencode', args: ['serve'] },
      },
    },
    null,
    2
  )}\n`;
}

function codexConfig(envName) {
  return `model = "${defaultModel}"
model_provider = "openrouter"
model_reasoning_effort = "low"

[model_providers.openrouter]
name = "OpenRouter"
base_url = "https://openrouter.ai/api/v1"
env_key = "${envName}"
wire_api = "responses"
`;
}

if (!dataRoot) {
  throw new Error('APP_DATA_ROOT is required.');
}

mkdirp(dataRoot);
mkdirp(path.join(dataRoot, 'config', 'providers'));
mkdirp(path.join(dataRoot, 'config', 'agents', 'codex-home'));
mkdirp(path.join(dataRoot, 'users', 'user_local', 'workspaces'));

const serverConfigPath = path.join(dataRoot, 'config', 'server.jsonc');
const wroteServerConfig = writeFileIfMissing(serverConfigPath, serverConfig());
const agentSecretEnvName = readAgentSecretEnvName(serverConfigPath);
writeFileIfMissing(
  path.join(dataRoot, 'config', 'agents', 'codex.agent.jsonc'),
  agentConfig('agent_codex_host', 'Codex Host Agent', 'codex', 'codex-app-server')
);
writeFileIfMissing(
  path.join(dataRoot, 'config', 'agents', 'opencode-server.agent.jsonc'),
  agentConfig('agent_opencode_server', 'OpenCode Server Agent', 'opencode', 'opencode-server')
);
fs.writeFileSync(
  path.join(dataRoot, 'config', 'agents', 'codex-home', 'config.toml'),
  codexConfig(agentSecretEnvName ?? 'OPENROUTER_API_KEY'),
  { mode: 0o600 }
);

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
const serverConfigPath = path.join(dataRoot, 'config', 'server.jsonc');

if (!fs.existsSync(serverConfigPath)) {
  process.exit(0);
}

const parsed = parse(fs.readFileSync(serverConfigPath, 'utf8'), [], { allowTrailingComma: true });
const envNames = new Set();

for (const provider of Array.isArray(parsed?.providers) ? parsed.providers : []) {
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
