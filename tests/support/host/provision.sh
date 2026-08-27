#!/usr/bin/env bash
set -euo pipefail

node_relative='.local/share/mise/installs/node/24.18.0/bin/node'
node_digest='6bf69d0eda41a12030d5f28d958cd09ce323bc0c13f1ab4d8bb426933aa08812'

provision_node() {
  local source_path=$1 target_path=$2 expected_version=$3 observed_digest=$4 observed_version=$5
  [[ -x "$source_path" ]] || { printf 'Node source is not executable.\n' >&2; return 1; }
  [[ "$observed_digest" == "$node_digest" ]] || { printf 'Node source digest mismatch.\n' >&2; return 1; }
  [[ "$observed_version" == "$expected_version" ]] || { printf 'Node source version mismatch.\n' >&2; return 1; }
  if [[ -L "$target_path" ]]; then
    if [[ "$mode" == fixture && "$(readlink "$target_path")" == "$source_path" ]]; then return 0; fi
    if [[ "$mode" != fixture && "$(readlink -f "$target_path")" == "$source_path" ]]; then return 0; fi
  fi
  [[ ! -e "$target_path" && ! -L "$target_path" ]] || { printf 'Node target already exists.\n' >&2; return 1; }
  if [[ "$mode" == fixture ]]; then
    mkdir -p "$(dirname "$target_path")"
    ln -s "$source_path" "$target_path"
  else
    /usr/bin/sudo -n /usr/bin/ln -s "$source_path" "$target_path"
  fi
}

if [[ $# -eq 1 && $1 == fixture && -n ${OPENKIT_HOST_FIXTURE_ROOT:-} ]]; then
  mode=fixture
  fixture_root=${OPENKIT_HOST_FIXTURE_ROOT:?fixture root is required}
  manifest_path=${OPENKIT_HOST_MANIFEST:?fixture manifest is required}
  node_target=$(node -e 'const m=require(process.argv[1]); process.stdout.write(m.commands.node.path)' "$manifest_path")
  node_version=$(node -e 'const m=require(process.argv[1]); process.stdout.write(m.commands.node.version)' "$manifest_path")
  source_path="$fixture_root/home/$node_relative"
  provision_node "$source_path" "$fixture_root/${node_target#/}" "$node_version" \
    "${OPENKIT_HOST_FIXTURE_NODE_SOURCE_SHA256:?fixture Node digest is required}" \
    "${OPENKIT_HOST_FIXTURE_NODE_SOURCE_VERSION:?fixture Node version is required}"
elif [[ $# -eq 3 && $1 == remote ]]; then
  mode=remote
  target_path=${2:?manifest Node target is required}
  node_version=${3:?manifest Node version is required}
  source_path="$HOME/$node_relative"
  provision_node "$source_path" "$target_path" "$node_version" \
    "$(/usr/bin/sha256sum "$source_path" | { read -r digest _; printf '%s' "$digest"; })" \
    "$($source_path --version)"
else
  script_root=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  source "$script_root/ssh-alias.sh"
  require_ssh_alias "$@" || exit $?
  mode=remote
  {
    node -e 'const m=require(process.argv[1]); console.log(m.commands.node.path); console.log(m.commands.node.version)' "$script_root/manifest.json"
    sed -n '1,$p' "$0"
  } | ssh "$ssh_alias" "/usr/bin/bash -c 'IFS= read -r target; IFS= read -r version; /usr/bin/bash -s -- remote \"\$target\" \"\$version\"'"
fi
