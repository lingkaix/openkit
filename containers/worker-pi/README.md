# Pi Worker Image

This image packages the generic OpenKit worker shim, the static Pi adapter, and `@earendil-works/pi-coding-agent@0.80.7` for governed OpenShell execution.

The authored Pi AgentManifest selects this image and only the direct `anthropic` / `claude-sonnet-4-5` route with an `ANTHROPIC_API_KEY` runtime credential. Trusted relay and host-configuration projection are not supported by this image.

Build and smoke it with `scripts/docker/build-image.sh worker-pi` and `scripts/docker/smoke-image.sh worker-pi`.
