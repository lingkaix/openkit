#!/usr/bin/env bash
# Update the existing A2 dogfood deployment; see README.md for host prerequisites.
set -Eeuo pipefail

umask 077

BASE_DIR="${HOME}/openkit"
REPO_DIR="${BASE_DIR}/source"
ARTIFACT_DIR="${BASE_DIR}/artifacts"
WEB_ROOT="${BASE_DIR}/web"
SECRETS_DIR="${BASE_DIR}/secrets"
ENV_FILE="${SECRETS_DIR}/openkit.env"
VAULT_KEY_FILE="${SECRETS_DIR}/openkit-vault.key"
NANOHOST_CREDENTIALS_DIR="${SECRETS_DIR}/nanohost"
APP_CADDYFILE="${BASE_DIR}/app.Caddyfile"
WEB_DOCKERFILE="${BASE_DIR}/web.Dockerfile"
NANOCORE_DOCKERFILE="${BASE_DIR}/nanocore.Dockerfile"
NANOHOST_ENV_SOURCE="${BASE_DIR}/nanohost.env"
SEED_IMAGE_HELPER="${BASE_DIR}/seed-nanohost-image.py"
DATA_ROOT="${HOME}/.openkit"
REPO_URL="https://github.com/lingkaix/openkit.git"
LINKED_REPOS_DIR="${BASE_DIR}/workspaces-repos"
LINKED_REPOS_PIN="${BASE_DIR}/current-linked-repos"
CONTAINER_NAME="openkit-staging"
PREVIOUS_CONTAINER_NAME="openkit-staging-previous"
HOST_PORT="7080"
MISE_BIN="${HOME}/.local/bin/mise"
TARGET="${1:-all}"

# Report the supported component targets.
usage() {
  echo "Usage: $0 [web|nanocore|nanohost|linked-repos|all]" >&2
  exit 64
}

case "${TARGET}" in
  web | nanocore | nanohost | linked-repos | all) ;;
  *) usage ;;
esac

# Fail before deployment when a required host command is unavailable.
require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Required command not found: $1" >&2
    exit 127
  fi
}

for command_name in curl docker flock git jq openssl python3 systemctl tar; do
  require_command "${command_name}"
done
if [[ ! -x "${MISE_BIN}" ]]; then
  echo "Required command not found: ${MISE_BIN}" >&2
  exit 127
fi

mkdir -p "${BASE_DIR}" "${ARTIFACT_DIR}" "${WEB_ROOT}" "${SECRETS_DIR}" "${NANOHOST_CREDENTIALS_DIR}"
chmod 700 "${BASE_DIR}" "${ARTIFACT_DIR}" "${WEB_ROOT}" "${SECRETS_DIR}" "${NANOHOST_CREDENTIALS_DIR}"
if [[ ! -d "${DATA_ROOT}" ]]; then
  echo "Existing staging data root is missing: ${DATA_ROOT}" >&2
  exit 1
fi
if [[ ! -s "${APP_CADDYFILE}" || ! -s "${WEB_DOCKERFILE}" || ! -s "${NANOHOST_ENV_SOURCE}" || ! -s "${SEED_IMAGE_HELPER}" ]]; then
  echo "Required deployment config is missing from ${BASE_DIR}." >&2
  exit 1
fi

exec 9>"${BASE_DIR}/deploy.lock"
if ! flock -n 9; then
  echo "Another staging deployment is already running." >&2
  exit 1
fi

if [[ ! -f "${ENV_FILE}" ]]; then
  secret="$(openssl rand -hex 32)"
  env_tmp="${ENV_FILE}.tmp"
  printf '%s\n' \
    "BETTER_AUTH_SECRET=${secret}" \
    "BETTER_AUTH_URL=https://ai.simonxu.net" \
    "BETTER_AUTH_TRUSTED_ORIGINS=https://ai.simonxu.net" \
    "NODE_ENV=production" >"${env_tmp}"
  chmod 600 "${env_tmp}"
  mv "${env_tmp}" "${ENV_FILE}"
  unset secret
fi

chmod 600 "${ENV_FILE}"
if ! grep -Eq '^BETTER_AUTH_SECRET=.{32,}$' "${ENV_FILE}" || ! grep -Fxq 'BETTER_AUTH_URL=https://ai.simonxu.net' "${ENV_FILE}" || ! grep -Fxq 'BETTER_AUTH_TRUSTED_ORIGINS=https://ai.simonxu.net' "${ENV_FILE}"; then
  echo "Invalid staging App environment." >&2
  exit 1
