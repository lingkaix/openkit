#!/usr/bin/env bash
set -euo pipefail

print_required_version() {
  local name="$1"
  shift

  printf '%s: ' "$name"
  "$@"
}

print_optional_version() {
  local name="$1"
  local command_name="$2"
  shift 2

  printf '%s: ' "$name"

  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'not-installed\n'
    return 0
  fi

  if ! "$command_name" "$@"; then
    printf 'version-unavailable\n'
  fi
}

print_required_version "node" node --version
print_required_version "pnpm" pnpm --version
print_optional_version "caddy" caddy version
print_optional_version "codex" codex --version
print_optional_version "opencode" opencode --version
echo "OpenKit dev-e2e image smoke OK"
