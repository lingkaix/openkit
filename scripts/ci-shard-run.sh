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

evidence_dir='temp/ci-shards'
state_file="${evidence_dir}/${shard_id}-execution-state.txt"
evidence_file="${evidence_dir}/${shard_id}-disk-evidence.log"
workspace=${GITHUB_WORKSPACE:-$PWD}
temporary=${TMPDIR:-/tmp}

mkdir -p "${evidence_dir}" || exit 1
printf '%s\n' 'execution_result=incomplete' >"${state_file}" || exit 1

record_df() {
  phase=$1
  {
    printf '%s\n' "--- ${phase} $(date -u +%Y-%m-%dT%H:%M:%SZ) ---"
    printf '%s\n' "df -B1 / ${workspace} ${temporary}"
    df -B1 / "${workspace}" "${temporary}" 2>&1 || true
    printf '%s\n' "df -i / ${workspace} ${temporary}"
    df -i / "${workspace}" "${temporary}" 2>&1 || true
  } >>"${evidence_file}" 2>&1
}

record_sizes() {
  phase=$1
  {
    printf '%s\n' "--- ${phase} directory bytes $(date -u +%Y-%m-%dT%H:%M:%SZ) ---"
    printf '%s\n' "du -sb .turbo target apps/nanohost/target ${temporary}"
    du -sb .turbo target apps/nanohost/target "${temporary}" 2>&1 || true
  } >>"${evidence_file}" 2>&1
}

record_df before
record_sizes before
sleep_pid_file="${evidence_dir}/${shard_id}-sampler-sleep.pid"
(
  while :; do
    sleep 15 &
    sleep_pid=$!
    printf '%s\n' "${sleep_pid}" >"${sleep_pid_file}"
    wait "${sleep_pid}" || exit 0
    record_df sample
  done
) &
sampler_pid=$!

"$@"
status=$?

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
printf 'execution_result=%s\nexit_status=%s\n' "${result}" "${status}" >"${state_file}"
exit "${status}"
