# Pi Worker Image

This image packages the shared OpenKit development environment, the generic worker shim, the static Pi adapter, and `@earendil-works/pi-coding-agent@0.85.1` for governed OpenShell execution.

The authored Pi AgentManifest selects this image, the direct `anthropic` / `claude-sonnet-4-5` route with an `ANTHROPIC_API_KEY` runtime credential, and exact GitHub read, npm download, and PyPI download grants. Trusted relay, host-configuration, and baked OpenShell policy projection are not supported by this image.

Build and smoke it with `scripts/docker/build-image.sh worker-pi` and `scripts/docker/smoke-image.sh worker-pi`.
