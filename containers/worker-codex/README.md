# Codex Worker Image

This image packages the OpenKit direct-control worker shim and Codex runtime payload for OpenShell-backed worker execution. The shim supervises Codex and talks directly to NanoCore; the image does not contain a separate control sidecar.

The image pins Codex 0.144.1. Update the Dockerfile version and `packages/codex-app-server-schema/metadata.json` together; NanoCore tests reject version drift between the executable image contract and the vendored schema evidence.

It is selected through `OPENKIT_OPENSHELL_WORKER_IMAGE`.
