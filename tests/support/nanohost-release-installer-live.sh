#!/usr/bin/env bash
# openkit-test-platform: posix
set -uo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
INSTALLER="${REPO_ROOT}/apps/nanohost/deploy/install.sh"
BWRAP="$(command -v bwrap || true)"
FAILURES=0

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  FAILURES=$((FAILURES + 1))
}

finish() {
  if [[ "$FAILURES" -ne 0 ]]; then
    printf 'NanoHost fixed-path installer gate failed with %d finding(s).\n' "$FAILURES" >&2
    exit 1
  fi
  printf 'NanoHost fixed-path installer gate passed.\n'
}

require() {
  [[ -n "$1" ]] || { printf 'FAIL: %s\n' "$2" >&2; exit 1; }
}

require "$BWRAP" 'Bubblewrap is required for the NanoHost fixed-path installer gate.'
[[ -x "$INSTALLER" ]] || { printf 'FAIL: NanoHost installer is missing or not executable.\n' >&2; exit 1; }
"$BWRAP" --unshare-all --die-with-parent --new-session --ro-bind / / --proc /proc --dev /dev -- /bin/true || {
  printf 'FAIL: Bubblewrap minimal namespace self-check failed.\n' >&2
  exit 1
}
set +e
"$BWRAP" --unshare-all --die-with-parent --new-session --ro-bind / / --proc /proc --dev /dev -- /bin/sh -c 'exit 23'
SELF_CHECK_FAILURE=$?
set -e
[[ "$SELF_CHECK_FAILURE" -eq 23 ]] || {
  printf 'FAIL: Bubblewrap namespace self-check did not propagate a deliberate failure.\n' >&2
  exit 1
}
(FAILURES=0; finish >/dev/null) || {
  printf 'FAIL: NanoHost gate aggregation rejected its stable passing stand-in.\n' >&2
  exit 1
}
set +e
(FAILURES=1; finish >/dev/null 2>&1)
SELF_CHECK_AGGREGATION=$?
set -e
[[ "$SELF_CHECK_AGGREGATION" -eq 1 ]] || {
  printf 'FAIL: NanoHost gate aggregation accepted its stable failing stand-in.\n' >&2
  exit 1
}

WORK_ROOT="$(mktemp -d)"
trap 'rm -rf -- "$WORK_ROOT"' EXIT HUP INT TERM
LIB_ARCH_DIR="$(readlink -f "$(ldd /bin/sh | awk '/libc\.so/{print $3; exit}')" | xargs dirname)"
LOADER_NAME="$(basename "$(readlink -f "$(ldd /bin/sh | awk '/ld-linux/{print $1; exit}')")")"

write_elf() {
  local path=$1
  dd if=/dev/zero of="$path" bs=64 count=1 status=none
  printf '\177ELF\002\001\001' | dd of="$path" conv=notrunc status=none
  printf '\002\000' | dd of="$path" bs=1 seek=16 conv=notrunc status=none
  printf '\267\000\001\000\000\000' | dd of="$path" bs=1 seek=18 conv=notrunc status=none
  printf '\100\000' | dd of="$path" bs=1 seek=52 conv=notrunc status=none
  chmod 0755 "$path"
}

write_bundle_manifest() {
  local docker_version=$1 slirp_version=$2 slirp_sha=$3
  cat >"$BUNDLE/MANIFEST.json" <<EOF
{
  "schemaVersion": 1,
  "tag": "v0.1.0-rc.1",
  "target": "linux/arm64",
  "destinations": {
    "nanohost": "/usr/lib/openkit/nanohost",
    "openshell-gateway": "/usr/lib/openkit/openshell-gateway",
    "openkit-nanohost.service": "/etc/systemd/system/openkit-nanohost.service"
  },
  "prerequisites": {
    "architecture": "aarch64",
    "files": ["/usr/bin/containerd", "/usr/bin/dockerd", "/usr/bin/docker", "/usr/bin/slirp4netns"],
    "systemd": true,
    "identities": {
      "docker": {"path": "/usr/bin/docker", "version": "$docker_version"},
      "slirp4netns": {"path": "/usr/bin/slirp4netns", "version": "$slirp_version", "sha256": "$slirp_sha"}
    }
  }
}
EOF
}

