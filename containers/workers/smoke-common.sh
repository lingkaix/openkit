#!/usr/bin/env bash
set -euo pipefail

command -v bash >/dev/null
command -v curl >/dev/null
command -v dig >/dev/null
command -v fd >/dev/null
command -v file >/dev/null
command -v gh >/dev/null
command -v git >/dev/null
command -v ip >/dev/null
command -v jq >/dev/null
command -v lsof >/dev/null
command -v mise >/dev/null
command -v nano >/dev/null
command -v nc >/dev/null
command -v netstat >/dev/null
test -x /usr/sbin/nft
command -v node >/dev/null
command -v npm >/dev/null
command -v nslookup >/dev/null
command -v npx >/dev/null
command -v ping >/dev/null
command -v pip >/dev/null
command -v pip3 >/dev/null
command -v pkg-config >/dev/null
command -v pnpm >/dev/null
command -v pnpx >/dev/null
command -v python >/dev/null
command -v python3 >/dev/null
command -v rg >/dev/null
command -v ssh >/dev/null
command -v ss >/dev/null
command -v tar >/dev/null
command -v traceroute >/dev/null
command -v unzip >/dev/null
command -v uv >/dev/null
command -v uvx >/dev/null
command -v vim >/dev/null

test "$(node --version)" = "v24.18.0"
test "$(pnpm --version)" = "10.33.3"
test "$(python --version)" = "Python 3.14.6"
test "$(python3 --version)" = "Python 3.14.6"
uv --version | grep -Eq '^uv 0[.]11[.]30([[:space:]]|$)'
gh --version | grep -Fq 'gh version 2.96.0'
mise --version | grep -Fq '2026.8.14'
test "$(stat -c '%u' /usr/local/bin/mise)" -eq 0
test ! -w /usr/local/bin/mise
pip --version >/dev/null
npm --version >/dev/null
git --version >/dev/null

test "$(id -u)" -ne 0
test "$(command -v python)" = "/sandbox/.venv/bin/python"
test "$(command -v pip)" = "/sandbox/.venv/bin/pip"
test ! -e /etc/openshell/policy.yaml
test ! -w /opt/uv/python
test ! -w /usr/local/lib/openkit/worker-shim

for path in \
  /sandbox \
  /sandbox/.cache \
  /sandbox/.config \
  /sandbox/.local \
  /sandbox/.npm \
  /sandbox/.venv \
  /workspace/worktrees/main \
  /workspace/inputs \
  /workspace/data \
  /workspace/artifacts/in \
  /workspace/outputs \
  /workspace/scratch \
  /workspace/.openkit/cache \
  /openkit/sessions \
  /openkit/session \
  /openkit/instructions; do
  test -d "${path}"
  test -w "${path}"
done

command -v openkit-worker-shim >/dev/null
bash -n /usr/local/bin/openkit-worker-shim
if openkit-worker-shim --help >/dev/null 2>&1; then
  echo "Worker Harness accepted a bootstrap argument." >&2
  exit 1
fi
test -x /usr/local/bin/openkit-file-effect
node --input-type=module -e "import('/usr/local/lib/openkit/worker-shim/dist/index.js').then(({ SANDBOX_INTEGRATION_TARGET }) => { if (!/^127[.]0[.]0[.]1:[1-9][0-9]*$/.test(SANDBOX_INTEGRATION_TARGET)) process.exit(1); })"

empty_context_path='image-smoke/context/openkit-file-effect-smoke-empty'
empty_context_digest='sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
mkdir -p /openkit/sessions/image-smoke/context
trap 'rm -rf /openkit/sessions/image-smoke' EXIT
test "$(printf '' | openkit-file-effect reference.import --slot context --path "${empty_context_path}" --length 0 --sha256 "${empty_context_digest}")" = "${empty_context_digest} 0"
test -f "/openkit/sessions/${empty_context_path}"
test "$(stat -c '%a' "/openkit/sessions/${empty_context_path}")" = '600'
test ! -s "/openkit/sessions/${empty_context_path}"
test -z "$(find /openkit/sessions/image-smoke/context -maxdepth 1 -name '.openkit-file-effect-*.partial' -print -quit)"

if find /sandbox /workspace -xdev -uid 0 -print -quit | grep -q .; then
  echo "Writable worker paths contain root-owned build state." >&2
  exit 1
fi
