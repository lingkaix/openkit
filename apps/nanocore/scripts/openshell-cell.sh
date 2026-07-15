#!/usr/bin/env bash
set -Eeuo pipefail

readonly EXPECTED_VERSION='0.0.80'
readonly HELPER_ROOT='/var/lib/openkit/openshell-cell'
readonly EPOCH_ROOT="${HELPER_ROOT}/epochs"
readonly IMAGE_CACHE="${HELPER_ROOT}/image-cache"
readonly RUN_ROOT='/run/openkit/openshell-cell'
readonly RUN_EPOCH_ROOT="${RUN_ROOT}/epochs"
readonly MARKER="${HELPER_ROOT}/active"
readonly COUNTER="${HELPER_ROOT}/epoch-counter"
readonly LOCK='/run/lock/openkit-openshell-cell.lock'
readonly CELL_SLICE='openkit-openshell-cell.slice'
readonly GATEWAY_URL='http://127.0.0.1:17670'
readonly HEALTH_URL='http://127.0.0.1:17671/readyz'
readonly SUPERVISOR_IMAGE='ghcr.io/nvidia/openshell/supervisor:709aa0fe3e9e4d2b5fea336b5d6e393b45481898'
readonly IDLE_OWNER='-'
readonly OWNER_PATTERN='^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$'
readonly BOOT_ID_PATTERN='^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
readonly CLEANUP_PHASE_PATTERN='^(live|fenced)$'
readonly CLEANUP_BRIDGE_PATTERN='^(-|br-[a-f0-9]{12})$'
readonly BOOT_ID_FILE='/proc/sys/kernel/random/boot_id'

# A full recycle has at most 540 seconds of command and phase wait budgets.
# The controller allows 600 seconds, leaving at least 60 seconds for process cleanup.
readonly COMMAND_TIMEOUT_SECONDS=5
readonly DOCKER_CLEANUP_TIMEOUT_SECONDS=15
readonly DOCKER_READY_BUDGET_SECONDS=30
readonly GATEWAY_READY_BUDGET_SECONDS=30
readonly IMAGE_LOAD_BUDGET_SECONDS=120
readonly ROOT_REMOVAL_TIMEOUT_SECONDS=20
readonly SERVICE_STOP_TIMEOUT_SECONDS=10
readonly SLICE_STOP_BUDGET_SECONDS=20

readonly OPEN_SHELL='/usr/bin/openshell'
readonly GATEWAY='/usr/bin/openshell-gateway'
readonly CONTAINERD='/usr/bin/containerd'
readonly DOCKERD='/usr/bin/dockerd'
readonly DOCKER='/usr/bin/docker'
readonly SYSTEMCTL='/usr/bin/systemctl'
readonly SYSTEMD_RUN='/usr/bin/systemd-run'
readonly CURL='/usr/bin/curl'
readonly FLOCK='/usr/bin/flock'
readonly INSTALL='/usr/bin/install'
readonly MV='/usr/bin/mv'
readonly RM='/usr/bin/rm'
readonly SLEEP='/usr/bin/sleep'
readonly TIMEOUT='/usr/bin/timeout'
readonly UNAME='/usr/bin/uname'

export PATH='/usr/sbin:/usr/bin:/sbin:/bin'
unset DOCKER_CERT_PATH DOCKER_CONTEXT DOCKER_HOST DOCKER_TLS_VERIFY
unset OPENSHELL_GATEWAY OPENSHELL_GATEWAY_ENDPOINT OPENSHELL_GATEWAY_INSECURE

PARTIAL_EPOCH=''

# Prints a bounded operator error and exits unsuccessfully.
fail() {
  printf 'openkit-openshell-cell: %s\n' "$1" >&2
  exit 1
}

# Reads and validates the current kernel boot identity without evaluating content.
read_boot_id() {
  IFS= read -r CURRENT_BOOT_ID <"$BOOT_ID_FILE" || fail 'kernel boot identity is unreadable.'
  [[ "$CURRENT_BOOT_ID" =~ $BOOT_ID_PATTERN ]] || fail 'kernel boot identity is invalid.'
}

# Reports whether one systemd unit is active and fails closed on control-plane errors.
unit_is_active() {
  local unit="$1" status

  if "$TIMEOUT" --kill-after=2 "$COMMAND_TIMEOUT_SECONDS" \
    "$SYSTEMCTL" is-active --quiet "$unit"; then
    return 0
  else
    status=$?
  fi
  case "$status" in
    3|4) return 1 ;;
    *) fail 'systemd unit state inspection failed.' ;;
  esac
}

