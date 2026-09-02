#!/bin/sh
set -eu

# Installs the three verified NanoHost distribution payloads without managing service lifecycle.

cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
umask 077

NANOHOST_SOURCE=nanohost
GATEWAY_SOURCE=openshell-gateway
UNIT_SOURCE=openkit-nanohost.service
NANOHOST_DEST=/usr/lib/openkit/nanohost
GATEWAY_DEST=/usr/lib/openkit/openshell-gateway
UNIT_DEST=/etc/systemd/system/openkit-nanohost.service
NANOHOST_TEMP=/usr/lib/openkit/.nanohost.openkit-install
GATEWAY_TEMP=/usr/lib/openkit/.openshell-gateway.openkit-install
UNIT_TEMP=/etc/systemd/system/.openkit-nanohost.service.openkit-install

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

is_regular_nonlink() {
  [ -f "$1" ] && [ ! -L "$1" ]
}

is_aarch64_elf() {
  elf_path=$1
  [ -f "$elf_path" ] && [ ! -L "$elf_path" ] || return 1
  elf_size=$(wc -c <"$elf_path") || return 1
  set -- $(od -An -v -t u1 -N 64 -- "$elf_path")
  [ "$#" -eq 64 ] &&
    [ "$1" -eq 127 ] && [ "$2" -eq 69 ] && [ "$3" -eq 76 ] && [ "$4" -eq 70 ] &&
    [ "$5" -eq 2 ] && [ "$6" -eq 1 ] && [ "$7" -eq 1 ] &&
    { [ "${17}" -eq 2 ] || [ "${17}" -eq 3 ]; } && [ "${18}" -eq 0 ] &&
    [ "${19}" -eq 183 ] && [ "${20}" -eq 0 ] &&
    [ "${21}" -eq 1 ] && [ "${22}" -eq 0 ] && [ "${23}" -eq 0 ] && [ "${24}" -eq 0 ] &&
    [ "${53}" -eq 64 ] && [ "${54}" -eq 0 ] || return 1
  [ "${32}" -lt 128 ] || return 1
  entry=$((${25} + ${26} * 256 + ${27} * 65536 + ${28} * 16777216 + ${29} * 4294967296 + ${30} * 1099511627776 + ${31} * 281474976710656 + ${32} * 72057594037927936))
  [ "${37}" -eq 0 ] && [ "${38}" -eq 0 ] && [ "${39}" -eq 0 ] && [ "${40}" -eq 0 ] || return 1
  table_offset=$((${33} + ${34} * 256 + ${35} * 65536 + ${36} * 16777216))
  entry_size=$((${55} + ${56} * 256))
  entry_count=$((${57} + ${58} * 256))
  [ "$table_offset" -ge 64 ] && [ "$entry_size" -eq 56 ] && [ "$entry_count" -gt 0 ] || return 1
  [ $((table_offset + entry_size * entry_count)) -le "$elf_size" ] || return 1

  index=0
  while [ "$index" -lt "$entry_count" ]; do
    program_offset=$((table_offset + index * entry_size))
    set -- $(dd if="$elf_path" bs=1 skip="$program_offset" count=56 status=none | od -An -v -t u1)
    [ "$#" -eq 56 ] || return 1
    program_type=$(($1 + $2 * 256 + $3 * 65536 + $4 * 16777216))
    flags=$(($5 + $6 * 256 + $7 * 65536 + $8 * 16777216))
    [ "${13}" -eq 0 ] && [ "${14}" -eq 0 ] && [ "${15}" -eq 0 ] && [ "${16}" -eq 0 ] || {
      index=$((index + 1))
      continue
    }
    file_offset=$(($9 + ${10} * 256 + ${11} * 65536 + ${12} * 16777216))
    [ "${24}" -lt 128 ] || {
      index=$((index + 1))
      continue
    }
    virtual_address=$((${17} + ${18} * 256 + ${19} * 65536 + ${20} * 16777216 + ${21} * 4294967296 + ${22} * 1099511627776 + ${23} * 281474976710656 + ${24} * 72057594037927936))
    [ "${37}" -eq 0 ] && [ "${38}" -eq 0 ] && [ "${39}" -eq 0 ] && [ "${40}" -eq 0 ] || {
      index=$((index + 1))
      continue
    }
    file_bytes=$((${33} + ${34} * 256 + ${35} * 65536 + ${36} * 16777216))
    [ "${45}" -eq 0 ] && [ "${46}" -eq 0 ] && [ "${47}" -eq 0 ] && [ "${48}" -eq 0 ] || {
      index=$((index + 1))
      continue
    }
    memory_bytes=$((${41} + ${42} * 256 + ${43} * 65536 + ${44} * 16777216))
    [ "${53}" -eq 0 ] && [ "${54}" -eq 0 ] && [ "${55}" -eq 0 ] && [ "${56}" -eq 0 ] || {
      index=$((index + 1))
      continue
    }
    alignment=$((${49} + ${50} * 256 + ${51} * 65536 + ${52} * 16777216))
    aligned=false
    if [ "$alignment" -le 1 ]; then
      aligned=true
    elif [ $((alignment & (alignment - 1))) -eq 0 ] && [ $((file_offset % alignment)) -eq $((virtual_address % alignment)) ]; then
      aligned=true
    fi
    if [ "$program_type" -eq 1 ] && [ $((flags & 1)) -eq 1 ] && [ "$file_bytes" -gt 0 ] && [ "$memory_bytes" -ge "$file_bytes" ] && [ $((file_offset + file_bytes)) -le "$elf_size" ] && [ "$virtual_address" -le $((9223372036854775807 - memory_bytes + 1)) ] && [ "$entry" -ge "$virtual_address" ] && [ $((entry - virtual_address)) -lt "$file_bytes" ] && [ "$aligned" = true ]; then
      return 0
    fi
    index=$((index + 1))
  done
  return 1
}

