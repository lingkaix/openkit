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
echo "OpenKit app image smoke OK"