refresh_bundle_checksums() {
  local members=(
    MANIFEST.json
    install.sh
    licenses/openkit-LICENSE
    licenses/openshell-LICENSE
    licenses/openshell-THIRD-PARTY-NOTICES
    nanohost
    openkit-nanohost.service
    openshell-gateway
  )
  (
    cd "$BUNDLE"
    for member in "${members[@]}"; do sha256sum "$member"; done >SHA256SUMS
  )
}

new_case() {
  CASE_ROOT="$(mktemp -d "${WORK_ROOT}/case.XXXXXX")"
  LIVE="${CASE_ROOT}/live"
  BUNDLE="${CASE_ROOT}/bundle"
  STUBS="${CASE_ROOT}/stubs"
  CONTROL="${CASE_ROOT}/control"
  mkdir -p "$LIVE/usr/lib/openkit" "$LIVE/etc/systemd/system" "$LIVE/run/systemd/system" "$BUNDLE/licenses" "$STUBS" "$CONTROL"
  cp "$INSTALLER" "$BUNDLE/install.sh"
  chmod 0755 "$BUNDLE/install.sh"
  write_elf "$BUNDLE/nanohost"
  write_elf "$BUNDLE/openshell-gateway"
  printf '[Service]\nExecStart=/usr/lib/openkit/nanohost\n' >"$BUNDLE/openkit-nanohost.service"
  printf 'OpenKit fixture license\n' >"$BUNDLE/licenses/openkit-LICENSE"
  printf 'OpenShell fixture license\n' >"$BUNDLE/licenses/openshell-LICENSE"
  printf 'OpenShell fixture notices\n' >"$BUNDLE/licenses/openshell-THIRD-PARTY-NOTICES"
  for command in containerd dockerd; do
    printf '#!/bin/sh\nexit 0\n' >"$STUBS/$command"
    chmod 0755 "$STUBS/$command"
  done
  printf '#!/bin/sh\nprintf "Docker fixture version\\n"\n' >"$STUBS/docker"
  printf '#!/bin/sh\nprintf "slirp4netns fixture version\\n"\n' >"$STUBS/slirp4netns"
  printf '#!/bin/sh\nprintf "aarch64\\n"\n' >"$STUBS/uname"
  chmod 0755 "$STUBS/docker" "$STUBS/slirp4netns" "$STUBS/uname"
  local slirp_sha
  slirp_sha="$(sha256sum "$STUBS/slirp4netns" | cut -d' ' -f1)"
  write_bundle_manifest 'Docker fixture version' 'slirp4netns fixture version' "$slirp_sha"
  refresh_bundle_checksums
}

namespace_command() {
  local extra_stub=${1:-}
  shift || true
  local args=(
    --unshare-all --die-with-parent --new-session
    --ro-bind / /
    --proc /proc --dev /dev
    --tmpfs /usr/lib
    --dir "$LIB_ARCH_DIR"
    --ro-bind "$LIB_ARCH_DIR" "$LIB_ARCH_DIR"
    --symlink "$(basename "$LIB_ARCH_DIR")/$LOADER_NAME" "/usr/lib/$LOADER_NAME"
    --bind "$LIVE/usr/lib/openkit" /usr/lib/openkit
    --bind "$LIVE/etc/systemd" /etc/systemd
    --tmpfs /run
    --bind "$LIVE/run/systemd" /run/systemd
    --bind "$CONTROL" "$CONTROL"
    --ro-bind "$STUBS/containerd" /usr/bin/containerd
    --ro-bind "$STUBS/dockerd" /usr/bin/dockerd
    --ro-bind "$STUBS/docker" /usr/bin/docker
    --ro-bind "$STUBS/slirp4netns" /usr/bin/slirp4netns
    --chdir "$BUNDLE"
  )
  if [[ -z "$extra_stub" ]]; then extra_stub=$STUBS; fi
  args+=(--setenv PATH "$extra_stub:/usr/bin:/bin" --setenv OPENKIT_INSTALLER_CONTROL "$CONTROL" -- /bin/sh "$BUNDLE/install.sh" "$@")
  "$BWRAP" "${args[@]}"
}

