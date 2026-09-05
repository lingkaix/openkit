# Codex Worker Image

This image packages the shared OpenKit development environment, the generic worker shim, the static Codex adapter, and Codex `0.153.4` for governed OpenShell execution.

The image pins Codex 0.153.4. Update the `worker-codex` target in `containers/workers/Dockerfile` and `packages/codex-app-server-schema/metadata.json` together; NanoCore tests reject version drift between the executable image contract and the vendored schema evidence.

The authored Codex AgentManifest selects this image, the trusted NanoCore inference relay, and exact GitHub read, npm download, and PyPI download grants. The image contains no direct-provider, host-configuration, or baked OpenShell policy projection.

Build and smoke it with `scripts/docker/build-image.sh worker-codex` and `scripts/docker/smoke-image.sh worker-codex`.
