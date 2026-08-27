# OpenCode Worker Image

This image packages the shared OpenKit development environment, the generic worker shim, the static OpenCode adapter, and `opencode-ai@1.18.1` for governed OpenShell execution.

The authored OpenCode AgentManifest selects this image, the trusted NanoCore inference relay, and exact GitHub read, npm download, and PyPI download grants. The image contains no direct-provider, host-configuration, or baked OpenShell policy projection, and `/etc/opencode` must remain absent.

Build and smoke it with `scripts/docker/build-image.sh worker-opencode` and `scripts/docker/smoke-image.sh worker-opencode`.
