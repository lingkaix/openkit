#!/bin/sh
# Execute one L0-L2 shard command and retain local disk-pressure evidence for disk-sensitive shards.
if [ "$#" -lt 2 ]; then
  printf '%s\n' 'Usage: sh scripts/ci-shard-run.sh SHARD_ID COMMAND [ARG...]' >&2
  exit 2
fi

shard_id=$1
shift

case "${shard_id}" in
  static | native-nanohost | nanocore-*) ;;
  *) exec "$@" ;;
esac

# A short write raises SIGXFSZ. Ignore it so the write fails and the previous marker stays complete.
trap '' XFSZ

evidence_dir='temp/ci-shards'
state_file="${evidence_dir}/${shard_id}-execution-state.txt"
evidence_file="${evidence_dir}/${shard_id}-disk-evidence.log"
workspace=${GITHUB_WORKSPACE:-$PWD}
temporary=${TMPDIR:-/tmp}
capture_ok=0
capture_noted=0

note_capture_failure() {
  if [ "${capture_noted}" -eq 1 ]; then
    return 0
  fi
  capture_noted=1
  printf '%s\n' 'evidence capture failed' >&2
}

if mkdir -p "${evidence_dir}" 2>/dev/null && [ -w "${evidence_dir}" ]; then
  capture_ok=1
else
  note_capture_failure
fi

# Write the full marker to a new file, then replace the previous marker only when that write is complete.
write_state() {
  payload=$1
  tmp="${state_file}.tmp"
  if [ "${capture_ok}" -ne 1 ]; then
    note_capture_failure
    return 1
  fi
  rm -f "${tmp}" 2>/dev/null || true
  if printf '%s\n' "${payload}" >"${tmp}" 2>/dev/null; then
    actual=$(wc -c <"${tmp}" | tr -d '[:space:]')
    expected=$(printf '%s\n' "${payload}" | wc -c | tr -d '[:space:]')
    if [ "${actual}" = "${expected}" ] && mv "${tmp}" "${state_file}" 2>/dev/null; then
      return 0
    fi
  fi
  rm -f "${tmp}" 2>/dev/null || true
  note_capture_failure
  return 1
}

append_line() {
  if [ "${capture_ok}" -ne 1 ]; then
    return 1
  fi
  if ! printf '%s\n' "$1" >>"${evidence_file}" 2>/dev/null; then
    note_capture_failure
    return 1
  fi
}

# df and du text can contain paths and permission names. Keep only a fixed label and numbers.
df_numbers() {
  raw=$(df -P "$1" "$2" 2>/dev/null) || return 1
  printf '%s\n' "${raw}" | awk 'NR==2 { print $2, $3, $4 }'
}

record_volume() {
  label=$1
  target=$2
  bytes=$(df_numbers -B1 "${target}") || bytes=''
  case "${bytes}" in
    '' | *[!0-9\ ]*)
      append_line "df -B1 ${label} status=unavailable" || true
      ;;
    *)
      size=${bytes%% *}
      rest=${bytes#* }
      used=${rest%% *}
      avail=${rest#* }
      append_line "df -B1 ${label} size=${size} used=${used} avail=${avail}" || true
      ;;
  esac
  inodes=$(df_numbers -i "${target}") || inodes=''
  case "${inodes}" in
    '' | *[!0-9\ ]*)
      append_line "df -i ${label} status=unavailable" || true
      ;;
    *)
      total=${inodes%% *}
      rest=${inodes#* }
      used=${rest%% *}
      free=${rest#* }
      append_line "df -i ${label} inodes=${total} iused=${used} ifree=${free}" || true
      ;;
  esac
}

du_bytes() {
  raw=$(du -sb "$1" 2>/dev/null) || return 1
  printf '%s\n' "${raw}" | awk 'NR==1 { print $1 }'
}

record_dir() {
  label=$1
  target=$2
  bytes=$(du_bytes "${target}") || bytes=''
  case "${bytes}" in
    '' | *[!0-9]*)
      append_line "du -sb ${label} status=unavailable" || true
      ;;
    *)
      append_line "du -sb ${label} bytes=${bytes}" || true
      ;;
  esac
}

record_df() {
  phase=$1
  append_line "--- ${phase} $(date -u +%Y-%m-%dT%H:%M:%SZ) ---" || true
  record_volume root /
  record_volume workspace "${workspace}"
  record_volume temporary "${temporary}"
}

record_sizes() {
  phase=$1
  append_line "--- ${phase} directory bytes $(date -u +%Y-%m-%dT%H:%M:%SZ) ---" || true
  record_dir .turbo .turbo
  record_dir target target
  record_dir apps/nanohost/target apps/nanohost/target
  record_dir temporary "${temporary}"
}

sampler_pid=''
if [ "${capture_ok}" -eq 1 ]; then
  write_state 'execution_result=incomplete' || true
  record_df before
  record_sizes before
  sleep_pid_file="${evidence_dir}/${shard_id}-sampler-sleep.pid"
  (
    while :; do
      sleep 15 &
      sleep_pid=$!
      printf '%s\n' "${sleep_pid}" >"${sleep_pid_file}" || exit 0
      wait "${sleep_pid}" || exit 0
      record_df sample
    done
  ) &
  sampler_pid=$!
fi

"$@"
status=$?

if [ -n "${sampler_pid}" ]; then
  kill "${sampler_pid}" 2>/dev/null || true
  if [ -r "${sleep_pid_file}" ]; then
    sleep_pid=$(cat "${sleep_pid_file}")
    case "${sleep_pid}" in
      '' | *[!0-9]*) ;;
      *) kill "${sleep_pid}" 2>/dev/null || true ;;
    esac
  fi
  wait "${sampler_pid}" 2>/dev/null || true
  rm -f "${sleep_pid_file}"
  record_df after
  record_sizes after
  if [ "${status}" -eq 0 ]; then
    result=completed
  else
    result=failed
  fi
  payload=$(printf 'execution_result=%s\nexit_status=%s' "${result}" "${status}")
  write_state "${payload}" || true
fi
exit "${status}"