run_case() {
  local label=$1 stub=$2
  shift 2
  set +e
  namespace_command "$stub" "$@" >"$CASE_ROOT/$label.out" 2>"$CASE_ROOT/$label.err"
  RESULT=$?
  set -e
  OUTPUT="$(cat "$CASE_ROOT/$label.out")"
  ERROR="$(cat "$CASE_ROOT/$label.err")"
}

expect_status() {
  local expected=$1 label=$2
  [[ "$RESULT" -eq "$expected" ]] || fail "$label: expected status $expected, got $RESULT; stderr=$ERROR"
}

expect_output() {
  local pattern=$1 label=$2
  grep -Eq "$pattern" <<<"$OUTPUT" || fail "$label: missing output $pattern; stdout=$OUTPUT"
}

test_four_dispositions() {
  new_case
  run_case installable '' --check
  expect_status 0 installable
  expect_output '^destination=installable$' installable

  new_case
  cp "$BUNDLE/nanohost" "$LIVE/usr/lib/openkit/nanohost"
  cp "$BUNDLE/openshell-gateway" "$LIVE/usr/lib/openkit/openshell-gateway"
  cp "$BUNDLE/openkit-nanohost.service" "$LIVE/etc/systemd/system/openkit-nanohost.service"
  chmod 0755 "$LIVE/usr/lib/openkit/nanohost" "$LIVE/usr/lib/openkit/openshell-gateway"
  chmod 0644 "$LIVE/etc/systemd/system/openkit-nanohost.service"
  run_case already '' --check
  expect_status 0 already-installed
  expect_output '^destination=already-installed$' already-installed

  new_case
  cp "$BUNDLE/nanohost" "$LIVE/usr/lib/openkit/.nanohost.openkit-install"
  chmod 0755 "$LIVE/usr/lib/openkit/.nanohost.openkit-install"
  run_case resumable '' --check
  expect_status 0 resumable
  expect_output '^destination=resumable$' resumable

  new_case
  printf 'conflict\n' >"$LIVE/usr/lib/openkit/nanohost"
  chmod 0755 "$LIVE/usr/lib/openkit/nanohost"
  run_case conflict '' --check
  [[ "$RESULT" -ne 0 ]] || fail 'destination-conflict returned success'
  expect_output '^destination=destination-conflict$' destination-conflict
}

test_exact_host_identities() {
  new_case
  printf '#!/bin/sh\nprintf "wrong Docker version\\n"\n' >"$STUBS/docker"
  chmod 0755 "$STUBS/docker"
  run_case wrong-docker '' --check
  [[ "$RESULT" -ne 0 ]] || fail 'installer accepted the wrong fixed Docker identity'
  ! grep -q '^host-prerequisites=pass$' <<<"$OUTPUT" || fail 'wrong Docker identity reported host prerequisites pass'

  new_case
  printf '#!/bin/sh\nprintf "wrong slirp version\\n"\n' >"$STUBS/slirp4netns"
  chmod 0755 "$STUBS/slirp4netns"
  local slirp_sha
  slirp_sha="$(sha256sum "$STUBS/slirp4netns" | cut -d' ' -f1)"
  write_bundle_manifest 'Docker fixture version' 'slirp4netns fixture version' "$slirp_sha"
  refresh_bundle_checksums
  run_case wrong-slirp-version '' --check
  [[ "$RESULT" -ne 0 ]] || fail 'installer accepted the wrong fixed slirp4netns identity'
  ! grep -q '^host-prerequisites=pass$' <<<"$OUTPUT" || fail 'wrong slirp4netns identity reported host prerequisites pass'

  new_case
  write_bundle_manifest 'Docker fixture version' 'slirp4netns fixture version' "$(printf '0%.0s' {1..64})"
  refresh_bundle_checksums
  run_case wrong-slirp-sha '' --check
  [[ "$RESULT" -ne 0 ]] || fail 'installer accepted the wrong fixed slirp4netns SHA-256'
  ! grep -q '^host-prerequisites=pass$' <<<"$OUTPUT" || fail 'wrong slirp4netns SHA-256 reported host prerequisites pass'
}

