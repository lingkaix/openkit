#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -gt 0 ]]; then
  exec "$@"
fi

if [[ -n "${PORT:-}" && -n "${OPENKIT_HTTP_PORT:-}" && "${PORT}" != "${OPENKIT_HTTP_PORT}" ]]; then
  echo "PORT and OPENKIT_HTTP_PORT must match when both are set." >&2
  exit 1
fi

export CADDY_HTTP_PORT="${CADDY_HTTP_PORT:-8080}"
export OPENKIT_HTTP_PORT="${OPENKIT_HTTP_PORT:-${PORT:-4317}}"
export PORT="${OPENKIT_HTTP_PORT}"
export OPENKIT_CORE_MODE="${OPENKIT_CORE_MODE:-local}"
export OPENKIT_BIND_HOST="${OPENKIT_BIND_HOST:-127.0.0.1}"
export OPENKIT_DATA_ROOT="${OPENKIT_DATA_ROOT:-/data/openkit}"

nanocore_pid=""
caddy_pid=""

stop_nanocore() {
  if [[ -n "${nanocore_pid}" ]] && kill -0 "${nanocore_pid}" >/dev/null 2>&1; then
    kill "${nanocore_pid}" >/dev/null 2>&1 || true
    wait "${nanocore_pid}" || true
  fi
}

stop_processes() {
  if [[ -n "${caddy_pid}" ]] && kill -0 "${caddy_pid}" >/dev/null 2>&1; then
    kill "${caddy_pid}" >/dev/null 2>&1 || true
    wait "${caddy_pid}" || true
  fi
  stop_nanocore
}

trap stop_processes EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

mkdir -p "${OPENKIT_DATA_ROOT}"

node /app/nanocore/dist/index.js &
nanocore_pid="$!"

for attempt in $(seq 1 120); do
  if curl -fsS "http://127.0.0.1:${OPENKIT_HTTP_PORT}/api/health" >/dev/null; then
    break
  fi

  if ! kill -0 "${nanocore_pid}" >/dev/null 2>&1; then
    wait "${nanocore_pid}"
  fi

  if [[ "${attempt}" -eq 120 ]]; then
    echo "NanoCore did not become ready on 127.0.0.1:${OPENKIT_HTTP_PORT} within 120 seconds." >&2
    exit 1
  fi

  sleep 1
done

caddy run --config /etc/caddy/Caddyfile --adapter caddyfile &
caddy_pid="$!"
wait "${caddy_pid}"
