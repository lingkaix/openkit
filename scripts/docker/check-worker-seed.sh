#!/usr/bin/env bash
# Check every declared VOLUME with the same extractor used by NanoHost attachment.
set -euo pipefail

image="${1:?Usage: scripts/docker/check-worker-seed.sh <image>}"
repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${repo}"
scratch="$(mktemp -d "${TMPDIR:-/tmp}/openkit-worker-seed.XXXXXX")"
container=""
cleanup() {
  if [[ -n "${container}" ]]; then
    docker rm --force --volumes "${container}" >/dev/null 2>&1 || true
  fi
  rm -rf "${scratch}"
}
trap cleanup EXIT

# Compile as the caller; only extraction needs root to preserve image uid/gid.
cargo test --locked --manifest-path apps/nanohost/Cargo.toml --bin nanohost --no-run --message-format=json >"${scratch}/build.jsonl"
extractor="$(node -e '
const fs = require("node:fs");
const artifacts = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").map(JSON.parse);
const tests = artifacts.filter(a => a.reason === "compiler-artifact" && a.target.name === "nanohost" && a.profile.test && a.executable);
if (tests.length !== 1) throw Error("NanoHost test executable missing or ambiguous");
process.stdout.write(tests[0].executable);
' "${scratch}/build.jsonl")"
volumes="$(docker image inspect --format '{{json .Config.Volumes}}' "${image}")"
targets="$(node -e '
const volumes = JSON.parse(process.argv[1]);
const targets = Object.keys(volumes || {}).sort();
if (!targets.length || targets.some(t => !/^\/(?:[^\x00-\x20/]+\/)*[^\x00-\x20/]+$/.test(t))) throw Error("Worker VOLUME targets invalid");
process.stdout.write(targets.join("\n"));
' "${volumes}")"
container="$(docker create --pull=never --network=none --read-only "${image}")"
while IFS= read -r target; do
  docker cp --archive "${container}:${target}/." - >"${scratch}/seed.tar"
  runner=(env)
  if [[ "$(id -u)" != 0 ]]; then
    runner=(sudo -n env)
  fi
  "${runner[@]}" "OPENKIT_WORKER_SEED_ARCHIVE=${scratch}/seed.tar" \
    "${extractor}" --exact persistent_volume::tests::worker_image_volume_seed --nocapture \
    | tee "${scratch}/result"
  grep -q 'test result: ok. 1 passed;' "${scratch}/result"
  echo "Worker seed passed: ${target}"
done <<<"${targets}"
# A failed removal is a failed gate; the trap makes a final cleanup attempt.
docker rm --volumes "${container}" >/dev/null
container=""
