#!/usr/bin/env bash
set -euo pipefail

node --version >/dev/null
test "$(PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 pi --version)" = "0.80.7"
test "$(id -u)" -ne 0
test "$(command -v pi)" = "/usr/local/bin/pi"
test "$(readlink -f "$(command -v pi)")" = "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"
test "$(head -n 1 "$(readlink -f "$(command -v pi)")")" = "#!/usr/bin/env node"
command -v openkit-worker-shim >/dev/null
! command -v codex >/dev/null
! command -v opencode >/dev/null
test -d /openkit/config
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

printf '%s\n' '{"control":{"mode":"direct-nanocore","adapter":{"kind":"openkit-worker-shim","targetRuntime":"pi"}},"runtime":{"command":{"argv":["openkit-worker-shim","--package","/openkit/config/package.json"],"workingDirectory":"/workspace"}},"extensions":{"openkit":{"turnInput":"Image smoke dry run."}},"llm":{"routes":[{"credentialVisibility":"environment","endpoint":{"kind":"provider-compatible","upstream":{"kind":"direct-provider","baseUrlRef":"provider://anthropic"}},"id":"worker-inference","model":"claude-sonnet-4-5","providerInstanceId":"anthropic"}]},"credentials":{"declarations":[{"id":"anthropic","vaultGrantId":"image-smoke","visibility":"runtime-env","targetEnvVarName":"ANTHROPIC_API_KEY"}]}}' >"${shim_package}"
ANTHROPIC_API_KEY=image-smoke \
  openkit-worker-shim --package "${shim_package}" --dry-run

echo "OpenKit Pi worker image smoke OK"