verify_package() {
  expected='MANIFEST.json
install.sh
licenses/openkit-LICENSE
licenses/openshell-LICENSE
licenses/openshell-THIRD-PARTY-NOTICES
nanohost
openkit-nanohost.service
openshell-gateway'
  actual=$(awk 'length($1) == 64 && $2 ~ /^\*/ { sub(/^\*/, "", $2); print $2; next } length($1) == 64 && NF == 2 { print $2; next } { exit 2 }' SHA256SUMS 2>/dev/null) || fail 'package-checksums=invalid'
  [ "$actual" = "$expected" ] || fail 'package-checksums=invalid'
  sha256sum -c SHA256SUMS >/dev/null 2>&1 || fail 'package-checksums=failed'
  is_aarch64_elf "$NANOHOST_SOURCE" || fail 'nanohost-elf=invalid'
  is_aarch64_elf "$GATEWAY_SOURCE" || fail 'openshell-gateway-elf=invalid'
}

check_real_ancestors() {
  path=$(dirname -- "$1")
  while [ "$path" != / ]; do
    if [ -e "$path" ] || [ -L "$path" ]; then
      [ -d "$path" ] && [ ! -L "$path" ] || return 1
    fi
    path=$(dirname -- "$path")
  done
  [ -d / ] && [ ! -L / ]
}

file_state() {
  path=$1
  source=$2
  mode=$3
  if [ ! -e "$path" ] && [ ! -L "$path" ]; then
    printf absent
  elif is_regular_nonlink "$path" && cmp -s -- "$source" "$path" && [ "$(stat -c '%a' -- "$path")" = "$mode" ]; then
    printf exact
  else
    printf conflict
  fi
}

manifest_identity_value() {
  identity=$1
  field=$2
  tr -d '\n\r' <MANIFEST.json |
    sed -n "s/.*\"$identity\"[[:space:]]*:[[:space:]]*{[^}]*\"$field\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\"[^}]*}.*/\1/p"
}

file_identity() {
  stat -c '%d:%i' -- "$1"
}

claim_temporary() {
  path=$1
  (set -C; : >"$path") 2>/dev/null || return 1
  file_identity "$path"
}

