# @openkit/app-api-schemas

Thread dashboard taskInputs carry only Item identity and objective from NanoCore-verified structured Worker requests. They add no durable task payload or runtime identity, and are shared by Web and the public Skill.

Thread dashboard schemas include the nullable authenticated viewer id and a narrow participant display-name projection. These release-coupled labels do not replace immutable protocol actors or expose private profile fields.

`@openkit/app-api-schemas` owns runtime-neutral Zod schemas for NanoCore App API payloads.

These schemas are shared by `apps/nanocore` and `@openkit/core-client` while the App API remains an implementation projection over the stable Core protocol.

The private administration configuration candidate Artifact schema is shared by the server proposal/apply owner and Web human review. Its exact version and digest remain the application identity; the schema grants no configuration authority.

The current Goal plan response projects the durable Goal and its exact plan reference for reload and reconnect. It adds no durable plan owner or approval authority.

Provider-subscription payload schemas consume the browser-safe `@openkit/config-schema/provider-subscription` entry point so Web bundles do not traverse the config package's server-only root graph. Codex and xAI quota responses share the provider-neutral `available` and `temporarily_unavailable` union, preserving observation time, optional same-call account metadata, bounded quota-window percentages, weekly/monthly period fields, and optional USD billing without exposing upstream account identity or raw billing data. Omitted percentages remain omitted so consumers can label Provider did not report usage; they are not inferred as zero used or exhausted. xAI auto-top-up uses the separate `ProviderSubscriptionAutoTopup` observation, locked to `subscriptionProviderId: "xai"`.

Vault administration schemas keep provider API keys in strict request-only payloads and expose only redacted configuration status responses. `ProviderApiKeyProfileIdSchema` is the shared file-, Vault-reference-, and response-safe id boundary used by NanoCore and Web.

Workspace export response schemas reuse the format version owned by `@openkit/config-schema` so manifests cannot drift between the storage and App API contracts.

Authentication schemas include optional exact-owner access-token issuance plus session-only redacted `server-admin` Token inventory and default-selection contracts; none of these response shapes accepts Token plaintext or hashes.

This package no longer projects an AgentSession backend-summary schema. Gateway endpoints, Gateway names, native Sandbox names, retired control transports, and hidden AgentSession continuity are not ordinary public read-model states; protected evidence and operator projections may retain only their separately authorized redacted lineage.

Materialized linked-repository roots carry the full NanoCore-captured Git base commit so AEP, input-snapshot, materialization, and review records can enforce one immutable lineage.

Workspace materialization records and backend workspace handles carry AEP package snapshot lineage separately from the backend worker session id so terminal events, teardown, and recovery target the same materialization without treating backend-native ids as scheduler identity.

Capability usage read models extend the canonical protocol `CapabilityCall` while preserving its runtime lifecycle refinement and generated JSON Schema projection metadata.

Runtime configuration file metadata includes the deployment-admin-only Workspace MCP catalog kind; the App API carries its source text and JSON Schema but does not project server topology into worker or ordinary product read models.

Artifact and Material interaction schemas remain App API projections: the version-owned Artifact Review view excludes private decision request proof, Material views expose immutable revision identity without mutation lineage, and every decision body targets its exact owning route rather than a generic review verdict.

Knowledge Proposal page ids and page-source references reserve the final `index` and `log` segments at every hierarchy level, matching OKF reserved filenames.

Do not add stable Core protocol records here. Core records, commands, events, errors, and conformance fixtures belong in `@openkit/protocol`.

App Diagnostics includes a strict process sample with nested telemetry configuration booleans. The schema does not grant access or interpret exporter delivery; NanoCore samples only after deployment-admin authorization.

App-update schemas define the closed release/exact-commit prepare request, maintenance-consented start, and redacted host receipt projection. A UUID identifies the prepared request across App restarts. These schemas do not grant deployment-admin authority or turn the host receipt into a Core Task lifecycle.

Worker environment schemas project bounded retained-storage summaries, explicit ordinary Task and Goal storage choices, exact host observations, immutable authored/resolved candidate references, canonical human activation and purge confirmations, and truthful unknown outcomes. They expose no administrator Token, host path, native runtime handle, credential, or retained file content. The administration conversation request names only private conversation input and optional continuity; NanoCore derives and authorizes its private Workspace.

Workspace Sync Review patch schemas scan metadata and ordinary file contents for raw-secret-shaped strings. Only complete Git unified-diff hunks for the exact generated `skills/openkit/scripts/openkit` path are exempt; unsupported or malformed patches retain full scanning. Nested review and list schemas preserve this boundary without rescanning patch text.

## Commands

- `pnpm --filter @openkit/app-api-schemas test`
- `pnpm --filter @openkit/app-api-schemas typecheck`
- `pnpm --filter @openkit/app-api-schemas build`
- `pnpm --filter @openkit/app-api-schemas lint`

Administration configuration payloads bind human confirmation to an immutable Artifact digest and report persistence separately from reload and restart requirements. Catalog changes are validated by the registered configuration owner; the request cannot supply actor authority or filesystem paths.

The generic runtime config file contract includes `model-catalog` for the deployment-admin model extension file; authorization and restart behavior remain NanoCore-owned.

Workspace Vault CRUD schemas admit bounded request-only material and return the existing redacted reference/grant shapes. Host-push grant creation accepts a reference and optional expiry; callers cannot select arbitrary injection targets.

Conversation navigation projects visible active Threads with current/latest Chat, Task, Goal, or unknown activity; working, viewer-actionable, or idle state; and actual conversation recency. It defines neither a durable Thread kind nor unread state.

`WorkspaceWorkersResponseSchema` is the selected-Workspace, viewer-filtered current Worker read model, separate from the Agent Catalog. It validates exact known work, recorded state, bounded package details and last-used model attribution, with distinct unavailable and restricted states; it exposes no AgentSession or native runtime identifier.
