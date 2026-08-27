#!/usr/bin/env bash
set -euo pipefail

IMAGE_ID="${1:-}"
IMAGE_TAG="${2:-}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

if [[ -z "${IMAGE_ID}" ]]; then
  echo "Usage: scripts/docker/smoke-image.sh <image-id> [tag]" >&2
  exit 2
fi

read_image_field() {
  local field="$1"
  IMAGE_ID="${IMAGE_ID}" FIELD="${field}" node -e '
const fs = require("fs");
const manifest = JSON.parse(fs.readFileSync("containers/images.json", "utf8"));
const image = manifest.images.find((entry) => entry.id === process.env.IMAGE_ID);
if (!image) {
  console.error(`Unknown container image: ${process.env.IMAGE_ID}`);
  process.exit(2);
}
const value = image[process.env.FIELD];
if (!value) {
  console.error(`Image ${image.id} does not define ${process.env.FIELD}`);
  process.exit(2);
}
process.stdout.write(String(value));
'
}

cd "${REPO_ROOT}"

if [[ -n "${IMAGE_TAG}" ]]; then
  tag="${IMAGE_TAG}"
elif [[ "${IMAGE_ID}" == "test-env" ]]; then
  tag="$(node scripts/docker/test-image-tag.mjs)"
else
  tag="$(read_image_field localTag)"
fi
smoke_command="$(read_image_field smokeCommand)"

if [[ "${IMAGE_ID}" == "test-env" ]]; then
  expected_build_input_digest="$(node scripts/docker/test-image-tag.mjs --digest)"
  actual_build_input_digest="$(
    docker image inspect \
      --format '{{ index .Config.Labels "org.openkit.test-env.build-input-digest" }}' \
      "${tag}" 2>/dev/null || true
  )"
  if [[ "${actual_build_input_digest}" != "${expected_build_input_digest}" ]]; then
    echo "Test execution image ${tag} has an invalid build-input digest label." >&2
    exit 1
  fi
fi

docker run --rm "${tag}" "${smoke_command}"
