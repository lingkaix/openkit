# Container Images

This directory owns OpenKit container image definitions.

`images.json` is the machine-readable image catalog used by local Docker scripts and release workflows.

Use `scripts/docker/build-image.sh <image-id>` to build a local image and `scripts/docker/smoke-image.sh <image-id>` to run its smoke command.

Release publishing is driven by version tags and GHCR policy in `docs/specs/20260708-container_image_packaging.md`.