test_other_host_prerequisites_and_ancestors() {
  new_case
  printf '#!/bin/sh\nprintf "x86_64\\n"\n' >"$STUBS/uname"
  chmod 0755 "$STUBS/uname"
  run_case wrong-architecture '' --check
  [[ "$RESULT" -ne 0 ]] || fail 'installer accepted the wrong host architecture'
  ! grep -q '^host-prerequisites=pass$' <<<"$OUTPUT" || fail 'wrong architecture reported host prerequisites pass'

  for prerequisite in containerd dockerd; do
    new_case
    chmod 0644 "$STUBS/$prerequisite"
    run_case "missing-$prerequisite" '' --check
    [[ "$RESULT" -ne 0 ]] || fail "installer accepted unavailable $prerequisite"
    ! grep -q '^host-prerequisites=pass$' <<<"$OUTPUT" || fail "unavailable $prerequisite reported host prerequisites pass"
  done

  new_case
  rmdir "$LIVE/run/systemd/system"
  run_case missing-systemd '' --check
  [[ "$RESULT" -ne 0 ]] || fail 'installer accepted a host without systemd'
  ! grep -q '^host-prerequisites=pass$' <<<"$OUTPUT" || fail 'missing systemd reported host prerequisites pass'

  new_case
  mkdir "$CASE_ROOT/outside-systemd"
  rmdir "$LIVE/etc/systemd/system"
  ln -s "$CASE_ROOT/outside-systemd" "$LIVE/etc/systemd/system"
  run_case ancestor-symlink '' --check
  [[ "$RESULT" -ne 0 ]] || fail 'installer accepted a live destination ancestor symlink'
}

test_live_completion_output() {
  new_case
  run_case install ''
  expect_status 0 live-install
  expect_output '^installation=complete$' live-install
  expect_output '^remaining=configuration,enrollment,deployment-images,service-start$' live-install
  run_case reinstall ''
  expect_status 0 live-reinstall
  expect_output '^installation=already-installed$' live-reinstall
  expect_output '^remaining=configuration,enrollment,deployment-images,service-start$' live-reinstall
}

test_partial_cleanup() {
  new_case
  local injected="${CASE_ROOT}/partial-bin"
  cp -a "$STUBS" "$injected"
  cat >"$injected/install" <<'EOF'
#!/usr/bin/env bash
target=${@: -1}
source=${@: -2:1}
if [[ "$target" == /usr/lib/openkit/.nanohost.openkit-install ]]; then
  head -c 8 "$source" >"$target"
  chmod 0755 "$target"
  exit 42
fi
exec /usr/bin/install "$@"
EOF
  chmod 0755 "$injected/install"
  run_case partial "$injected"
  [[ "$RESULT" -ne 0 ]] || fail 'injected partial write returned success'
  [[ ! -e "$LIVE/usr/lib/openkit/.nanohost.openkit-install" ]] || fail 'caught partial write left its reserved temporary file'
}

test_interrupted_resume_and_symlink_rejection() {
  new_case
  cp "$BUNDLE/nanohost" "$LIVE/usr/lib/openkit/.nanohost.openkit-install"
  chmod 0755 "$LIVE/usr/lib/openkit/.nanohost.openkit-install"
  run_case resume ''
  expect_status 0 interrupted-resume
  cmp -s "$BUNDLE/nanohost" "$LIVE/usr/lib/openkit/nanohost" || fail 'resume did not publish exact NanoHost bytes'
  [[ ! -e "$LIVE/usr/lib/openkit/.nanohost.openkit-install" ]] || fail 'resume retained the exact temporary file'

  new_case
  printf 'outside\n' >"$CASE_ROOT/outside"
  ln -s "$CASE_ROOT/outside" "$LIVE/usr/lib/openkit/nanohost"
  run_case destination-symlink '' --check
  [[ "$RESULT" -ne 0 ]] || fail 'installer accepted a destination symlink'
  [[ "$(cat "$CASE_ROOT/outside")" == outside ]] || fail 'destination symlink target was changed'

  new_case
  printf 'outside\n' >"$CASE_ROOT/outside"
  ln -s "$CASE_ROOT/outside" "$LIVE/usr/lib/openkit/.nanohost.openkit-install"
  run_case temporary-symlink '' --check
  [[ "$RESULT" -ne 0 ]] || fail 'installer accepted a reserved temporary symlink'
  [[ "$(cat "$CASE_ROOT/outside")" == outside ]] || fail 'temporary symlink target was changed'
}

