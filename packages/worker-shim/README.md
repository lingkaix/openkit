# Worker Shim

`@openkit/worker-shim` provides sandbox-local OpenKit worker entrypoints.

The package supplies two binaries:

- `openkit-codex-shim`: supervises a Codex worker process and writes OpenKit transcript records.
- `openkit-worker-sidecar`: runs the sandbox-local `control.local` sidecar and relay client.

The implementation covers the durable transcript contract under `/openkit/session`, the sandbox-local control relay, and the thin capability client for governed knowledge search/read/proposal, artifact read, MCP list/call, and diagnostic read routes.

For one clean read-write Git workspace input, the Codex shim also captures worker changes through an isolated index and publishes `workspace.patch` followed by `workspace-changes.json` under the session directory. The shim rejects ambiguous inputs, hidden or pre-existing workspace changes, Git filters, unsupported file modes, and incomplete output publication so NanoCore receives one reviewable snapshot with explicit worker lineage.

## Commands

- `pnpm --filter @openkit/worker-shim test`
- `pnpm --filter @openkit/worker-shim typecheck`
- `pnpm --filter @openkit/worker-shim build`
- `pnpm --filter @openkit/worker-shim lint`
