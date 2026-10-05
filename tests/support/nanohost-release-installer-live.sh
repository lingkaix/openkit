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
PYTHON_STDLIB="$(python3 -I -B -c 'import sysconfig; print(sysconfig.get_path("stdlib"))')"
LIB_ARCH_DIR="$(readlink -f "$(ldd /bin/sh | awk '/libc\.so/{print $3; exit}')" | xargs dirname)"

write_elf() {
  local path=$1
  dd if=/dev/zero of="$path" bs=132 count=1 status=none
  printf '\177ELF\002\001\001' | dd of="$path" conv=notrunc status=none
  printf '\002\000' | dd of="$path" bs=1 seek=16 conv=notrunc status=none
  printf '\267\000\001\000\000\000' | dd of="$path" bs=1 seek=18 conv=notrunc status=none
  printf '\170\000\100\000\000\000\000\000' | dd of="$path" bs=1 seek=24 conv=notrunc status=none
  printf '\100\000\000\000\000\000\000\000' | dd of="$path" bs=1 seek=32 conv=notrunc status=none
  printf '\100\000' | dd of="$path" bs=1 seek=52 conv=notrunc status=none
  printf '\070\000\001\000' | dd of="$path" bs=1 seek=54 conv=notrunc status=none
  printf '\001\000\000\000\005\000\000\000' | dd of="$path" bs=1 seek=64 conv=notrunc status=none
  printf '\000\000\100\000\000\000\000\000' | dd of="$path" bs=1 seek=80 conv=notrunc status=none
  printf '\000\000\100\000\000\000\000\000' | dd of="$path" bs=1 seek=88 conv=notrunc status=none
  printf '\204\000\000\000\000\000\000\000' | dd of="$path" bs=1 seek=96 conv=notrunc status=none
  printf '\204\000\000\000\000\000\000\000' | dd of="$path" bs=1 seek=104 conv=notrunc status=none
  printf '\000\020\000\000\000\000\000\000' | dd of="$path" bs=1 seek=112 conv=notrunc status=none
  printf '\250\013\200\322\000\000\200\322\001\000\000\324' | dd of="$path" bs=1 seek=120 conv=notrunc status=none
  chmod 0755 "$path"
}

write_bundle_manifest() {
  python3 -I -B - "$BUNDLE" <<'PY_MANIFEST'
import hashlib,json,pathlib,sys
root=pathlib.Path(sys.argv[1])
profile_bytes=(root/'host-manifest.json').read_bytes()
profile=json.loads(profile_bytes)
files=['MANIFEST.json','SHA256SUMS','host-manifest.json','install.sh','licenses/openkit-LICENSE','licenses/openshell-LICENSE','licenses/openshell-THIRD-PARTY-NOTICES','nanohost','openkit-nanohost.service','openshell-gateway']
manifest={'schemaVersion':2,'tag':'v0.1.0-rc.1','productCommit':'a'*40,'target':'linux/arm64','architecture':'arm64','profileId':profile['profileId'],'profileDigest':hashlib.sha256(profile_bytes).hexdigest(),'files':files,'libcRequirements':{name:{'interpreter':None,'symbols':[],'maximumGlibc':None} for name in ('nanohost','openshell-gateway')}}
(root/'MANIFEST.json').write_text(json.dumps(manifest))
PY_MANIFEST
}

