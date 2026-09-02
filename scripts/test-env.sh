#!/usr/bin/env bash
#
# Places one repository check in the environment that owns it.
#
#   scripts/test-env.sh any <command> [args...]
#     Runs directly in the current permitted environment. Set OPENKIT_TEST_USE_IMAGE=1 on a host for an explicit image second opinion.
#
#   scripts/test-env.sh host <command> [args...]
#     Runs the command on the host and refuses to run inside the image. Reserved for commands that require host-only Docker, real-runtime access, or the isolated fixed-path installer gate.
#
# Owned by the Test Execution Environment decision in docs/toolchain.md.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CONTAINER_REPO_ROOT="/workspace"
TEST_IMAGE_BUILD_INPUT_DIGEST_LABEL="org.openkit.test-env.build-input-digest"
TEST_IMAGE_BUILD_INPUT_DIGEST_PATH="/etc/openkit-test-env-build-input-digest"

PLACEMENT="${1:-}"
shift || true

if [[ -z "${PLACEMENT}" || $# -eq 0 ]]; then
  echo "Usage: scripts/test-env.sh <any|host> <command> [args...]" >&2
  exit 2
fi

inside_test_image() {
  [[ "${OPENKIT_TEST_EXECUTOR:-}" == "1" && -f /etc/openkit-test-env ]]
}

run_host_placement() {
  if inside_test_image; then
    cat >&2 <<'MESSAGE'
This command requires host-only Docker, real-runtime access, or the isolated fixed-path installer gate and must run on the host, not inside the test-env test execution image. Run it from a host shell.
MESSAGE
    exit 2
  fi
  export OPENKIT_TEST_ENVIRONMENT=host
  exec "$@"
}

run_inside_test_image() {
  local actual_build_input_digest expected_build_input_digest
  expected_build_input_digest="$(node scripts/docker/test-image-tag.mjs --digest)"
  actual_build_input_digest="$(
    if [[ -f "${TEST_IMAGE_BUILD_INPUT_DIGEST_PATH}" ]]; then
      cat "${TEST_IMAGE_BUILD_INPUT_DIGEST_PATH}"
    fi
  )"
  if [[ "${actual_build_input_digest}" != "${expected_build_input_digest}" ]]; then
    echo "Test execution image build-input digest does not match the mounted repository." >&2
    exit 2
  fi

  export PATH="${CONTAINER_REPO_ROOT}/node_modules/.bin:${PATH}"
  export OPENKIT_TEST_ENVIRONMENT=image
  if [[ "${OPENKIT_TEST_ENV_AUTO_INSTALL:-}" == "1" ]]; then
    pnpm install --frozen-lockfile --prefer-offline
  fi
  exec "$@"
}

require_docker() {
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    return 0
  fi
  cat >&2 <<'MESSAGE'
Docker is required: repository checks run inside the test-env image so that their capability set can be compared with containers/test-env/Dockerfile.

Start Docker or omit OPENKIT_TEST_USE_IMAGE for the primary host execution.
See the Test Execution Environment decision in docs/toolchain.md.
MESSAGE
  exit 2
}

# Isolates volume names per checkout so that two working copies of this repository never share an installed dependency tree.
workspace_id() {
  node -e 'process.stdout.write(require("node:crypto").createHash("sha256").update(process.argv[1]).digest("hex").slice(0, 12))' "${REPO_ROOT}"
}

run_image_second_opinion() {
  require_docker
  cd "${REPO_ROOT}"

  local actual_build_input_digest expected_build_input_digest image_tag volume_prefix
  image_tag="$(node scripts/docker/test-image-tag.mjs)"
  expected_build_input_digest="$(node scripts/docker/test-image-tag.mjs --digest)"
  volume_prefix="openkit-test-env-$(workspace_id)"
  actual_build_input_digest="$(
    docker image inspect \
      --format "{{ index .Config.Labels \"${TEST_IMAGE_BUILD_INPUT_DIGEST_LABEL}\" }}" \
      "${image_tag}" 2>/dev/null || true
  )"

  if [[ "${actual_build_input_digest}" != "${expected_build_input_digest}" ]]; then
    echo "Building test execution image ${image_tag}..." >&2
    bash scripts/docker/build-image.sh test-env "${image_tag}"
    actual_build_input_digest="$(
      docker image inspect \
        --format "{{ index .Config.Labels \"${TEST_IMAGE_BUILD_INPUT_DIGEST_LABEL}\" }}" \
        "${image_tag}" 2>/dev/null || true
    )"
  fi

  if [[ "${actual_build_input_digest}" != "${expected_build_input_digest}" ]]; then
    echo "Test execution image ${image_tag} has an invalid build-input digest label." >&2
    exit 2
  fi

  local docker_args=(
    run --rm --init
    --workdir "${CONTAINER_REPO_ROOT}"
    --volume "${REPO_ROOT}:${CONTAINER_REPO_ROOT}"
    --volume "${volume_prefix}-pnpm-store:/pnpm/store"
    --volume "${volume_prefix}-turbo:${CONTAINER_REPO_ROOT}/.turbo"
    --env OPENKIT_TEST_EXECUTOR=1
    --env OPENKIT_TEST_ENV_AUTO_INSTALL=1
    --env "CI=${CI:-}"
  )

  # Dependency trees stay in named volumes. A bind-mounted node_modules would hand the container the host platform's native builds, and better-sqlite3 and esbuild are compiled per platform.
  local manifest relative_package volume_suffix
  for manifest in \
    "${REPO_ROOT}/package.json" \
    "${REPO_ROOT}"/apps/*/package.json \
    "${REPO_ROOT}"/packages/*/package.json; do
    [[ -f "${manifest}" ]] || continue
    relative_package="$(dirname "${manifest#"${REPO_ROOT}/"}")"
    if [[ "${relative_package}" == "." ]]; then
      docker_args+=(--volume "${volume_prefix}-node-modules-root:${CONTAINER_REPO_ROOT}/node_modules")
      continue
    fi
    volume_suffix="${relative_package//\//-}"
    docker_args+=(
      --volume "${volume_prefix}-node-modules-${volume_suffix}:${CONTAINER_REPO_ROOT}/${relative_package}/node_modules"
    )
  done

  if [[ -t 0 && -t 1 ]]; then
    docker_args+=(--tty --interactive)
  fi

  exec docker "${docker_args[@]}" "${image_tag}" \
    bash scripts/test-env.sh any "$@"
}

case "${PLACEMENT}" in
  any)
    if inside_test_image; then
      run_inside_test_image "$@"
    elif [[ "${OPENKIT_TEST_USE_IMAGE:-}" == "1" ]]; then
      run_image_second_opinion "$@"
    else
      export OPENKIT_TEST_ENVIRONMENT=host
      exec "$@"
    fi
    ;;
  host) run_host_placement "$@" ;;
  *)
    echo "Unknown placement \"${PLACEMENT}\": expected \"any\" or \"host\"." >&2
    exit 2
    ;;
esac
