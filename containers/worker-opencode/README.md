# OpenCode Worker Image

This image packages the generic OpenKit worker shim, the static OpenCode adapter, and `opencode-ai@1.18.1` for governed OpenShell execution.

The authored OpenCode AgentManifest selects this image and the trusted NanoCore inference relay. The image contains no direct-provider or host-configuration projection, and `/etc/opencode` must remain absent.

Build and smoke it with `scripts/docker/build-image.sh worker-opencode` and `scripts/docker/smoke-image.sh worker-opencode`.