refresh_bundle_checksums() {
  local members=(
    MANIFEST.json
    host-manifest.json
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
  tar -czf "$CASE_ROOT/openkit-nanohost-v0.1.0-rc.1-linux-arm64.tar.gz" --transform='s|^bundle/|openkit-nanohost-v0.1.0-rc.1-linux-arm64/|' -C "$CASE_ROOT" "${members[@]/#/bundle/}" bundle/SHA256SUMS
}

new_case() {
  CASE_ROOT="$(mktemp -d "${WORK_ROOT}/case.XXXXXX")"
  LIVE="${CASE_ROOT}/live"
  BUNDLE="${CASE_ROOT}/bundle"
  STUBS="${CASE_ROOT}/stubs"
  CONTROL="${CASE_ROOT}/control"
  mkdir -p "$LIVE/var/lib" "$LIVE/etc" "$LIVE/usr/bin" "$LIVE/proc" "$LIVE/dev" "$LIVE/sys/fs/cgroup" "$LIVE/tmp" "$LIVE/usr/lib/openkit" "$LIVE/etc/systemd/system" "$LIVE/run/systemd/system" "$BUNDLE/licenses" "$STUBS" "$CONTROL"
  cp "$INSTALLER" "$BUNDLE/install.sh"
  chmod 0755 "$BUNDLE/install.sh"
  write_elf "$BUNDLE/nanohost"
  write_elf "$BUNDLE/openshell-gateway"
  cp "$REPO_ROOT/apps/nanohost/deploy/host-manifest.json" "$BUNDLE/host-manifest.json"
  cp "$REPO_ROOT/apps/nanohost/deploy/openkit-nanohost.service" "$BUNDLE/openkit-nanohost.service"
  printf '0123456789abcdef0123456789abcdef\n' >"$LIVE/etc/machine-id"
  mkdir -p "$LIVE/run/systemd/resolve"
  printf 'nameserver 1.1.1.1\n' >"$LIVE/run/systemd/resolve/resolv.conf"
  printf 'OpenKit fixture license\n' >"$BUNDLE/licenses/openkit-LICENSE"
  printf 'OpenShell fixture license\n' >"$BUNDLE/licenses/openshell-LICENSE"
  printf 'OpenShell fixture notices\n' >"$BUNDLE/licenses/openshell-THIRD-PARTY-NOTICES"
  for command in containerd dockerd; do
    printf '#!/bin/sh\nexit 0\n' >"$STUBS/$command"
    chmod 0755 "$STUBS/$command"
  done
  printf '#!/bin/sh\nprintf "Docker version 28.0.4, build abc1234\\n"\n' >"$STUBS/docker"
  printf '#!/bin/sh\nprintf "git version 2.55.0\\n"\n' >"$STUBS/git"
  printf '#!/bin/sh\nprintf "slirp4netns fixture version\\ncommit: fixture\\nlibslirp: fixture\\n"\n' >"$STUBS/slirp4netns"
  printf '#!/bin/sh\ncase "$1" in -s) echo Linux;; -m) echo aarch64;; -r) echo 6.8.33-fixture;; esac\n' >"$STUBS/uname"
  printf '#!/bin/sh\nexit 0\n' >"$STUBS/systemd-analyze"
  printf 'systemd\n' >"$STUBS/pid1"
  chmod 0755 "$STUBS/systemd-analyze"
  chmod 0755 "$STUBS/docker" "$STUBS/git" "$STUBS/slirp4netns" "$STUBS/uname"
  write_bundle_manifest
  refresh_bundle_checksums
}

namespace_command() {
  local extra_stub=${1:-}
  shift || true
  local args=(
    --unshare-all --die-with-parent --new-session --uid 0 --gid 0
    --bind "$LIVE" /
    --ro-bind /usr/bin /usr/bin
    --ro-bind /bin /bin
    --ro-bind /lib /lib
    --ro-bind "$LIB_ARCH_DIR" "$LIB_ARCH_DIR"
    --ro-bind "$PYTHON_STDLIB" "$PYTHON_STDLIB"
    --proc /proc --dev /dev
    --ro-bind /sys/fs/cgroup /sys/fs/cgroup
    --ro-bind "$STUBS/pid1" /proc/1/comm
    --bind "$CASE_ROOT" "$CASE_ROOT"
    --ro-bind "$STUBS/containerd" /usr/bin/containerd
    --ro-bind "$STUBS/dockerd" /usr/bin/dockerd
    --ro-bind "$STUBS/docker" /usr/bin/docker
    --ro-bind "$STUBS/git" /usr/bin/git
    --ro-bind "$STUBS/slirp4netns" /usr/bin/slirp4netns
    --ro-bind "$STUBS/uname" /usr/bin/uname
    --ro-bind "$STUBS/systemd-analyze" /usr/bin/systemd-analyze
    --chdir "$BUNDLE"
  )
  if [[ -d /lib64 ]]; then args+=(--ro-bind /lib64 /lib64); fi
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

test_capability_host_requirements() {
  new_case
  local before after
  before=$(find "$LIVE" -type f -exec sha256sum {} + | sort)
  run_case host-check '' --check-host
  expect_status 0 host-check
  python3 -I -B - "$CASE_ROOT/host-check.out" <<'PY_RESULT' || fail 'host-check framing or identities invalid'
import hashlib,json,pathlib,sys
raw=pathlib.Path(sys.argv[1]).read_bytes()
result=json.loads(raw)
assert raw == (json.dumps(result,separators=(',',':'))+'\n').encode()
assert result['hardVerdict']=='requirements-met'
assert result['machineObservationDigest']==hashlib.sha256(json.dumps(result['requirements'],separators=(',',':')).encode()).hexdigest()
assert result['machineIdentityDigest']==hashlib.sha256(b'0123456789abcdef0123456789abcdef\n').hexdigest()
assert all(item['outcome']=='met' for item in result['requirements'])
PY_RESULT
  after=$(find "$LIVE" -type f -exec sha256sum {} + | sort)
  [[ "$before" == "$after" ]] || fail 'host check changed live fixture bytes'

  new_case
  printf '#!/bin/sh\nprintf "Docker version 27.9.0, build abc1234\\n"\n' >"$STUBS/docker"
  chmod 0755 "$STUBS/docker"
  run_case old-docker '' --check-host
  expect_status 1 old-docker
  expect_output '"hardVerdict":"requirements-unmet"' old-docker

  new_case
  printf '#!/bin/sh\nprintf "malformed Git version\\n"\n' >"$STUBS/git"
  chmod 0755 "$STUBS/git"
  run_case malformed-git '' --check-host
  expect_status 1 malformed-git
  expect_output '"hardVerdict":"cannot-check"' malformed-git

  new_case
  printf '#!/bin/sh\nprintf "another slirp version\\n"\n' >"$STUBS/slirp4netns"
  chmod 0755 "$STUBS/slirp4netns"
  run_case alternate-slirp '' --check
  expect_status 0 alternate-slirp
  expect_output '^host-prerequisites=pass$' alternate-slirp

  new_case
  printf ' ' >>"$BUNDLE/host-manifest.json"
  refresh_bundle_checksums
  run_case profile-digest '' --check-host
  expect_status 1 profile-digest
  expect_output '"hardVerdict":"cannot-check"' profile-digest

  new_case
  rm "$LIVE/etc/machine-id"
  run_case missing-identity '' --check-host
  expect_status 1 missing-identity
  expect_output '"hardVerdict":"cannot-check"' missing-identity

  new_case
  printf '#!/bin/sh\nprintf "malformed Git version\\n"\n' >"$STUBS/git"
  chmod 0644 "$STUBS/containerd"
  run_case mixed '' --check-host
  expect_status 1 mixed
  expect_output '"hardVerdict":"requirements-unmet"' mixed
}

test_other_host_prerequisites_and_ancestors() {
  new_case
  printf '#!/bin/sh\ncase "$1" in -s) echo Linux;; -m) echo x86_64;; esac\n' >"$STUBS/uname"
  chmod 0755 "$STUBS/uname"
  run_case wrong-architecture '' --check
  [[ "$RESULT" -ne 0 ]] || fail 'installer accepted the wrong host architecture'
  ! grep -q '^host-prerequisites=pass$' <<<"$OUTPUT" || fail 'wrong architecture reported host prerequisites pass'

  for prerequisite in containerd dockerd git; do
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
  expect_output '^remaining=configuration,enrollment,service-start$' live-install
  run_case reinstall ''
  expect_status 0 live-reinstall
  expect_output '^installation=already-installed$' live-reinstall
  expect_output '^remaining=configuration,enrollment,service-start$' live-reinstall
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

test_live_signal_cleanup() {
  new_case
  local interrupted="${CASE_ROOT}/interrupted-bin"
  cp -a "$STUBS" "$interrupted"
  cat >"$interrupted/install" <<'EOF'
#!/usr/bin/env bash
target=${@: -1}
/usr/bin/install "$@" || exit
if [[ "$target" == /usr/lib/openkit/.nanohost.openkit-install ]]; then
  kill -TERM "$PPID"
fi
EOF
  chmod 0755 "$interrupted/install"
  run_case live-term "$interrupted"
  [[ "$RESULT" -eq 143 ]] || fail "caught live TERM returned status $RESULT instead of 143; stderr=$ERROR"
  [[ ! -e "$LIVE/usr/lib/openkit/.nanohost.openkit-install" ]] || fail 'caught live TERM left its invocation-owned temporary file'
  [[ ! -e "$LIVE/usr/lib/openkit/nanohost" ]] || fail 'caught live TERM published a destination'
  grep -q '^installation=incomplete$' "$CASE_ROOT/live-term.err" || fail "caught live TERM omitted incomplete output; stderr=$ERROR"
}

test_fixed_lock_serialization() {
  new_case
  local lock_fd process status deadline
  local locked="${CASE_ROOT}/locked-bin"
  cp -a "$STUBS" "$locked"
  cat >"$locked/flock" <<'EOF'
#!/usr/bin/env bash
if /usr/bin/flock -n -x 9; then
  : >"$OPENKIT_INSTALLER_CONTROL/lock-unexpectedly-free"
  exit 98
fi
: >"$OPENKIT_INSTALLER_CONTROL/lock-contended"
exec /usr/bin/flock "$@"
EOF
  chmod 0755 "$locked/flock"
  exec {lock_fd}<"$LIVE/etc/systemd/system"
  flock -x "$lock_fd"
  set +e
  namespace_command "$locked" --check >"$CASE_ROOT/locked.out" 2>"$CASE_ROOT/locked.err" &
  process=$!
  set -e
  deadline=$((SECONDS + 10))
  while [[ ! -e "$CONTROL/lock-contended" && ! -e "$CONTROL/lock-unexpectedly-free" && "$SECONDS" -lt "$deadline" ]]; do sleep 0.01; done
  if [[ -e "$CONTROL/lock-unexpectedly-free" ]] || [[ ! -e "$CONTROL/lock-contended" ]] || ! kill -0 "$process" 2>/dev/null; then
    set +e
    wait "$process"
    status=$?
    set -e
    flock -u "$lock_fd"
    exec {lock_fd}<&-
    fail "installer did not attempt the mapped /etc/systemd/system lock: status $status"
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
test_capability_host_requirements
test_other_host_prerequisites_and_ancestors
test_live_completion_output
test_partial_cleanup
test_interrupted_resume_and_symlink_rejection
test_live_signal_cleanup
test_fixed_lock_serialization
test_noncooperating_publication_race
finish
