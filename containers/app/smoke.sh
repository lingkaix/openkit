#!/usr/bin/env bash
set -euo pipefail

print_required_version() {
  local name="$1"
  shift

  printf '%s: ' "$name"
  "$@"
}

print_required_version "node" node --version
print_required_version "pnpm" pnpm --version
print_required_version "caddy" caddy version
test -x /usr/local/bin/openkit-operator
test -x /usr/local/bin/openkit-restore
openkit-restore --help
if openkit-restore; then
  echo "openkit-restore with no arguments must fail" >&2
  exit 1
fi

# Exercise the production dependency tree through the ordinary entrypoint and public route.
smoke_root="$(mktemp -d /tmp/openkit-app-smoke.XXXXXX)"
app_pid=""
cleanup() {
  if [[ -n "${app_pid}" ]]; then
    kill "${app_pid}" >/dev/null 2>&1 || true
    wait "${app_pid}" || true
  fi
  rm -rf "${smoke_root}"
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

mkdir -p "${smoke_root}/data/config"
printf '%s\n' '{"schemaVersion":1,"mode":"local"}' >"${smoke_root}/data/config/server.jsonc"
OPENKIT_DATA_ROOT="${smoke_root}/data" /usr/local/bin/openkit-app-entrypoint >"${smoke_root}/startup.log" 2>&1 &
app_pid="$!"

ready=0
startup_deadline=$((SECONDS + 60))
while ((SECONDS < startup_deadline)); do
  if curl -fsS --max-time 1 "http://127.0.0.1:${CADDY_HTTP_PORT:-8080}/api/health" >"${smoke_root}/health.json" 2>/dev/null; then
    ready=1
    break
  fi
  if ! kill -0 "${app_pid}" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
if [[ "${ready}" -ne 1 ]]; then
  cat "${smoke_root}/startup.log" >&2
  echo "App server did not reach /api/health within 60 seconds." >&2
  exit 1
fi
cat "${smoke_root}/health.json"
curl -fsS --max-time 5 "http://127.0.0.1:${CADDY_HTTP_PORT:-8080}/" >/dev/null
echo "OpenKit app image smoke OK"