fi

if [[ ! -e "${VAULT_KEY_FILE}" ]]; then
  vault_key_tmp="${VAULT_KEY_FILE}.tmp"
  openssl rand -out "${vault_key_tmp}" 32
  chmod 600 "${vault_key_tmp}"
  sudo -n install -m 600 -o root -g root "${vault_key_tmp}" "${VAULT_KEY_FILE}"
  rm "${vault_key_tmp}"
fi
if [[ "$(stat -c '%s:%a:%u' "${VAULT_KEY_FILE}")" != "32:600:0" ]]; then
  echo "${VAULT_KEY_FILE} must be a root-owned exact-0600 file containing 32 raw bytes." >&2
  exit 1
fi

# Resolve the clean deployment checkout to public origin/main.
update_source() {
  if [[ ! -d "${REPO_DIR}/.git" ]]; then
    git clone --branch main --single-branch "${REPO_URL}" "${REPO_DIR}"
  else
    if [[ "$(git -C "${REPO_DIR}" remote get-url origin)" != "${REPO_URL}" || -n "$(git -C "${REPO_DIR}" status --porcelain)" ]]; then
      echo "Deployment checkout is not the clean public origin: ${REPO_DIR}" >&2
      exit 1
    fi
    git -C "${REPO_DIR}" fetch --prune origin main
    git -C "${REPO_DIR}" switch main
    git -C "${REPO_DIR}" merge --ff-only origin/main
  fi

  commit="$(git -C "${REPO_DIR}" rev-parse HEAD)"
  if [[ "${commit}" != "$(git -C "${REPO_DIR}" rev-parse origin/main)" ]]; then
    echo "Deployment checkout does not match origin/main." >&2
    exit 1
  fi
  chmod -R a+rX "${REPO_DIR}"
}

