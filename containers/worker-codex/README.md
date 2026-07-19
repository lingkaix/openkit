# Codex Worker Image

This image packages the generic OpenKit worker shim, the static Codex adapter, and Codex `0.144.1` for governed OpenShell execution.

The image pins Codex 0.144.1. Update the Dockerfile version and `packages/codex-app-server-schema/metadata.json` together; NanoCore tests reject version drift between the executable image contract and the vendored schema evidence.

The authored Codex AgentManifest selects this image and the trusted NanoCore inference relay. The image contains no direct-provider or host-configuration projection.

Build and smoke it with `scripts/docker/build-image.sh worker-codex` and `scripts/docker/smoke-image.sh worker-codex`.
