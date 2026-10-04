# Docker Commands

These helpers read the single image catalog at `containers/images.json`. `build-image.sh <image-id> [tag]` passes its Dockerfile and target to Docker; `smoke-image.sh <image-id> [tag]` runs its installed smoke command. Unknown ids fail. Worker artifacts are the empty extension base `worker-common` and the four-runtime deployment image `worker-runtimes`. Worker smoke containers, including the base derivation, use `--network=none`; synthetic loopback services remain available. Other image kinds retain their existing smoke networking.

Build and smoke the worker artifacts with `bash scripts/docker/build-image.sh worker-common`, `bash scripts/docker/build-image.sh worker-runtimes`, and their matching `smoke-image.sh` commands. Use the optional tag for isolated verification. Base smoke also builds a network-free throwaway derivation, adds one executable as root, returns to sandbox, checks the inherited baseline, and removes the temporary image.

The test-image helpers own content-addressed `test-env` identification and anonymous inspection; `run-app.sh`, `e2e-app.sh`, and app smoke helpers own the app image. The release preflight consumes the same catalog and rejects singular runtime metadata and retired worker leaf ids. Installed binaries and catalog metadata grant no endpoint or credential authority.

The persistence smoke reads the post-restart Workspace collection through the definition-derived `workspace.list` JSON binding and checks the nested Workspace record. Its pre/post-restart persistence observation is unchanged.

The App-update helper observes configured NanoHost readiness through `POST /api/app/operations/nanohost.runtime-target` with an empty JSON object, preserving bounded JSON HTTP error handling and configured identity checks. Its host fixtures use the canonical `workspace.list` binding for forbidden Workspace discovery, and its assertions retain the requirement that update admission never reads Workspace content.

The App-update helper observes retained authentication through `POST /api/app/operations/token.list` with an empty JSON object. Its before/after fixed-key token comparison and last-use exclusions remain unchanged.