# Fast-forward clean linked dogfood checkouts under workspaces-repos to public origin/main.
# Refuse dirty or divergent trees so dogfood patches are never silently discarded.
sync_linked_repos() {
  mkdir -p "${LINKED_REPOS_DIR}"
  if [[ ! -d "${LINKED_REPOS_DIR}/openkit/.git" ]]; then
    git clone --branch main --single-branch "${REPO_URL}" "${LINKED_REPOS_DIR}/openkit"
  fi

  pin_tmp="${LINKED_REPOS_PIN}.tmp"
  : >"${pin_tmp}"
  chmod 600 "${pin_tmp}"

  shopt -s nullglob
  for repo in "${LINKED_REPOS_DIR}"/*/; do
    if [[ ! -d "${repo}/.git" ]]; then
      continue
    fi
    name="$(basename "${repo}")"
    if [[ -n "$(git -C "${repo}" status --porcelain)" ]]; then
      echo "Linked repository has local changes; back it up before syncing: ${repo}" >&2
      exit 1
    fi
    origin_url="$(git -C "${repo}" remote get-url origin 2>/dev/null || true)"
    if [[ "${origin_url}" != "${REPO_URL}" ]]; then
      head="$(git -C "${repo}" rev-parse HEAD)"
      printf '%s=%s pin\n' "${name}" "${head}" >>"${pin_tmp}"
      echo "Leaving linked repository ${name} at ${head} (origin is not the public OpenKit URL)."
      continue
    fi
    git -C "${repo}" fetch --prune origin main
    git -C "${repo}" switch main
    if ! git -C "${repo}" merge --ff-only origin/main; then
      echo "Linked repository ${name} cannot fast-forward to origin/main; backup and resolve before dogfood." >&2
      exit 1
    fi
    head="$(git -C "${repo}" rev-parse HEAD)"
    if [[ "${head}" != "$(git -C "${repo}" rev-parse origin/main)" ]]; then
      echo "Linked repository ${name} does not match origin/main." >&2
      exit 1
    fi
    printf '%s=%s\n' "${name}" "${head}" >>"${pin_tmp}"
    echo "Linked repository ${name} is at ${head}."
  done
  shopt -u nullglob

  mv "${pin_tmp}" "${LINKED_REPOS_PIN}"
}

# Extract built Web assets and switch the persistent current link.
publish_web_image() {
  local source_image="$1"
  local staging_dir="${WEB_ROOT}/.${commit}.partial"
  local assets_container

  sudo -n rm -rf "${staging_dir}" "${WEB_ROOT:?}/${commit}"
  sudo -n install -d -m 0755 "${staging_dir}"
  assets_container="$(sudo -n docker create "${source_image}")"
  if ! sudo -n docker cp "${assets_container}:/srv/web/." "${staging_dir}"; then
    sudo -n docker rm "${assets_container}" >/dev/null || true
    exit 1
  fi
  sudo -n docker rm "${assets_container}" >/dev/null
  sudo -n mv "${staging_dir}" "${WEB_ROOT}/${commit}"
  sudo -n ln -s "${commit}" "${WEB_ROOT}/.current-${commit}"
  sudo -n mv -Tf "${WEB_ROOT}/.current-${commit}" "${WEB_ROOT}/current"
}

# Build and publish only the Web UI.
build_web() {
  web_image="openkit/web:staging-${commit}"
  echo "Building Web UI from public origin/main."
  sudo -n docker build --file "${WEB_DOCKERFILE}" --tag "${web_image}" "${REPO_DIR}"
  publish_web_image "${web_image}"
}

# Build and smoke-check the NanoCore App image from the repository Dockerfile.
# Host $HOME/openkit/nanocore.Dockerfile is no longer used for builds; keep the file
# only if older helpers still reference it. Smoke requires openkit-operator on PATH.
build_app() {
  image="openkit/app:staging-${commit}"
  echo "Building NanoCore App from public origin/main (containers/app/Dockerfile)."
  sudo -n docker build --file "${REPO_DIR}/containers/app/Dockerfile" --tag "${image}" "${REPO_DIR}"
  sudo -n docker run --rm "${image}" openkit-app-smoke
}

# Build and smoke-check the complete App, then publish its Web assets.
build_full_app() {
  image="openkit/app:staging-${commit}"
  echo "Building complete App from public origin/main."
  sudo -n docker build --file "${REPO_DIR}/containers/app/Dockerfile" --tag "${image}" "${REPO_DIR}"
  sudo -n docker run --rm "${image}" openkit-app-smoke
  publish_web_image "${image}"
}

# Wait for both Web and NanoCore health on the staging listener.
wait_for_app() {
  for _attempt in $(seq 1 120); do
    if curl -fsS -H 'Host: ai.simonxu.net' "http://127.0.0.1:${HOST_PORT}/" 2>/dev/null | grep -Fq '<div id="root"></div>' \
      && curl -fsS -H 'Host: ai.simonxu.net' "http://127.0.0.1:${HOST_PORT}/api/health" 2>/dev/null | jq -e '.status == "ok" and .service == "nanocore"' >/dev/null; then
      return
    fi
    sleep 1
  done
  return 1
}

# Replace the App container while retaining the previous container until healthy.
replace_app() {
  local next_image="$1"
  local app_commit="$2"
  local had_current=0

  if sudo -n docker container inspect "${PREVIOUS_CONTAINER_NAME}" >/dev/null 2>&1; then
    echo "Recovery container ${PREVIOUS_CONTAINER_NAME} already exists; resolve it before deploying." >&2
    exit 1
  fi
  if sudo -n docker container inspect "${CONTAINER_NAME}" >/dev/null 2>&1; then
    had_current=1
    sudo -n docker stop --time 60 "${CONTAINER_NAME}" >/dev/null
    sudo -n docker rename "${CONTAINER_NAME}" "${PREVIOUS_CONTAINER_NAME}"
  fi

  sudo -n docker run \
    --detach \
    --name "${CONTAINER_NAME}" \
    --restart unless-stopped \
    --network host \
    --volume "${DATA_ROOT}:/data/openkit" \
    --volume "${NANOHOST_CREDENTIALS_DIR}:/run/nanohost-credentials" \
    --mount "type=bind,src=${WEB_ROOT},dst=/srv/web,readonly" \
    --mount "type=bind,src=${APP_CADDYFILE},dst=/etc/caddy/Caddyfile,readonly" \
    --mount "type=bind,src=${VAULT_KEY_FILE},dst=/run/secrets/openkit-vault.key,readonly" \
    --mount "type=bind,src=${BASE_DIR}/workspaces-repos,dst=/srv/repos" \
    --env-file "${ENV_FILE}" \
    --env "CADDY_HTTP_PORT=${HOST_PORT}" \
    --env OPENKIT_CORE_MODE=server \
    --env OPENKIT_DATA_ROOT=/data/openkit \
    --health-cmd 'curl -fsS -H "Host: ai.simonxu.net" http://127.0.0.1:7080/ | grep -Fq "<div id=\"root\"></div>"' \
    --health-interval 30s \
    --health-timeout 5s \
    --health-retries 3 \
    --label "org.openkit.staging.commit=${app_commit}" \
    --log-opt max-size=10m \
    --log-opt max-file=5 \
    "${next_image}" >/dev/null

  if wait_for_app; then
    if (( had_current == 1 )); then
      sudo -n docker rm "${PREVIOUS_CONTAINER_NAME}" >/dev/null
    fi
    return
  fi

  sudo -n docker stop --time 30 "${CONTAINER_NAME}" >/dev/null 2>&1 || true
  if (( had_current == 1 )); then
    sudo -n docker rm "${CONTAINER_NAME}" >/dev/null 2>&1 || true
    sudo -n docker rename "${PREVIOUS_CONTAINER_NAME}" "${CONTAINER_NAME}"
    sudo -n docker start "${CONTAINER_NAME}" >/dev/null
  fi
  sudo -n systemctl start openkit-nanohost.service || true
  echo "New App did not become healthy." >&2
  exit 1
}

# Recreate the current App when its persistent Web mount is absent.
ensure_web_mount() {
  local mounted_source
  mounted_source="$(sudo -n docker inspect --format '{{range .Mounts}}{{if eq .Destination "/srv/web"}}{{.Source}}{{end}}{{end}}' "${CONTAINER_NAME}" 2>/dev/null || true)"
  if [[ "${mounted_source}" == "${WEB_ROOT}" ]]; then
    return
  fi
  local current_image
  local current_commit
  current_image="$(sudo -n docker inspect --format '{{.Config.Image}}' "${CONTAINER_NAME}")"
  current_commit="$(sudo -n docker inspect --format '{{index .Config.Labels "org.openkit.staging.commit"}}' "${CONTAINER_NAME}")"
  echo "Adding the persistent Web UI mount to the current App container."
  replace_app "${current_image}" "${current_commit}"
}

# Build NanoHost and its Worker image, verify pinned images, and install service inputs.
build_nanohost() {
  echo "Building NanoHost from public origin/main."
  (
    cd "${REPO_DIR}/apps/nanohost"
    "${MISE_BIN}" exec rust@1.97.1 -- cargo build --release
  )

  worker_archive="${ARTIFACT_DIR}/worker-codex-${commit}.oci.tar"
  worker_archive_tmp="${worker_archive}.partial"
  sudo -n rm -f "${worker_archive_tmp}"
  echo "Building the Codex worker OCI archive from public origin/main."
  sudo -n docker buildx build \
    --file "${REPO_DIR}/containers/workers/Dockerfile" \
    --target worker-codex \
    --tag openkit/worker-codex:dev \
    --platform linux/arm64 \
    --provenance=false \
    --output "type=oci,dest=${worker_archive_tmp}" \
    "${REPO_DIR}"
  sudo -n chown "$(id -u):$(id -g)" "${worker_archive_tmp}"
  mv "${worker_archive_tmp}" "${worker_archive}"
  sudo -n docker load --input "${worker_archive}" >/dev/null
  sudo -n "${REPO_DIR}/scripts/docker/smoke-image.sh" worker-codex
  worker_digest="$(tar -xOf "${worker_archive}" index.json | jq -er 'if .schemaVersion == 2 and (.manifests | length) == 1 then .manifests[0].digest else empty end')"
  case "$(uname -m)" in
    aarch64 | arm64) supervisor_platform="linux/arm64" ;;
    x86_64 | amd64) supervisor_platform="linux/amd64" ;;
    *) echo "Unsupported NanoHost architecture." >&2; exit 1 ;;
  esac
  supervisor_digest="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["supervisor"]["platformDigests"][sys.argv[2]])' "${REPO_DIR}/apps/nanohost/openshell/release.json" "${supervisor_platform}")"
  if [[ ! "${worker_digest}" =~ ^sha256:[0-9a-f]{64}$ || ! "${supervisor_digest}" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    echo "Required NanoHost image digest resolution failed." >&2
    exit 1
  fi
  if ! sudo -n test -f "/var/lib/openkit/nanohost-images/content/${supervisor_digest#sha256:}"; then
    echo "Pinned OpenShell Supervisor archive is missing from the private Image Store." >&2
    exit 1
  fi
  seed_output="$(sudo -n python3 "${SEED_IMAGE_HELPER}" "${worker_archive}" "build:${commit}")"
  seeded_worker_digest="$(printf '%s\n' "${seed_output}" | sed -n 's/^seeded_digest=//p')"
  if [[ "${seeded_worker_digest}" != "${worker_digest}" ]]; then
    echo "Seeded worker image digest does not match the verified OCI index." >&2
    exit 1
  fi
  sudo -n install -D -m 0755 "${REPO_DIR}/apps/nanohost/target/release/nanohost" /usr/lib/openkit/nanohost
  sudo -n install -D -m 0644 "${REPO_DIR}/apps/nanohost/deploy/openkit-nanohost.service" /etc/systemd/system/openkit-nanohost.service
  # Image Store digests are not inputs accepted by the NanoHost session environment.
  if grep -q '^OPENKIT_NANOHOST_REQUIRED_IMAGE_DIGESTS=' "${NANOHOST_ENV_SOURCE}"; then
    sed '/^OPENKIT_NANOHOST_REQUIRED_IMAGE_DIGESTS=/d' "${NANOHOST_ENV_SOURCE}" >"${BASE_DIR}/nanohost.env.tmp"
    mv "${BASE_DIR}/nanohost.env.tmp" "${NANOHOST_ENV_SOURCE}"
  fi
  sudo -n install -m 600 -o root -g root "${NANOHOST_ENV_SOURCE}" /etc/openkit/nanohost.env
}

# Capture the current connection generation before stopping NanoHost.
stop_nanohost() {
  previous_generation="$(sudo -n python3 -c 'import sqlite3, sys; connection = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True); row = connection.execute("SELECT connection_generation FROM nanohost_runtime_targets LIMIT 1").fetchone(); print(row[0] if row else 0)' "${DATA_ROOT}/server/db/core.sqlite")"
  sudo -n systemctl stop openkit-nanohost.service
}

# Start NanoHost and await a new fenced, ready, fresh-empty generation.
start_nanohost() {
  sudo -n systemctl daemon-reload
  sudo -n systemctl add-wants multi-user.target openkit-nanohost.service >/dev/null
  sudo -n systemctl start openkit-nanohost.service
  for _attempt in $(seq 1 120); do
    runtime_state="$(sudo -n python3 -c 'import sqlite3, sys; connection = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True); row = connection.execute("SELECT connection_generation, predecessor_fenced, ready, fresh_empty FROM nanohost_runtime_targets LIMIT 1").fetchone(); print(":".join(map(str, row)) if row else "missing")' "${DATA_ROOT}/server/db/core.sqlite")"
    IFS=: read -r current_generation predecessor_fenced ready fresh_empty <<<"${runtime_state}"
    if [[ "${current_generation}" =~ ^[0-9]+$ ]] && (( current_generation > previous_generation )) && [[ "${predecessor_fenced}:${ready}:${fresh_empty}" == "1:1:1" ]] && systemctl is-active --quiet openkit-nanohost.service; then
      return
    fi
    sleep 1
  done
  sudo -n systemctl stop openkit-nanohost.service
  echo "NanoHost did not become ready." >&2
  exit 1
}

sudo -n docker info >/dev/null
update_source
sync_linked_repos

case "${TARGET}" in
  linked-repos)
    echo "Linked dogfood repositories match public origin/main."
    ;;
  web)
    build_web
    ensure_web_mount
    printf '%s\n' "${commit}" >"${BASE_DIR}/current-web"
    echo "Web UI is live from ${commit}."
    ;;
  nanocore)
    if [[ ! -e "${WEB_ROOT}/current" ]]; then
      bootstrap_image="$(sudo -n docker inspect --format '{{.Config.Image}}' "${CONTAINER_NAME}")"
      bootstrap_commit="$(sudo -n docker inspect --format '{{index .Config.Labels "org.openkit.staging.commit"}}' "${CONTAINER_NAME}")"
      commit="${bootstrap_commit}"
      publish_web_image "${bootstrap_image}"
      update_source
    fi
    build_app
    stop_nanohost
    replace_app "${image}" "${commit}"
    start_nanohost
    printf '%s\n' "${commit}" >"${BASE_DIR}/current-nanocore"
    echo "NanoCore is live from ${commit}."
    ;;
  nanohost)
    build_nanohost
    stop_nanohost
    start_nanohost
    printf '%s\n' "${commit}" >"${BASE_DIR}/current-nanohost"
    echo "NanoHost is live from ${commit}."
    ;;
  all)
    build_full_app
    build_nanohost
    stop_nanohost
    replace_app "${image}" "${commit}"
    start_nanohost
    printf '%s\n' "${commit}" >"${BASE_DIR}/current"
    echo "OpenKit staging is healthy on 127.0.0.1:${HOST_PORT}."
    echo "commit=${commit}"
    ;;
esac
