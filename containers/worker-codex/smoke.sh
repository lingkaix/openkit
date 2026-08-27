#!/usr/bin/env bash
set -euo pipefail

openkit-worker-common-smoke
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
printf '%s\n' '{"schemaVersion":3,"control":{"protocol":"openkit-worker-control-v1","mode":"sandbox-integration","bindings":{"workerControl":{"pathPrefix":"/worker-control/","tokenRef":"runtime://openkit/worker-control-token"},"inference":{"pathPrefix":"/inference/","tokenRef":"runtime://openkit/inference-token"},"capabilities":{"pathPrefix":"/capabilities/","tokenRef":"runtime://openkit/capability-token"}},"adapter":{"kind":"openkit-worker-shim","targetRuntime":"codex"}},"runtime":{"image":{"kind":"reference","ref":"openkit-worker-codex:smoke","pullPolicy":"if-not-present"},"command":{"argv":["openkit-worker-shim","--package","/openkit/config/package.json"],"workingDirectory":"/workspace"}},"extensions":{"openkit":{"turnInput":"Image smoke dry run."}},"llm":{"mode":"gateway","routes":[{"credentialVisibility":"placeholder","endpoint":{"kind":"openai-compatible","upstream":{"kind":"nanocore-gateway"}},"id":"worker-inference","model":"gpt-5","providerInstanceId":"image-smoke"}]}}' >"${shim_package}"
printf '%s\n%s\n' \
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' \
  'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' | \
  openkit-worker-shim --package "${shim_package}" --dry-run

echo "OpenKit Codex worker image smoke OK"
