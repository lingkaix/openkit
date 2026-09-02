#!/usr/bin/env bash
set -euo pipefail

script_root=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source "$script_root/ssh-alias.sh"
cleanup_armed=0

# Runs the attempt teardown once while preserving the triggering exit status.
cleanup() {
  local observed=$?
  trap - EXIT HUP INT TERM
  if [[ "$cleanup_armed" == 1 ]] && ! bash "$script_root/teardown.sh" "$ssh_alias"; then exit 98; fi
  exit "$observed"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM

if [[ $# -eq 1 && $1 == fixture && -n ${OPENKIT_HOST_FIXTURE_ROOT:-} ]]; then
  ssh_alias=fixture
  fixture_root=${OPENKIT_HOST_FIXTURE_ROOT:?fixture root is required}
  mkdir -p "$fixture_root/product-state"
  cleanup_armed=1
  if [[ ${OPENKIT_HOST_FIXTURE_READINESS_EXIT:?fixture readiness exit is required} == 0 ]]; then
    printf 'authenticated configured current-generation readiness observed\n'
  else
    exit 1
  fi
  exit 0
fi

require_ssh_alias "$@" || exit $?
nanoCoreUrl=${OPENKIT_HOST_NANOCORE_URL:?NanoCore URL is required}
validatedOrigin=$(OPENKIT_HOST_ORIGIN="$nanoCoreUrl" node -e '
  try {
    const input = process.env.OPENKIT_HOST_ORIGIN;
    const url = new URL(input);
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (url.origin !== input || url.username || url.password || url.pathname !== "/" || url.search || url.hash) process.exit(1);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) process.exit(1);
    process.stdout.write(url.origin);
  } catch { process.exit(1); }
') || { printf 'NanoCore URL must be an exact HTTPS or loopback HTTP origin.\n' >&2; exit 65; }
adminToken=${OPENKIT_HOST_SERVER_ADMIN_TOKEN:?server-admin token is required}
identityId=${OPENKIT_HOST_NANOHOST_IDENTITY_ID:?NanoHost identity is required}
deploymentId=${OPENKIT_HOST_NANOHOST_DEPLOYMENT_ID:?NanoHost deployment is required}

cleanup_armed=1
asserted_manifest=$(bash "$script_root/assert.sh" "$ssh_alias")
expected_manifest=$(node -e '
  const { createHash } = require("node:crypto");
  const { readFileSync } = require("node:fs");
  process.stdout.write(`manifestDigest=${createHash("sha256").update(readFileSync(process.argv[1])).digest("hex")}`);
' "$script_root/../../../apps/nanohost/deploy/host-manifest.json")
[[ "$asserted_manifest" == "$expected_manifest" ]] || exit 66
ssh "$ssh_alias" /usr/bin/sudo -n /usr/bin/systemctl start openkit-nanohost.service

# Reads the authenticated configured RuntimeTarget projection.
read_runtime_target() {
  local http2_arg=
  [[ "$validatedOrigin" == http://* ]] && http2_arg=--http2-prior-knowledge
  printf 'header = "authorization: Bearer %s"\n' "$adminToken" |
    curl --config - ${http2_arg} --connect-timeout 5 --max-time 5 --fail --silent --show-error \
      --url "$validatedOrigin/api/app/nanohost/runtime-target"
}

for _ in {1..90}; do
  readiness_status=0
  response=$(read_runtime_target 2>/dev/null) || readiness_status=$?
  if [[ "$readiness_status" == 28 ]]; then break; fi
  if [[ "$readiness_status" == 0 ]] &&
    OPENKIT_HOST_EXPECTED_IDENTITY="$identityId" \
      OPENKIT_HOST_EXPECTED_DEPLOYMENT="$deploymentId" \
      node -e '
        const fs = require("node:fs");
        const value = JSON.parse(fs.readFileSync(0, "utf8"));
        const keys = Object.keys(value).sort().join(",");
        if (keys !== "connectionGeneration,deploymentId,freshEmpty,identityId,observedAt,predecessorFenced,ready") process.exit(1);
        if (value.identityId !== process.env.OPENKIT_HOST_EXPECTED_IDENTITY) process.exit(1);
        if (value.deploymentId !== process.env.OPENKIT_HOST_EXPECTED_DEPLOYMENT) process.exit(1);
        if (!Number.isInteger(value.connectionGeneration) || value.connectionGeneration < 1) process.exit(1);
        if (value.predecessorFenced !== true || value.ready !== true || value.freshEmpty !== true) process.exit(1);
        if (typeof value.observedAt !== "string" || Number.isNaN(Date.parse(value.observedAt))) process.exit(1);
      ' <<<"$response"; then
    printf 'authenticated configured current-generation readiness observed\n'
    exit 0
  fi
  sleep 1
done

printf 'Authenticated configured current-generation readiness was not observed.\n' >&2
exit 1
