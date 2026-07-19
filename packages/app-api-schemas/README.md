# @openkit/app-api-schemas

`@openkit/app-api-schemas` owns runtime-neutral Zod schemas for NanoCore App API payloads.

These schemas are shared by `apps/nanocore` and `@openkit/core-client` while the App API remains an implementation projection over the stable Core protocol.

Workspace export response schemas reuse the format version owned by `@openkit/config-schema` so manifests cannot drift between the storage and App API contracts.

Agent-session backend summaries expose only the canonical `direct-nanocore` worker-control mode or `null`; retired control transports are not public read-model states.

Materialized linked-repository roots carry the full NanoCore-captured Git base commit so AEP, input-snapshot, materialization, and review records can enforce one immutable lineage.

Workspace materialization records and backend workspace handles carry AEP package snapshot lineage separately from the backend worker session id so terminal events, teardown, and recovery target the same materialization without treating backend-native ids as scheduler identity.

Artifact and Material interaction schemas remain App API projections: the version-owned Artifact Review view excludes private decision request proof, Material views expose immutable revision identity without mutation lineage, and every decision body targets its exact owning route rather than a generic review verdict.

Do not add stable Core protocol records here. Core records, commands, events, errors, and conformance fixtures belong in `@openkit/protocol`.

## Commands

- `pnpm --filter @openkit/app-api-schemas test`
- `pnpm --filter @openkit/app-api-schemas typecheck`
- `pnpm --filter @openkit/app-api-schemas build`
- `pnpm --filter @openkit/app-api-schemas lint`
