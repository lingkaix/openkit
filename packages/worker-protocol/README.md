# Worker Protocol

`@openkit/worker-protocol` defines the canonical `Core <-> Worker` schemas used by governed Worker Agent containers, NanoCore import/verification paths, worker sidecars, and runtime adapters.

This package is intentionally protocol-only. Public worker-control request, response, and heartbeat envelopes use the dedicated version-2 literal; canonical transcript, event, Artifact, provenance, workspace-change, and inner capability-summary records retain their independent version-1 literal. Restart reconnection uses a sequence-zero process-key hash commitment and an optional request-only reconnect key; NanoCore owns lease validation and never persists the raw key. This package does not own NanoCore state, runtime-native parsing, OpenShell transport, worker process supervision, or product review decisions.

The runtime provenance contract keeps `WorkerLineageSchema` unchanged and adds only the restricted raw-stream manifest, synthetic stream references, exact frame coordinates and digests, capture/parse states, and native-origin index entries required by `worker.runtime-provenance.v1`. Cross-stream completeness, graph closure, origin normalization, and evidence promotion remain NanoCore responsibilities.

`workerSessionInputPaths` derives canonical AgentSession-private AEP, worker-supply, and Context input paths for NanoCore, config-schema, and the Harness without adding a transport field or runtime dependency.

`WorkerStartupFailureSchema` defines the closed, value-free pre-native stage/reason pair and optional product-safe Git failure explanation shared by Harness refusals and NanoCore validation. The shared explanation comes from `@openkit/protocol`; strict cross-field validation binds its stage/code to the refusal. HTTP refusal requires observed 401/403 on a completed nonzero fetch and cannot claim enforcement attribution. It admits no arbitrary diagnostic text.

`CaptureCoverageBindingSchema` owns the strict admission-time `{scope, value}` pair carried in canonical Turn history, the AEP, and Worker runtime capture.

Incremental work observations use strict `observation.recorded` metadata and `observation.content.chunk` events on the existing control route. Shared schemas own fact combinations, exact content descriptors, canonical base64 and transport bounds; Core owns chunk continuity, historical capture admission and durable publication. A chunk is restricted transport, never an ordinary transcript or UI payload.

Unavailable content may identify one earlier expected observation for exact failure anchoring; other content states have no such field.

## Commands

- `pnpm --filter @openkit/worker-protocol test`
- `pnpm --filter @openkit/worker-protocol typecheck`
- `pnpm --filter @openkit/worker-protocol build`
- `pnpm --filter @openkit/worker-protocol lint`

## Public Native Environment

`native-environment.ts` owns the shared literal namespace, canonical ASCII-key JSON, authored string/null map and measured AEP record. `session.open.nativeEnvironment` is public, session-static and distinct from private `runtimeEnvironment`; its bytes participate in durable queued identity. Command bodies discard inert additions and reject unsupported execution, credential and required semantics before forwarding. Public maps use the authored/AEP 128-entry, 128-character-name and 16 KiB aggregate limits; private credentials retain their separate bounds.

Protected public names follow the actual adapter bindings: DeepSeek owns `DSH_HOME`, `DSH_PERMISSION_MODE`, `DSH_TELEMETRY_MODE` and `DSH_TELEMETRY_OTLP_URL`; Codex's exact retained-state selectors are protected only for Codex. The shared predicate is also the Codex launch check's source; it does not protect an unused name or an entire vendor prefix. Unknown adapter IDs receive the shared bootstrap protections without inheriting another adapter's names.
