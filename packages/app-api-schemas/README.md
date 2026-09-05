# @openkit/app-api-schemas

`@openkit/app-api-schemas` owns runtime-neutral Zod schemas for NanoCore App API payloads.

These schemas are shared by `apps/nanocore` and `@openkit/core-client` while the App API remains an implementation projection over the stable Core protocol.

Provider-subscription payload schemas consume the browser-safe `@openkit/config-schema/provider-subscription` entry point so Web bundles do not traverse the config package's server-only root graph.

Vault administration schemas keep provider API keys in strict request-only payloads and expose only redacted configuration status responses. `ProviderApiKeyProfileIdSchema` is the shared file-, Vault-reference-, and response-safe id boundary used by NanoCore and Web.

Workspace export response schemas reuse the format version owned by `@openkit/config-schema` so manifests cannot drift between the storage and App API contracts.

Authentication schemas include optional exact-owner access-token issuance plus session-only redacted `server-admin` Token inventory and default-selection contracts; none of these response shapes accepts Token plaintext or hashes.

This package no longer projects an AgentSession backend-summary schema. Gateway endpoints, Gateway names, native Sandbox names, retired control transports, and hidden AgentSession continuity are not ordinary public read-model states; protected evidence and operator projections may retain only their separately authorized redacted lineage.

Materialized linked-repository roots carry the full NanoCore-captured Git base commit so AEP, input-snapshot, materialization, and review records can enforce one immutable lineage.

Workspace materialization records and backend workspace handles carry AEP package snapshot lineage separately from the backend worker session id so terminal events, teardown, and recovery target the same materialization without treating backend-native ids as scheduler identity.

Capability usage read models extend the canonical protocol `CapabilityCall` while preserving its runtime lifecycle refinement and generated JSON Schema projection metadata.

Runtime configuration file metadata includes the deployment-admin-only Workspace MCP catalog kind; the App API carries its source text and JSON Schema but does not project server topology into worker or ordinary product read models.

Artifact and Material interaction schemas remain App API projections: the version-owned Artifact Review view excludes private decision request proof, Material views expose immutable revision identity without mutation lineage, and every decision body targets its exact owning route rather than a generic review verdict.

Do not add stable Core protocol records here. Core records, commands, events, errors, and conformance fixtures belong in `@openkit/protocol`.

## Commands

- `pnpm --filter @openkit/app-api-schemas test`
- `pnpm --filter @openkit/app-api-schemas typecheck`
- `pnpm --filter @openkit/app-api-schemas build`
- `pnpm --filter @openkit/app-api-schemas lint`
