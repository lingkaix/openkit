# Worker Protocol

`@openkit/worker-protocol` defines the canonical `Core <-> Worker` schemas used by governed Worker Agent containers, NanoCore import/verification paths, worker sidecars, and runtime adapters.

This package is intentionally schema-only. It does not own NanoCore state, runtime-native parsing, OpenShell transport, worker process supervision, or product review decisions.

## Commands

- `pnpm --filter @openkit/worker-protocol test`
- `pnpm --filter @openkit/worker-protocol typecheck`
- `pnpm --filter @openkit/worker-protocol build`
- `pnpm --filter @openkit/worker-protocol lint`
