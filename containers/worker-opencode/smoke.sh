#!/usr/bin/env bash
set -euo pipefail

node --version >/dev/null
test "$(id -u)" -ne 0
test "$(command -v opencode)" = "/usr/local/bin/opencode"
test "$(readlink -f "$(command -v opencode)")" = "/usr/local/lib/node_modules/opencode-ai/bin/opencode.exe"
command -v openkit-worker-shim >/dev/null
! command -v codex >/dev/null
! command -v pi >/dev/null
test ! -e /etc/opencode
test ! -e "${HOME}/.config/opencode"
test -z "${OPENCODE_CONFIG:-}"
test -z "${OPENCODE_CONFIG_CONTENT:-}"
test -d /openkit/config
test -d /openkit/session
test -d /openkit/artifacts
test "$(opencode --version)" = "1.18.1"
test "$(/usr/local/lib/node_modules/opencode-ai/bin/opencode.exe --version)" = "1.18.1"

opencode_help="$(opencode run --help 2>&1)"
for flag in --format --dir --model; do
  grep -Fq -- "${flag}" <<<"${opencode_help}"
done
grep -Fq -- "json" <<<"${opencode_help}"

shim_package="$(mktemp)"
trap 'rm -f "${shim_package}"' EXIT
printf '%s\n' '{"control":{"mode":"direct-nanocore","adapter":{"kind":"openkit-worker-shim","targetRuntime":"opencode"}},"runtime":{"command":{"argv":["openkit-worker-shim","--package","/openkit/config/package.json"],"workingDirectory":"/workspace"}},"extensions":{"openkit":{"turnInput":"Image smoke dry run."}},"llm":{"routes":[{"credentialVisibility":"placeholder","endpoint":{"kind":"openai-compatible","workerBaseUrl":"https://nanocore.invalid/api/worker-inference/v1","upstream":{"kind":"nanocore-gateway","baseUrlRef":"runtime://nanocore/worker-inference/v1"}},"id":"worker-inference","model":"gpt-5","providerInstanceId":"image-smoke"}]}}' >"${shim_package}"
OPENKIT_WORKER_INFERENCE_TOKEN=image-smoke \
  openkit-worker-shim --package "${shim_package}" --dry-run

echo "OpenKit OpenCode worker image smoke OK"
