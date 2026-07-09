# Worker Shim

`@openkit/worker-shim` provides sandbox-local OpenKit worker entrypoints.

The package supplies two binaries:

- `openkit-codex-shim`: supervises a Codex worker process and writes OpenKit transcript records.
- `openkit-worker-sidecar`: runs the sandbox-local `control.local` sidecar and relay client.

The implementation covers the durable transcript contract under `/openkit/session`, the sandbox-local control relay, and the thin capability client for governed knowledge search/read/proposal, artifact read, MCP list/call, and diagnostic read routes.

## Commands

- `pnpm --filter @openkit/worker-shim test`
- `pnpm --filter @openkit/worker-shim typecheck`
- `pnpm --filter @openkit/worker-shim build`
- `pnpm --filter @openkit/worker-shim lint`
