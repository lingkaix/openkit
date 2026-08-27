#!/usr/bin/env bash
set -euo pipefail

print_required_version() {
  local name="$1"
  shift

  printf '%s: ' "$name"
  "$@"
}

# Every tool checked here is one a repository gate executes, and none is
# optional: an absent tool is a broken test execution environment rather than a
# degraded convenience. A tool that no gate runs does not belong in the image
# and therefore does not belong in this smoke. rustc/cargo/clippy/rustfmt are
# required for NanoHost Cargo gates inside the image.
print_required_version "node" node --version
print_required_version "pnpm" pnpm --version
print_required_version "git" git --version
print_required_version "rustc" rustc --version
print_required_version "cargo" cargo --version
print_required_version "clippy" cargo clippy --version
print_required_version "rustfmt" rustfmt --version

if command -v Xvfb >/dev/null 2>&1; then
  echo "Xvfb must not be installed in the test execution image" >&2
  exit 1
fi

printf 'chromium-headless-shell: '
headless_shell_install="$(
  find "${PLAYWRIGHT_BROWSERS_PATH}" -maxdepth 1 -name 'chromium_headless_shell-*' -print -quit
)"
if [[ -z "${headless_shell_install}" ]]; then
  echo "missing under ${PLAYWRIGHT_BROWSERS_PATH}" >&2
  exit 1
fi
basename "${headless_shell_install}"

echo "OpenKit test-env image smoke OK"