# Verifies the fixed host command surface and official OpenShell version.
preflight() {
  local binary output expected_name

  [[ -d /run/systemd/system ]] || fail 'systemd is required.'
  for binary in \
    "$OPEN_SHELL" "$GATEWAY" "$CONTAINERD" "$DOCKERD" "$DOCKER" \
    "$SYSTEMCTL" "$SYSTEMD_RUN" "$CURL" "$FLOCK" \
    "$INSTALL" "$MV" "$RM" "$SLEEP" "$TIMEOUT" "$UNAME"; do
    [[ -x "$binary" ]] || fail "required executable is missing: ${binary}"
  done

  for binary in "$OPEN_SHELL" "$GATEWAY"; do
    output="$("$TIMEOUT" --kill-after=2 "$COMMAND_TIMEOUT_SECONDS" \
      "$binary" --version 2>/dev/null)" || fail 'OpenShell version check failed.'
    expected_name="${binary##*/}"
    [[ "$output" == "${expected_name} ${EXPECTED_VERSION}" ]] \
      || fail "${expected_name} must report exactly '${expected_name} ${EXPECTED_VERSION}'."
  done
}

# Atomically records epoch ownership and retry-safe cleanup state.
write_marker() {
  local epoch="$1" active_owner="$2" last_recycled_owner="$3" boot_id="$4"
  local cleanup_phase="$5" cleanup_bridge="$6"
  local temporary="${MARKER}.tmp.$$"

  [[ "$epoch" =~ ^[1-9][0-9]{0,8}$ ]] || fail 'refusing an invalid Cell epoch.'
  [[ "$active_owner" == "$IDLE_OWNER" || "$active_owner" =~ $OWNER_PATTERN ]] \
    || fail 'refusing an invalid active owner marker.'
  [[ "$last_recycled_owner" == "$IDLE_OWNER" || "$last_recycled_owner" =~ $OWNER_PATTERN ]] \
    || fail 'refusing an invalid recycled owner marker.'
  [[ "$boot_id" =~ $BOOT_ID_PATTERN ]] || fail 'refusing an invalid boot identity marker.'
  [[ "$cleanup_phase" =~ $CLEANUP_PHASE_PATTERN ]] \
    || fail 'refusing an invalid cleanup phase marker.'
  [[ "$cleanup_bridge" =~ $CLEANUP_BRIDGE_PATTERN ]] \
    || fail 'refusing an invalid cleanup bridge marker.'
  (umask 077; printf '%s\n%s\n%s\n%s\n%s\n%s\n' \
    "$epoch" "$active_owner" "$last_recycled_owner" "$boot_id" \
    "$cleanup_phase" "$cleanup_bridge" >"$temporary")
  "$MV" -f -- "$temporary" "$MARKER"
}

# Reads and validates the cleanup-retry marker without evaluating its content.
read_marker() {
  local -a fields=()

  [[ -f "$MARKER" ]] || return 1
  mapfile -t fields <"$MARKER"
  [[ "${#fields[@]}" -eq 6 ]] || fail 'Cell marker is malformed.'
  ACTIVE_EPOCH="${fields[0]}"
  ACTIVE_OWNER="${fields[1]}"
  LAST_RECYCLED_OWNER="${fields[2]}"
  ACTIVE_BOOT_ID="${fields[3]}"
  ACTIVE_CLEANUP_PHASE="${fields[4]}"
  ACTIVE_CLEANUP_BRIDGE="${fields[5]}"
  [[ "$ACTIVE_EPOCH" =~ ^[1-9][0-9]{0,8}$ ]] || fail 'Cell marker epoch is invalid.'
  [[ "$ACTIVE_OWNER" == "$IDLE_OWNER" || "$ACTIVE_OWNER" =~ $OWNER_PATTERN ]] \
    || fail 'Cell marker owner is invalid.'
  [[ "$LAST_RECYCLED_OWNER" == "$IDLE_OWNER" || "$LAST_RECYCLED_OWNER" =~ $OWNER_PATTERN ]] \
    || fail 'Cell marker recycle owner is invalid.'
  [[ "$ACTIVE_BOOT_ID" =~ $BOOT_ID_PATTERN ]] || fail 'Cell marker boot identity is invalid.'
  [[ "$ACTIVE_CLEANUP_PHASE" =~ $CLEANUP_PHASE_PATTERN ]] \
    || fail 'Cell marker cleanup phase is invalid.'
  [[ "$ACTIVE_CLEANUP_BRIDGE" =~ $CLEANUP_BRIDGE_PATTERN ]] \
    || fail 'Cell marker cleanup bridge is invalid.'
}

