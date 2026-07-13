#!/usr/bin/env bash
set -euo pipefail

print_required_version() {
  local name="$1"
  shift

  printf '%s: ' "$name"
  "$@"
}

print_required_version "node" node --version
print_required_version "codex" codex --version
command -v openkit-codex-shim >/dev/null
test -d /openkit/session
test -d /openkit/artifacts
echo "OpenKit Codex worker image smoke OK"
