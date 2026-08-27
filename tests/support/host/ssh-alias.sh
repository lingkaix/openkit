# Validates the sole explicit SSH alias argument and exposes it to the caller.
require_ssh_alias() {
  if [[ $# -ne 1 || ! ${1:-} =~ ^[a-z][a-z0-9-]{0,62}$ ]]; then
    printf 'Usage: %s <ssh-alias>\n' "$0" >&2
    return 64
  fi
  ssh_alias=$1
}
