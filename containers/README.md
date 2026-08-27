# Container Images

This directory owns OpenKit container image definitions.

The `app` runtime image includes Git because NanoCore resolves immutable repository HEAD commits and owns repository-backed workspace operations at runtime.

`images.json` is the machine-readable image catalog used by local Docker scripts and release workflows.

Use `scripts/docker/build-image.sh <image-id>` to build a local image and `scripts/docker/smoke-image.sh <image-id>` to run its smoke command.

`test-env` is not a release artifact but is not optional either: it is the test execution environment every repository check runs inside, owned by the Test Execution Environment decision in `docs/toolchain.md`. See `containers/test-env/README.md`.

The governed worker image ids are `worker-codex`, `worker-opencode`, and `worker-pi`. They are three independent final artifacts built from `containers/workers/Dockerfile` targets over one internal common development stage. The generic shim's static registry contains the manifest-selected adapter, and each final image installs exactly one pinned native runtime.

The common stage provides Node.js, Python, npm, pnpm, uv, Git, GitHub CLI, editors, build tools, search tools, and network diagnostics. Installed tools do not imply network authority: each authored AgentManifest declares exact GitHub, npm, PyPI, and provider grants, and NanoCore derives the OpenShell policy from the immutable AEP.

Release publishing is driven by version tags and GHCR policy in `docs/specs/20260708-container_image_packaging.md`; the common environment and policy layering are owned by `docs/specs/20260721-worker_execution_environment_images.md`.