test_fixed_lock_serialization() {
  new_case
  local lock_fd process status
  exec {lock_fd}<"$LIVE/etc/systemd/system"
  flock -x "$lock_fd"
  set +e
  namespace_command '' --check >"$CASE_ROOT/locked.out" 2>"$CASE_ROOT/locked.err" &
  process=$!
  set -e
  sleep 0.2
  if ! kill -0 "$process" 2>/dev/null; then
    set +e
    wait "$process"
    status=$?
    set -e
    flock -u "$lock_fd"
    exec {lock_fd}<&-
    fail "installer did not block on the mapped /etc/systemd/system inode: status $status"
    return
  fi
  printf 'non-cooperating winner\n' >"$LIVE/usr/lib/openkit/nanohost"
  chmod 0755 "$LIVE/usr/lib/openkit/nanohost"
  flock -u "$lock_fd"
  exec {lock_fd}<&-
  set +e
  wait "$process"
  status=$?
  set -e
  [[ "$status" -ne 0 ]] || fail 'locked installer did not observe the destination conflict after release'
  grep -q '^destination=destination-conflict$' "$CASE_ROOT/locked.out" || fail 'locked installer did not report the post-lock destination conflict'
}

test_noncooperating_publication_race() {
  new_case
  local paused="${CASE_ROOT}/paused-bin"
  cp -a "$STUBS" "$paused"
  cat >"$paused/install" <<'EOF'
#!/usr/bin/env bash
target=${@: -1}
/usr/bin/install "$@"
if [[ "$target" == /usr/lib/openkit/.nanohost.openkit-install ]]; then
  : >"$OPENKIT_INSTALLER_CONTROL/prepared"
  while [[ ! -e "$OPENKIT_INSTALLER_CONTROL/continue" ]]; do /bin/sleep 0.01; done
fi
EOF
  chmod 0755 "$paused/install"
  set +e
  namespace_command "$paused" >"$CASE_ROOT/race.out" 2>"$CASE_ROOT/race.err" &
  local process=$!
  local deadline=$((SECONDS + 10))
  while [[ ! -e "$CONTROL/prepared" && "$SECONDS" -lt "$deadline" ]]; do sleep 0.01; done
  if [[ ! -e "$CONTROL/prepared" ]]; then
    kill "$process" 2>/dev/null || true
    wait "$process" 2>/dev/null || true
    set -e
    fail 'publication race did not reach the prepared observation'
    return
  fi
  printf 'non-cooperating winner\n' >"$CASE_ROOT/non-cooperating-winner"
  cp "$CASE_ROOT/non-cooperating-winner" "$LIVE/usr/lib/openkit/nanohost"
  chmod 0755 "$LIVE/usr/lib/openkit/nanohost"
  : >"$CONTROL/continue"
  wait "$process"; local status=$?
  set -e
  [[ "$status" -ne 0 ]] || fail 'installer reported success after a non-cooperating destination appeared'
  cmp -s "$CASE_ROOT/non-cooperating-winner" "$LIVE/usr/lib/openkit/nanohost" || fail 'installer overwrote the non-cooperating destination'
}

set -e
test_four_dispositions
test_exact_host_identities
test_other_host_prerequisites_and_ancestors
test_live_completion_output
test_partial_cleanup
test_interrupted_resume_and_symlink_rejection
test_fixed_lock_serialization
test_noncooperating_publication_race
finish