# Allocates a monotonic numeric epoch from state outside disposable roots.
next_epoch() {
  local current=0 temporary="${COUNTER}.tmp.$$"

  if [[ -f "$COUNTER" ]]; then
    IFS= read -r current <"$COUNTER" || fail 'Cell epoch counter is unreadable.'
    [[ "$current" =~ ^[0-9]{1,9}$ ]] || fail 'Cell epoch counter is invalid.'
  fi
  (( current < 999999999 )) || fail 'Cell epoch counter is exhausted.'
  NEXT_EPOCH=$((10#$current + 1))
  (umask 077; printf '%s\n' "$NEXT_EPOCH" >"$temporary")
  "$MV" -f -- "$temporary" "$COUNTER"
}

# Waits for the dedicated Docker daemon to accept commands.
wait_for_docker() {
  local socket="$1" docker_config="$2" deadline remaining

  deadline=$((SECONDS + DOCKER_READY_BUDGET_SECONDS))
  while (( SECONDS < deadline )); do
    remaining=$((deadline - SECONDS))
    if DOCKER_CONFIG="$docker_config" DOCKER_HOST="unix://${socket}" \
      "$TIMEOUT" --kill-after=2 "$remaining" "$DOCKER" info >/dev/null 2>&1; then
      return
    fi
    (( SECONDS < deadline )) && "$SLEEP" 1
  done
  fail 'dedicated Docker daemon did not become ready.'
}

# Waits for the stock Gateway readiness endpoint.
wait_for_gateway() {
  local epoch="$1" deadline remaining
  local gateway_unit="openkit-openshell-cell-${epoch}-gateway.service"

  deadline=$((SECONDS + GATEWAY_READY_BUDGET_SECONDS))
  while (( SECONDS < deadline )); do
    unit_is_active "$gateway_unit" || fail 'epoch Gateway service is not active.'
    remaining=$((deadline - SECONDS))
    if "$TIMEOUT" --kill-after=2 "$remaining" "$CURL" --connect-timeout 2 \
      --max-time "$remaining" --fail --silent --show-error "$HEALTH_URL" >/dev/null 2>&1; then
      return
    fi
    (( SECONDS < deadline )) && "$SLEEP" 1
  done
  fail 'stock OpenShell Gateway did not become ready.'
}

# Proves that one fresh epoch has no Docker containers or OpenShell sandboxes.
verify_empty() {
  local epoch="$1" containers sandboxes
  local socket="${RUN_EPOCH_ROOT}/${epoch}/docker.sock"
  local state="${EPOCH_ROOT}/${epoch}"

  containers="$(DOCKER_CONFIG="${state}/docker-config" DOCKER_HOST="unix://${socket}" \
    "$TIMEOUT" --kill-after=2 10 "$DOCKER" ps --all --quiet)" \
    || fail 'Docker emptiness check failed.'
  [[ -z "$containers" ]] || fail 'replacement Docker runtime is not empty.'
  sandboxes="$(HOME="${state}/home" XDG_CONFIG_HOME="${state}/cli-config" \
    XDG_STATE_HOME="${state}/cli-state" XDG_DATA_HOME="${state}/cli-data" \
    XDG_CACHE_HOME="${state}/cli-cache" \
    "$TIMEOUT" --kill-after=2 15 "$OPEN_SHELL" \
      --gateway-endpoint "$GATEWAY_URL" sandbox list --names)" \
    || fail 'OpenShell emptiness check failed.'
  [[ -z "$sandboxes" ]] || fail 'replacement OpenShell Gateway is not empty.'
  unit_is_active "openkit-openshell-cell-${epoch}-gateway.service" \
    || fail 'epoch Gateway service stopped during emptiness verification.'
}

# Enables and verifies the stock Providers v2 setting required by trusted relay packages.
enable_providers_v2() {
  local epoch="$1" settings state="${EPOCH_ROOT}/${epoch}"

  HOME="${state}/home" XDG_CONFIG_HOME="${state}/cli-config" \
    XDG_STATE_HOME="${state}/cli-state" XDG_DATA_HOME="${state}/cli-data" \
    XDG_CACHE_HOME="${state}/cli-cache" \
    "$TIMEOUT" --kill-after=2 15 "$OPEN_SHELL" --gateway-endpoint "$GATEWAY_URL" \
      settings set --global --key providers_v2_enabled --value true --yes >/dev/null \
    || fail 'OpenShell Providers v2 activation failed.'
  settings="$(HOME="${state}/home" XDG_CONFIG_HOME="${state}/cli-config" \
    XDG_STATE_HOME="${state}/cli-state" XDG_DATA_HOME="${state}/cli-data" \
    XDG_CACHE_HOME="${state}/cli-cache" \
    "$TIMEOUT" --kill-after=2 15 "$OPEN_SHELL" --gateway-endpoint "$GATEWAY_URL" \
      settings get --global --json)" \
    || fail 'OpenShell Providers v2 verification failed.'
  [[ "$settings" =~ \"providers_v2_enabled\"[[:space:]]*:[[:space:]]*\"true\" ]] \
    || fail 'OpenShell Providers v2 did not remain enabled.'
}

# Best-effort tears down a failed start while retaining its owner marker for retry.
cleanup_partial_epoch() {
  local original_status="$1"

  trap - EXIT
  set +e
  if [[ "$PARTIAL_EPOCH" =~ ^[1-9][0-9]{0,8}$ ]]; then
    (stop_epoch "$PARTIAL_EPOCH") >/dev/null 2>&1
  fi
  exit "$original_status"
}

# Starts one fresh epoch after recording its cleanup owner.
start_epoch() {
  local owner="$1" epoch state run containerd_socket docker_socket config
  local containerd_unit dockerd_unit gateway_unit archive supervisor_id expected_supervisor_id
  local image_deadline remaining

  next_epoch
  epoch="$NEXT_EPOCH"
  state="${EPOCH_ROOT}/${epoch}"
  run="${RUN_EPOCH_ROOT}/${epoch}"
  containerd_socket="${run}/containerd.sock"
  docker_socket="${run}/docker.sock"
  config="${state}/gateway.toml"
  containerd_unit="openkit-openshell-cell-${epoch}-containerd"
  dockerd_unit="openkit-openshell-cell-${epoch}-dockerd"
  gateway_unit="openkit-openshell-cell-${epoch}-gateway"

  PARTIAL_EPOCH="$epoch"
  trap 'cleanup_partial_epoch "$?"' EXIT
  "$INSTALL" -d -o root -g root -m 0700 \
    "$state" "${state}/containerd-root" "${state}/docker-root" \
    "${state}/cli-config" "${state}/cli-state" "${state}/docker-config" \
    "${state}/home" "$run" \
    "${run}/containerd-state" "${run}/docker-exec"
  read_boot_id
  (umask 077; printf '%s\n' "$CURRENT_BOOT_ID" >"${state}/boot-id")
  write_marker "$epoch" "$owner" "$IDLE_OWNER" "$CURRENT_BOOT_ID" 'live' '-'
  HOME="${state}/home" XDG_CONFIG_HOME="${state}/certgen-config" \
    "$TIMEOUT" --kill-after=2 "$COMMAND_TIMEOUT_SECONDS" "$GATEWAY" generate-certs \
      --output-dir "${state}/pki" --server-san 127.0.0.1 \
      --server-san host.openshell.internal >/dev/null

  "$TIMEOUT" --kill-after=2 "$COMMAND_TIMEOUT_SECONDS" "$SYSTEMD_RUN" --quiet --collect \
    --unit="$containerd_unit" --slice="$CELL_SLICE" --service-type=exec \
    --property=Delegate=yes --property=KillMode=control-group -- "$CONTAINERD" \
    --address "$containerd_socket" --root "${state}/containerd-root" \
    --state "${run}/containerd-state"

  "$TIMEOUT" --kill-after=2 "$COMMAND_TIMEOUT_SECONDS" "$SYSTEMD_RUN" --quiet --collect \
    --unit="$dockerd_unit" --slice="$CELL_SLICE" --service-type=exec \
    --property=Delegate=yes --property=KillMode=control-group -- "$DOCKERD" \
    --host "unix://${docker_socket}" --data-root "${state}/docker-root" \
    --exec-root "${run}/docker-exec" --pidfile "${run}/docker.pid" \
    --containerd "$containerd_socket" --containerd-namespace "openkit-${epoch}" \
    --containerd-plugins-namespace "openkit-plugins-${epoch}" \
    --cgroup-parent "$CELL_SLICE" --bridge none \
    --default-address-pool 'base=10.231.0.0/16,size=24'
  wait_for_docker "$docker_socket" "${state}/docker-config"

  image_deadline=$((SECONDS + IMAGE_LOAD_BUDGET_SECONDS))
  for archive in "$IMAGE_CACHE"/*.tar; do
    [[ -e "$archive" ]] || continue
    remaining=$((image_deadline - SECONDS))
    (( remaining > 0 )) || fail 'Cell image-cache loading timed out.'
    DOCKER_CONFIG="${state}/docker-config" DOCKER_HOST="unix://${docker_socket}" \
      "$TIMEOUT" --kill-after=2 "$remaining" "$DOCKER" image load --input "$archive" \
        >/dev/null || fail 'Cell image-cache loading failed.'
  done
  [[ "$("$TIMEOUT" --kill-after=2 "$COMMAND_TIMEOUT_SECONDS" "$UNAME" -m)" == 'aarch64' ]] \
    || fail 'stock supervisor image is pinned only for the A1 arm64 runtime.'
  expected_supervisor_id='sha256:d87e54175490a7dc5e75daef1c4aaf43955cf3fc3945827e4f03698ea99faadb'
  supervisor_id="$(DOCKER_CONFIG="${state}/docker-config" \
    DOCKER_HOST="unix://${docker_socket}" "$TIMEOUT" --kill-after=2 \
    "$COMMAND_TIMEOUT_SECONDS" "$DOCKER" image inspect \
    --format '{{.Id}}' "$SUPERVISOR_IMAGE")" || fail 'stock supervisor image is missing.'
  [[ "$supervisor_id" == "$expected_supervisor_id" ]] \
    || fail 'stock supervisor image identity does not match OpenShell 0.0.80.'

  printf '%s\n' \
    '[openshell]' \
    'version = 1' \
    '' \
    '[openshell.gateway]' \
    'compute_drivers = ["docker"]' \
    'disable_tls = true' \
    '' \
    '[openshell.gateway.auth]' \
    'allow_unauthenticated_users = true' \
    '' \
    '[openshell.gateway.gateway_jwt]' \
    "signing_key_path = \"${state}/pki/jwt/signing.pem\"" \
    "public_key_path = \"${state}/pki/jwt/public.pem\"" \
    "kid_path = \"${state}/pki/jwt/kid\"" \
    "gateway_id = \"openkit-cell-${epoch}\"" \
    'ttl_secs = 0' \
    '' \
    '[openshell.drivers.docker]' \
    "sandbox_namespace = \"openkit-cell-${epoch}\"" \
    "network_name = \"openkit-cell-${epoch}\"" \
    "supervisor_image = \"${SUPERVISOR_IMAGE}\"" \
    'enable_bind_mounts = true' \
    >"$config"

  "$TIMEOUT" --kill-after=2 "$COMMAND_TIMEOUT_SECONDS" "$SYSTEMD_RUN" --quiet --collect \
    --unit="$gateway_unit" --slice="$CELL_SLICE" --service-type=exec \
    --property=KillMode=control-group \
    --setenv="DOCKER_HOST=unix://${docker_socket}" \
    --setenv="XDG_CONFIG_HOME=${state}/gateway-config" \
    --setenv="XDG_STATE_HOME=${state}/gateway-state" \
    --setenv="XDG_DATA_HOME=${state}/gateway-data" \
    --setenv="XDG_CACHE_HOME=${state}/gateway-cache" --setenv="HOME=${state}/home" -- \
    "$GATEWAY" --config "$config" --bind-address 127.0.0.1 --port 17670 \
    --health-port 17671 --drivers docker --disable-tls \
    --db-url "sqlite:${state}/gateway.db?mode=rwc"
  wait_for_gateway "$epoch"
  enable_providers_v2 "$epoch"
  verify_empty "$epoch"
  STARTED_EPOCH="$epoch"
  PARTIAL_EPOCH=''
  trap - EXIT
}

# Fences the complete fixed slice, proves Docker cleanup, and discards one epoch.
stop_epoch() {
  local epoch="$1" procs control_group='' cgroup_path='' network_id='' bridge=''
  local containers_output='' network_names='' stored_boot_id bridge_path bridge_name deadline
  local state="${EPOCH_ROOT}/${epoch}" run="${RUN_EPOCH_ROOT}/${epoch}"
  local docker_socket="${RUN_EPOCH_ROOT}/${epoch}/docker.sock"
  local gateway_unit="openkit-openshell-cell-${epoch}-gateway.service"
  local dockerd_unit="openkit-openshell-cell-${epoch}-dockerd.service"
  local containerd_unit="openkit-openshell-cell-${epoch}-containerd.service"
  local -a cgroup_procs=() containers=()
  local -A allowed_bridges=()

  [[ "$epoch" =~ ^[1-9][0-9]{0,8}$ ]] || fail 'refusing to stop an invalid Cell epoch.'
  read_marker || fail 'Cell marker is missing during cleanup.'
  [[ "$ACTIVE_EPOCH" == "$epoch" ]] || fail 'Cell marker epoch changed during cleanup.'
  stored_boot_id="$ACTIVE_BOOT_ID"
  read_boot_id
  control_group="$("$TIMEOUT" --kill-after=2 "$COMMAND_TIMEOUT_SECONDS" \
    "$SYSTEMCTL" show "$CELL_SLICE" --property=ControlGroup --value 2>/dev/null)" \
    || fail 'Cell slice control group inspection failed.'
  if [[ -n "$control_group" ]]; then
    [[ "$control_group" =~ ^/[A-Za-z0-9_.@-]+(/[A-Za-z0-9_.@-]+)*$ ]] \
      || fail 'Cell slice reported an invalid control group.'
    [[ "${control_group##*/}" == "$CELL_SLICE" ]] \
      || fail 'Cell slice reported an unexpected control group.'
    cgroup_path="/sys/fs/cgroup${control_group}"
  fi

  if [[ "$ACTIVE_CLEANUP_PHASE" == 'fenced' ]]; then
    ! unit_is_active "$CELL_SLICE" || fail 'fenced Cell slice became active again.'
    if [[ "$ACTIVE_CLEANUP_BRIDGE" != '-' ]]; then
      [[ ! -e "/sys/class/net/${ACTIVE_CLEANUP_BRIDGE}" ]] \
        || fail 'fenced epoch Docker bridge became active again.'
    fi
    if [[ -n "$cgroup_path" && -d "$cgroup_path" ]]; then
      shopt -s globstar nullglob
      cgroup_procs=("$cgroup_path"/**/cgroup.procs)
      shopt -u globstar nullglob
      for procs in "${cgroup_procs[@]}"; do
        [[ -z "$(<"$procs")" ]] || fail 'fenced Cell cgroup owns processes.'
      done
    fi
    "$TIMEOUT" --kill-after=2 "$ROOT_REMOVAL_TIMEOUT_SECONDS" \
      "$RM" -rf -- "${state:?}" "${run:?}" || fail 'epoch mutable-root cleanup failed.'
    return
  fi

  "$TIMEOUT" --kill-after=2 "$SERVICE_STOP_TIMEOUT_SECONDS" \
    "$SYSTEMCTL" stop "$gateway_unit" >/dev/null 2>&1 || true
  if unit_is_active "$gateway_unit"; then
    "$TIMEOUT" --kill-after=2 "$COMMAND_TIMEOUT_SECONDS" "$SYSTEMCTL" \
      kill --kill-whom=all --signal=SIGKILL "$gateway_unit" >/dev/null 2>&1 || true
  fi
  ! unit_is_active "$gateway_unit" || fail 'epoch Gateway service did not stop.'

  shopt -s nullglob
  for bridge_path in /sys/class/net/br-*; do
    allowed_bridges["${bridge_path##*/}"]=1
  done
  shopt -u nullglob

  if [[ "$stored_boot_id" == "$CURRENT_BOOT_ID" ]]; then
    [[ -S "$docker_socket" ]] || fail 'dedicated Docker state is unavailable for cleanup.'
    DOCKER_CONFIG="${state}/docker-config" DOCKER_HOST="unix://${docker_socket}" \
      "$TIMEOUT" --kill-after=2 "$COMMAND_TIMEOUT_SECONDS" "$DOCKER" info >/dev/null 2>&1 \
      || fail 'dedicated Docker state is unavailable for cleanup.'
    if network_id="$(DOCKER_CONFIG="${state}/docker-config" \
      DOCKER_HOST="unix://${docker_socket}" "$TIMEOUT" --kill-after=2 \
      "$COMMAND_TIMEOUT_SECONDS" "$DOCKER" network inspect --format '{{.Id}}' \
      "openkit-cell-${epoch}" 2>/dev/null)"; then
      [[ "$network_id" =~ ^[a-f0-9]{64}$ ]] || fail 'epoch Docker network id is invalid.'
      bridge="br-${network_id:0:12}"
      unset 'allowed_bridges[$bridge]'
    else
      network_names="$(DOCKER_CONFIG="${state}/docker-config" \
        DOCKER_HOST="unix://${docker_socket}" "$TIMEOUT" --kill-after=2 \
        "$COMMAND_TIMEOUT_SECONDS" "$DOCKER" network ls \
        --filter "name=^openkit-cell-${epoch}$" --format '{{.Name}}')" \
        || fail 'epoch Docker network inspection failed.'
      [[ -z "$network_names" ]] || fail 'epoch Docker network inspection failed.'
    fi
    containers_output="$(DOCKER_CONFIG="${state}/docker-config" \
      DOCKER_HOST="unix://${docker_socket}" "$TIMEOUT" --kill-after=2 \
      "$COMMAND_TIMEOUT_SECONDS" "$DOCKER" ps --all --quiet)" \
      || fail 'epoch Docker container listing failed.'
    if [[ -n "$containers_output" ]]; then
      mapfile -t containers <<<"$containers_output"
      DOCKER_CONFIG="${state}/docker-config" DOCKER_HOST="unix://${docker_socket}" \
        "$TIMEOUT" --kill-after=2 "$DOCKER_CLEANUP_TIMEOUT_SECONDS" \
        "$DOCKER" rm --force "${containers[@]}" >/dev/null \
        || fail 'epoch Docker container cleanup failed.'
    fi
    if [[ -n "$network_id" ]]; then
      DOCKER_CONFIG="${state}/docker-config" DOCKER_HOST="unix://${docker_socket}" \
        "$TIMEOUT" --kill-after=2 "$DOCKER_CLEANUP_TIMEOUT_SECONDS" \
        "$DOCKER" network rm "openkit-cell-${epoch}" >/dev/null \
        || fail 'epoch Docker network cleanup failed.'
    fi
    network_names="$(DOCKER_CONFIG="${state}/docker-config" \
      DOCKER_HOST="unix://${docker_socket}" "$TIMEOUT" --kill-after=2 \
      "$COMMAND_TIMEOUT_SECONDS" "$DOCKER" network ls \
      --filter "name=^openkit-cell-${epoch}$" --format '{{.Name}}')" \
      || fail 'epoch Docker network verification failed.'
    [[ -z "$network_names" ]] || fail 'epoch Docker network remains registered.'
  fi

  "$TIMEOUT" --kill-after=2 "$SERVICE_STOP_TIMEOUT_SECONDS" \
    "$SYSTEMCTL" stop "$dockerd_unit" >/dev/null 2>&1 || true
  "$TIMEOUT" --kill-after=2 "$SERVICE_STOP_TIMEOUT_SECONDS" \
    "$SYSTEMCTL" stop "$containerd_unit" >/dev/null 2>&1 || true
  "$TIMEOUT" --kill-after=2 "$COMMAND_TIMEOUT_SECONDS" "$SYSTEMCTL" \
    kill --kill-whom=all --signal=SIGKILL "$CELL_SLICE" >/dev/null 2>&1 || true
  "$TIMEOUT" --kill-after=2 "$COMMAND_TIMEOUT_SECONDS" "$SYSTEMCTL" \
    --no-block stop "$CELL_SLICE" >/dev/null 2>&1 || true
  deadline=$((SECONDS + SLICE_STOP_BUDGET_SECONDS))
  while unit_is_active "$CELL_SLICE"; do
    (( SECONDS < deadline )) || fail 'Cell slice did not stop.'
    "$SLEEP" 1
  done
  if [[ -n "$cgroup_path" && -d "$cgroup_path" ]]; then
    shopt -s globstar nullglob
    cgroup_procs=("$cgroup_path"/**/cgroup.procs)
    shopt -u globstar nullglob
    for procs in "${cgroup_procs[@]}"; do
      [[ -z "$(<"$procs")" ]] || fail 'Cell cgroup still owns processes.'
    done
  fi

  if [[ -n "$bridge" ]]; then
    [[ ! -e "/sys/class/net/${bridge}" ]] || fail 'epoch Docker bridge remains present.'
  fi
  shopt -s nullglob
  for bridge_path in /sys/class/net/br-*; do
    bridge_name="${bridge_path##*/}"
    [[ -n "${allowed_bridges[$bridge_name]+present}" ]] \
      || fail 'epoch Docker bridge was recreated during teardown.'
  done
  shopt -u nullglob
  write_marker "$epoch" "$ACTIVE_OWNER" "$LAST_RECYCLED_OWNER" "$stored_boot_id" \
    'fenced' "${bridge:--}"
  "$TIMEOUT" --kill-after=2 "$ROOT_REMOVAL_TIMEOUT_SECONDS" \
    "$RM" -rf -- "${state:?}" "${run:?}" || fail 'epoch mutable-root cleanup failed.'
}

