#!/usr/bin/env bash
set -euo pipefail

IMAGE_ID="${1:-}"
IMAGE_TAG="${2:-}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

if [[ -z "${IMAGE_ID}" ]]; then
  echo "Usage: scripts/docker/build-image.sh <image-id> [tag]" >&2
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

read_optional_image_field() {
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
if (value !== undefined && value !== null && value !== "") {
  process.stdout.write(String(value));
}
'
}

cd "${REPO_ROOT}"

dockerfile="$(read_image_field dockerfile)"
context="$(read_image_field context)"
tag="${IMAGE_TAG:-$(read_image_field localTag)}"
target="$(read_optional_image_field target)"
docker_args=(-f "${dockerfile}" -t "${tag}")

if [[ "${IMAGE_ID}" == "test-env" ]]; then
  test_image_build_input_digest="$(node scripts/docker/test-image-tag.mjs --digest)"
  docker_args+=(
    --build-arg "OPENKIT_TEST_IMAGE_BUILD_INPUT_DIGEST=${test_image_build_input_digest}"
  )
fi

if [[ -n "${target}" ]]; then
  docker_args+=(--target "${target}")
fi

docker build "${docker_args[@]}" "${context}"