cleanup_created_temporary() {
  path=$1
  identity=$2
  [ -n "$identity" ] || return 0
  is_regular_nonlink "$path" || return 0
  current=$(file_identity "$path" 2>/dev/null) || return 0
  [ "$current" = "$identity" ] || return 0
  rm -f -- "$path"
}

verify_package
printf '%s\n' 'package=pass'

case "${1-}" in
  '') ;;
  --check) [ "$#" -eq 1 ] || fail 'arguments=invalid' ;;
  *) fail 'arguments=invalid' ;;
esac

if [ -n "${DESTDIR-}" ]; then
  [ "$#" -eq 0 ] || fail 'arguments=invalid'
  case "$DESTDIR" in /*) ;; *) fail 'destdir=invalid' ;; esac
  [ "$DESTDIR" != / ] || fail 'destdir=invalid'
  normalized=$(realpath -m -- "$DESTDIR") || fail 'destdir=invalid'
  [ "$normalized" = "$DESTDIR" ] || fail 'destdir=invalid'
  [ ! -e "$DESTDIR" ] && [ ! -L "$DESTDIR" ] || fail 'destdir=exists'
  check_real_ancestors "$DESTDIR" || fail 'destdir-ancestor=invalid'

  stage_identity=
  stage_complete=false
  cleanup_stage() {
    status=${1:-$?}
    trap - EXIT HUP INT TERM
    current_stage_identity=$(file_identity "$DESTDIR" 2>/dev/null || true)
    if [ -n "$stage_identity" ] && [ "$stage_complete" != true ] && [ "$current_stage_identity" = "$stage_identity" ]; then
      for path in \
        "$DESTDIR/usr/lib/openkit/nanohost" \
        "$DESTDIR/usr/lib/openkit/openshell-gateway" \
        "$DESTDIR/etc/systemd/system/openkit-nanohost.service"; do
        if is_regular_nonlink "$path"; then rm -f -- "$path"; fi
      done
      rmdir -- "$DESTDIR/usr/lib/openkit" "$DESTDIR/usr/lib" "$DESTDIR/usr" 2>/dev/null || true
      rmdir -- "$DESTDIR/etc/systemd/system" "$DESTDIR/etc/systemd" "$DESTDIR/etc" 2>/dev/null || true
      rmdir -- "$DESTDIR" 2>/dev/null || true
    fi
    exit "$status"
  }
  trap 'cleanup_stage $?' EXIT
  trap 'cleanup_stage 129' HUP
  trap 'cleanup_stage 130' INT
  trap 'cleanup_stage 143' TERM
  stage_identity=$(mkdir -m 0700 -- "$DESTDIR" && file_identity "$DESTDIR") || fail 'destdir=create-failed'
  mkdir -m 0755 -p -- "$DESTDIR/usr/lib/openkit" "$DESTDIR/etc/systemd/system"
  install -m 0755 -- "$NANOHOST_SOURCE" "$DESTDIR$NANOHOST_DEST"
  install -m 0755 -- "$GATEWAY_SOURCE" "$DESTDIR$GATEWAY_DEST"
  install -m 0644 -- "$UNIT_SOURCE" "$DESTDIR$UNIT_DEST"
  stage_complete=true
  trap - EXIT HUP INT TERM
  printf '%s\n' 'staged-only'
  exit 0
fi

[ "$(uname -m)" = aarch64 ] || fail 'host-architecture=unsupported'
for prerequisite in /usr/bin/containerd /usr/bin/dockerd /usr/bin/docker /usr/bin/slirp4netns; do
  is_regular_nonlink "$prerequisite" && [ -x "$prerequisite" ] || fail "host-prerequisite=missing:$prerequisite"
done
[ -d /run/systemd/system ] && [ ! -L /run/systemd/system ] || fail 'host-prerequisite=systemd'
docker_path=$(manifest_identity_value docker path)
docker_version=$(manifest_identity_value docker version)
slirp_path=$(manifest_identity_value slirp4netns path)
slirp_version=$(manifest_identity_value slirp4netns version)
slirp_sha=$(manifest_identity_value slirp4netns sha256)
[ "$docker_path" = /usr/bin/docker ] && [ -n "$docker_version" ] || fail 'host-manifest=docker-invalid'
[ "$slirp_path" = /usr/bin/slirp4netns ] && [ -n "$slirp_version" ] || fail 'host-manifest=slirp4netns-invalid'
case "$slirp_sha" in *[!0-9a-f]*|'') fail 'host-manifest=slirp4netns-invalid' ;; esac
[ "${#slirp_sha}" -eq 64 ] || fail 'host-manifest=slirp4netns-invalid'
observed_docker=$(/usr/bin/docker --version 2>/dev/null) || fail 'host-prerequisite=docker-identity'
[ "$observed_docker" = "$docker_version" ] || fail 'host-prerequisite=docker-identity'
observed_slirp_output=$(/usr/bin/slirp4netns --version 2>/dev/null) || fail 'host-prerequisite=slirp4netns-identity'
observed_slirp=$(printf '%s\n' "$observed_slirp_output" | awk 'NR == 1 { print; exit }')
[ "$observed_slirp" = "$slirp_version" ] || fail 'host-prerequisite=slirp4netns-identity'
observed_slirp_sha=$(/usr/bin/sha256sum /usr/bin/slirp4netns | awk '{print $1}')
[ "$observed_slirp_sha" = "$slirp_sha" ] || fail 'host-prerequisite=slirp4netns-identity'
[ -d /etc/systemd/system ] && [ ! -L /etc/systemd/system ] || fail 'destination-ancestor=invalid:/etc/systemd/system'
exec 9</etc/systemd/system || fail 'installer-lock=unavailable'
flock -x 9 || fail 'installer-lock=unavailable'
for path in "$NANOHOST_DEST" "$GATEWAY_DEST" "$UNIT_DEST" "$NANOHOST_TEMP" "$GATEWAY_TEMP" "$UNIT_TEMP"; do
  check_real_ancestors "$path" || fail "destination-ancestor=invalid:$path"
done
printf '%s\n' 'host-prerequisites=pass'

nanohost_dest_state=$(file_state "$NANOHOST_DEST" "$NANOHOST_SOURCE" 755)
gateway_dest_state=$(file_state "$GATEWAY_DEST" "$GATEWAY_SOURCE" 755)
unit_dest_state=$(file_state "$UNIT_DEST" "$UNIT_SOURCE" 644)
nanohost_temp_state=$(file_state "$NANOHOST_TEMP" "$NANOHOST_SOURCE" 755)
gateway_temp_state=$(file_state "$GATEWAY_TEMP" "$GATEWAY_SOURCE" 755)
unit_temp_state=$(file_state "$UNIT_TEMP" "$UNIT_SOURCE" 644)

if [ "$nanohost_dest_state$gateway_dest_state$unit_dest_state$nanohost_temp_state$gateway_temp_state$unit_temp_state" = absentabsentabsentabsentabsentabsent ]; then
  disposition=installable
elif [ "$nanohost_dest_state$gateway_dest_state$unit_dest_state$nanohost_temp_state$gateway_temp_state$unit_temp_state" = exactexactexactabsentabsentabsent ]; then
  disposition=already-installed
elif [ "$nanohost_dest_state" != conflict ] && [ "$gateway_dest_state" != conflict ] && [ "$unit_dest_state" != conflict ] && [ "$nanohost_temp_state" != conflict ] && [ "$gateway_temp_state" != conflict ] && [ "$unit_temp_state" != conflict ]; then
  disposition=resumable
else
  disposition=destination-conflict
fi
printf 'destination=%s\n' "$disposition"
[ "$disposition" != destination-conflict ] || exit 1
[ "${1-}" != --check ] || exit 0
[ "$disposition" != already-installed ] || {
  printf '%s\n' 'installation=already-installed'
  printf '%s\n' 'remaining=configuration,enrollment,deployment-images,service-start'
  exit 0
}

created_nanohost_identity=
created_gateway_identity=
created_unit_identity=
created_openkit_identity=
install_complete=false
cleanup_live() {
  status=${1:-$?}
  trap - EXIT HUP INT TERM
  if [ "$install_complete" != true ]; then
    cleanup_created_temporary "$NANOHOST_TEMP" "$created_nanohost_identity"
    cleanup_created_temporary "$GATEWAY_TEMP" "$created_gateway_identity"
    cleanup_created_temporary "$UNIT_TEMP" "$created_unit_identity"
    current_openkit_identity=$(file_identity /usr/lib/openkit 2>/dev/null || true)
    if [ -n "$created_openkit_identity" ] && [ "$current_openkit_identity" = "$created_openkit_identity" ]; then
      rmdir -- /usr/lib/openkit 2>/dev/null || true
    fi
    printf '%s\n' 'installation=incomplete' >&2
  fi
  exit "$status"
}
trap 'cleanup_live $?' EXIT
trap 'cleanup_live 129' HUP
trap 'cleanup_live 130' INT
trap 'cleanup_live 143' TERM

if [ ! -d /usr/lib/openkit ]; then
  created_openkit_identity=$(mkdir -m 0755 -- /usr/lib/openkit && file_identity /usr/lib/openkit) || fail 'destination-ancestor=invalid:/usr/lib/openkit'
fi
if [ "$nanohost_dest_state" = absent ] && [ "$nanohost_temp_state" = absent ]; then
  created_nanohost_identity=$(claim_temporary "$NANOHOST_TEMP") || fail 'destination-conflict'
  install -m 0755 -- "$NANOHOST_SOURCE" "$NANOHOST_TEMP"
fi
if [ "$gateway_dest_state" = absent ] && [ "$gateway_temp_state" = absent ]; then
  created_gateway_identity=$(claim_temporary "$GATEWAY_TEMP") || fail 'destination-conflict'
  install -m 0755 -- "$GATEWAY_SOURCE" "$GATEWAY_TEMP"
fi
if [ "$unit_dest_state" = absent ] && [ "$unit_temp_state" = absent ]; then
  created_unit_identity=$(claim_temporary "$UNIT_TEMP") || fail 'destination-conflict'
  install -m 0644 -- "$UNIT_SOURCE" "$UNIT_TEMP"
fi

if [ "$nanohost_dest_state" = absent ]; then
  ln -- "$NANOHOST_TEMP" "$NANOHOST_DEST" || fail 'installation=incomplete'
  [ "$(file_state "$NANOHOST_DEST" "$NANOHOST_SOURCE" 755)" = exact ] || fail 'installation=incomplete'
fi
if [ "$gateway_dest_state" = absent ]; then
  ln -- "$GATEWAY_TEMP" "$GATEWAY_DEST" || fail 'installation=incomplete'
  [ "$(file_state "$GATEWAY_DEST" "$GATEWAY_SOURCE" 755)" = exact ] || fail 'installation=incomplete'
fi
if [ "$unit_dest_state" = absent ]; then
  ln -- "$UNIT_TEMP" "$UNIT_DEST" || fail 'installation=incomplete'
  [ "$(file_state "$UNIT_DEST" "$UNIT_SOURCE" 644)" = exact ] || fail 'installation=incomplete'
fi
if [ "$(file_state "$NANOHOST_TEMP" "$NANOHOST_SOURCE" 755)" = exact ]; then rm -f -- "$NANOHOST_TEMP"; fi
if [ "$(file_state "$GATEWAY_TEMP" "$GATEWAY_SOURCE" 755)" = exact ]; then rm -f -- "$GATEWAY_TEMP"; fi
if [ "$(file_state "$UNIT_TEMP" "$UNIT_SOURCE" 644)" = exact ]; then rm -f -- "$UNIT_TEMP"; fi
install_complete=true
trap - EXIT HUP INT TERM
printf '%s\n' 'installation=complete'
printf '%s\n' 'remaining=configuration,enrollment,deployment-images,service-start'
