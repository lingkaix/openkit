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
test -x /usr/bin/setsid
test -x /usr/bin/setpriv
echo "OpenKit app image smoke OK"
