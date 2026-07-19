#!/usr/bin/env bash
set -euo pipefail

node --version >/dev/null
test "$(codex --version)" = "codex-cli 0.144.1"
test "$(id -u)" -ne 0
test "$(command -v codex)" = "/usr/local/bin/codex"
test "$(readlink -f "$(command -v codex)")" = "/usr/local/lib/codex/bin/codex"
test "$(/usr/local/lib/codex/bin/codex --version)" = "codex-cli 0.144.1"
command -v openkit-worker-shim >/dev/null
! command -v opencode >/dev/null
! command -v pi >/dev/null
test -d /openkit/config
test -d /openkit/session
test -d /openkit/artifacts

codex_help="$(codex exec --help)"
for flag in \
  --json \
  --ignore-user-config \
  --ignore-rules \
  --strict-config \
  --ephemeral \
  --output-last-message \
  --cd \
  --model \
  --dangerously-bypass-approvals-and-sandbox; do
  grep -Fq -- "${flag}" <<<"${codex_help}"
done

shim_package="$(mktemp)"
trap 'rm -f "${shim_package}"' EXIT
printf '%s\n' '{"control":{"mode":"direct-nanocore","adapter":{"kind":"openkit-worker-shim","targetRuntime":"codex"}},"runtime":{"command":{"argv":["openkit-worker-shim","--package","/openkit/config/package.json"],"workingDirectory":"/workspace"}},"extensions":{"openkit":{"turnInput":"Image smoke dry run."}},"llm":{"routes":[{"credentialVisibility":"placeholder","endpoint":{"kind":"openai-compatible","workerBaseUrl":"https://nanocore.invalid/api/worker-inference/v1","upstream":{"kind":"nanocore-gateway","baseUrlRef":"runtime://nanocore/worker-inference/v1"}},"id":"worker-inference","model":"gpt-5","providerInstanceId":"image-smoke"}]}}' >"${shim_package}"
OPENKIT_WORKER_INFERENCE_TOKEN=image-smoke \
  openkit-worker-shim --package "${shim_package}" --dry-run

echo "OpenKit Codex worker image smoke OK"