# Claims an idle Cell or starts a fresh owner-bound epoch.
prepare_cell() {
  local owner="$1"

  if read_marker; then
    [[ "$ACTIVE_OWNER" == "$IDLE_OWNER" ]] || fail 'Cell already has an active owner.'
    if [[ "$ACTIVE_CLEANUP_PHASE" == 'live' ]] && \
      unit_is_active "openkit-openshell-cell-${ACTIVE_EPOCH}-gateway.service"; then
      write_marker "$ACTIVE_EPOCH" "$owner" "$IDLE_OWNER" "$ACTIVE_BOOT_ID" 'live' '-'
      wait_for_gateway "$ACTIVE_EPOCH"
      verify_empty "$ACTIVE_EPOCH"
      return
    fi
    stop_epoch "$ACTIVE_EPOCH"
  fi
  start_epoch "$owner"
}

# Recycles an owner-bound Cell and leaves a retry-safe verified idle replacement.
recycle_cell() {
  local owner="$1"

  if read_marker; then
    if [[ "$ACTIVE_OWNER" == "$IDLE_OWNER" ]]; then
      [[ "$LAST_RECYCLED_OWNER" == "$owner" ]] || fail 'Cell recycle owner does not match.'
      if [[ "$ACTIVE_CLEANUP_PHASE" == 'live' ]] && \
        unit_is_active "openkit-openshell-cell-${ACTIVE_EPOCH}-gateway.service"; then
        wait_for_gateway "$ACTIVE_EPOCH"
        verify_empty "$ACTIVE_EPOCH"
        "$SLEEP" 10
        verify_empty "$ACTIVE_EPOCH"
        return
      fi
      stop_epoch "$ACTIVE_EPOCH"
    else
      [[ "$ACTIVE_OWNER" == "$owner" ]] || fail 'Cell recycle owner does not match.'
      stop_epoch "$ACTIVE_EPOCH"
    fi
  fi

  start_epoch "$owner"
  verify_empty "$STARTED_EPOCH"
  "$SLEEP" 10
  verify_empty "$STARTED_EPOCH"
  write_marker "$STARTED_EPOCH" "$IDLE_OWNER" "$owner" "$CURRENT_BOOT_ID" 'live' '-'
}

[[ "${EUID}" -eq 0 ]] || fail 'must run as root.'
[[ "$#" -eq 2 ]] || fail 'usage: openkit-openshell-cell prepare|recycle <owner-id>'
readonly ACTION="$1"
readonly OWNER="$2"
[[ "$OWNER" =~ $OWNER_PATTERN ]] || fail 'owner id is invalid.'
case "$ACTION" in
  prepare|recycle) ;;
  *) fail 'usage: openkit-openshell-cell prepare|recycle <owner-id>' ;;
esac

"$INSTALL" -d -o root -g root -m 0700 "$HELPER_ROOT" "$EPOCH_ROOT" "$RUN_ROOT" "$RUN_EPOCH_ROOT"
"$INSTALL" -d -o root -g root -m 0755 "$IMAGE_CACHE"
exec 9>"$LOCK"
"$FLOCK" -w "$COMMAND_TIMEOUT_SECONDS" -x 9 || fail 'Cell lifecycle lock is busy.'
preflight

case "$ACTION" in
  prepare) prepare_cell "$OWNER" ;;
  recycle) recycle_cell "$OWNER" ;;
esac
