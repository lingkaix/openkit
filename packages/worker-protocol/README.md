# Worker Protocol

`@openkit/worker-protocol` defines the canonical `Core <-> Worker` schemas used by governed Worker Agent containers, NanoCore import/verification paths, worker sidecars, and runtime adapters.

This package is intentionally protocol-only. Restart reconnection uses a sequence-zero process-key hash commitment and an optional request-only reconnect key; NanoCore owns lease validation and never persists the raw key. This package does not own NanoCore state, runtime-native parsing, OpenShell transport, worker process supervision, or product review decisions.

The runtime provenance contract keeps `WorkerLineageSchema` unchanged and adds only the restricted raw-stream manifest, synthetic stream references, exact frame coordinates and digests, capture/parse states, and native-origin index entries required by `worker.runtime-provenance.v1`. Cross-stream completeness, graph closure, origin normalization, and evidence promotion remain NanoCore responsibilities.

## Commands

- `pnpm --filter @openkit/worker-protocol test`
- `pnpm --filter @openkit/worker-protocol typecheck`
- `pnpm --filter @openkit/worker-protocol build`
- `pnpm --filter @openkit/worker-protocol lint`
