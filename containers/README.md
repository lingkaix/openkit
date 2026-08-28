# Container Images

This directory owns OpenKit container image definitions.

The `app` runtime image includes Git because NanoCore resolves immutable repository HEAD commits and owns repository-backed workspace operations at runtime.

`images.json` is the machine-readable image catalog used by local Docker scripts and release workflows.

Use `scripts/docker/build-image.sh <image-id>` to build a local image and `scripts/docker/smoke-image.sh <image-id>` to run its smoke command.

`test-env` is not a release artifact but is not optional either: it is the test execution environment every repository check runs inside, owned by the Test Execution Environment decision in `docs/toolchain.md`. See `containers/test-env/README.md`.

The governed worker image ids are `worker-common`, `worker-codex`, `worker-opencode`, and `worker-pi`. `worker-common` is the published public extension base with an empty declared runtime set. Current leaves remain singular facts and may grow only through a reviewed specification and catalog change. The three deployment images are independent final artifacts built from `containers/workers/Dockerfile` targets over that base. The generic shim's static registry contains the AEP-selected adapter; image contents confer no adapter authority. `test-env` is an internal sibling that pins the same Node digest and is not built `FROM worker-common`.

The common base provides Node.js, Python, npm, pnpm, uv, mise, Git, GitHub CLI, editors, build tools, search tools, and network diagnostics. Installed tools do not imply network authority: copy-on-init AgentManifest templates owned by `docs/specs/20260703-agent_manifest_aep_resolution.md` declare exact GitHub, npm, and PyPI grants, and NanoCore derives the OpenShell policy from the immutable AEP.

Release publishing is driven by version tags and GHCR policy in `docs/specs/20260708-container_image_packaging.md`; the common environment and policy layering are owned by `docs/specs/20260721-worker_execution_environment_images.md`.
