#!/usr/bin/env bash
set -euo pipefail

openkit-worker-common-smoke
test "$(PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 pi --version)" = "0.80.7"
test "$(id -u)" -ne 0
test "$(command -v pi)" = "/usr/local/bin/pi"
test "$(readlink -f "$(command -v pi)")" = "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"
test "$(head -n 1 "$(readlink -f "$(command -v pi)")")" = "#!/usr/bin/env node"
command -v openkit-worker-shim >/dev/null
! command -v codex >/dev/null
! command -v opencode >/dev/null
test -d /openkit/sessions
test -d /openkit/session
test -d /openkit/artifacts

pi_help="$(PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 pi --help)"
for flag in \
  --mode \
  --no-approve \
  --no-session \
  --no-extensions \
  --no-skills \
  --no-prompt-templates \
  --no-themes \
  --no-context-files \
  --offline \
  --provider \
  --model; do
  grep -Fq -- "${flag}" <<<"${pi_help}"
done
grep -Fq -- "json" <<<"${pi_help}"

pi_root="$(mktemp -d)"
shim_package="$(mktemp)"
trap 'rm -rf "${pi_root}"; rm -f "${shim_package}"' EXIT
model_list="$(
  ANTHROPIC_API_KEY=smoke \
    PI_CODING_AGENT_DIR="${pi_root}" \
    PI_SKIP_VERSION_CHECK=1 \
    PI_TELEMETRY=0 \
    pi --offline --list-models claude-sonnet-4-5
)"
grep -Eq 'anthropic([/[:space:]]+)claude-sonnet-4-5([[:space:]]|$)' <<<"${model_list}"

printf '%s\n' '{"schemaVersion":3,"control":{"protocol":"openkit-worker-control-v1","mode":"sandbox-integration","bindings":{"workerControl":{"pathPrefix":"/worker-control/","tokenRef":"runtime://openkit/worker-control-token"},"inference":{"pathPrefix":"/inference/","tokenRef":"runtime://openkit/inference-token"},"capabilities":{"pathPrefix":"/capabilities/","tokenRef":"runtime://openkit/capability-token"}},"adapter":{"kind":"openkit-worker-shim","targetRuntime":"pi"}},"runtime":{"image":{"kind":"reference","ref":"openkit-worker-pi:smoke","pullPolicy":"if-not-present"},"command":{"argv":["openkit-worker-shim"],"workingDirectory":"/workspace"}},"extensions":{"openkit":{"turnInput":"Image smoke dry run."}},"credentials":{"declarations":[{"targetEnvVarName":"ANTHROPIC_API_KEY","visibility":"runtime-env"}]},"llm":{"mode":"gateway","routes":[{"credentialVisibility":"environment","endpoint":{"kind":"provider-compatible","upstream":{"kind":"direct-provider"}},"id":"worker-inference","model":"claude-sonnet-4-5","providerInstanceId":"anthropic"}]}}' >"${shim_package}"
ANTHROPIC_API_KEY=smoke SHIM_PACKAGE="${shim_package}" node --input-type=module -e "const { runWorkerShimCli } = await import('/usr/local/lib/openkit/worker-shim/dist/index.js'); await runWorkerShimCli(['--package', process.env.SHIM_PACKAGE, '--dry-run']);"

echo "OpenKit Pi worker image smoke OK"
