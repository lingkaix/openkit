#!/usr/bin/env bash
set -u

script_root=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source "$script_root/ssh-alias.sh"

# Removes fixture-owned attempt state idempotently.
fixture_teardown() {
  local root=${OPENKIT_HOST_FIXTURE_ROOT:?fixture root is required}
  rm -rf -- "$root/product-state"
  [[ ! -e "$root/product-state" ]]
}

# Requests authenticated NanoHost decommission without exposing its credential.
admin_decommission() {
  local url=$1 token=$2
  local http2_arg=
  [[ "$url" == http://* ]] && http2_arg=--http2-prior-knowledge
  printf 'header = "authorization: Bearer %s"\nheader = "content-type: application/json"\n' "$token" |
    curl --config - ${http2_arg} --fail --silent --show-error --request POST \
      --url "${url%/}/api/app/nanohost/decommission" --data '{}'
}

if [[ $# -eq 1 && $1 == fixture && -n ${OPENKIT_HOST_FIXTURE_ROOT:-} ]]; then
  fixture_teardown
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

stop_status=0
decommission_status=0
active_status=1
ssh "$ssh_alias" /usr/bin/sudo -n /usr/bin/systemctl stop openkit-nanohost.service || stop_status=$?
admin_decommission "$validatedOrigin" "$adminToken" >/dev/null || decommission_status=$?
ssh "$ssh_alias" /usr/bin/sudo -n /usr/bin/systemctl is-active --quiet openkit-nanohost.service
active_status=$?

if [[ "$stop_status" -ne 0 ]]; then
  printf 'NanoHost service stop failed.\n' >&2
  exit 21
fi
if [[ "$decommission_status" -ne 0 ]]; then
  printf 'NanoHost decommission failed.\n' >&2
  exit 22
fi
if [[ "$active_status" -eq 0 ]]; then
  printf 'NanoHost service remains active after stop.\n' >&2
  exit 23
fi
