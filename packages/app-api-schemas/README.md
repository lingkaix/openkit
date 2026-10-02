# @openkit/app-api-schemas

Thread dashboard taskInputs carry only Item identity and objective from NanoCore-verified structured Worker requests. They add no durable task payload or runtime identity, and are shared by Web and the public Skill.

Thread dashboard schemas include the nullable authenticated viewer id and a narrow participant display-name projection. These release-coupled labels do not replace immutable protocol actors or expose private profile fields.

`@openkit/app-api-schemas` owns runtime-neutral Zod schemas for NanoCore App API payloads.

The [Core Client Boundary](../../docs/specs/20260528-core_client_boundary.md) permits browser-safe config-schema subpaths, including `@openkit/config-schema/native-environment` for shared native-environment literals. App API schemas never import the server-only config root; the built browser import graph regression lives in Web's `test/browser-package-boundary.test.ts`.

These schemas are shared by `apps/nanocore` and `@openkit/core-client` while the App API remains an implementation projection over the stable Core protocol.

`src/pending-request.ts` validates the derived approval-effect preview for App read models. User-input answer and pending-request withdrawal commands and their outcome belong to `@openkit/protocol`. NanoCore owns the durable request, grant, execution, and delivery lifecycle; a completed raising Turn does not close its request.

The private administration configuration candidate Artifact schema is shared by the server proposal/apply owner and Web human review. Its exact version and digest remain the application identity; the schema grants no configuration authority.

The current Goal plan response projects the durable Goal and its exact plan reference for reload and reconnect. It adds no durable plan owner or approval authority.

Provider-subscription payload schemas consume the browser-safe `@openkit/config-schema/provider-subscription` entry point so Web bundles do not traverse the config package's server-only root graph. Account list and detail admit the optional process-local `inferenceObservation` projection with independently timestamped `accessRejected` and `quotaExhausted` parts; the member must contain at least one observed part. This projection does not change locally resolvable login or overlay the live quota result. Codex and xAI quota responses share the provider-neutral quota union, with `authentication_required` for a verified current presented credential rejection separate from `available` and `temporarily_unavailable`, preserving observation time, optional same-call account metadata, bounded quota-window percentages, optional positive integer `limitWindowSeconds`, weekly/monthly period fields, and optional USD billing without exposing upstream account identity or raw billing data. Omitted percentages remain omitted so consumers can label Provider did not report usage; they are not inferred as zero used or exhausted. xAI auto-top-up uses the separate `ProviderSubscriptionAutoTopup` observation, locked to `subscriptionProviderId: "xai"`.

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

`ThreadDashboard.runtimeActivity` is an optional bounded per-Turn projection with structural coverage and separate `contentCapture` off/on/unknown. Its exported timeline bounds are shared by storage projection and response validation. It contains display-safe text and source sequence only, not body references, native identities, execution authority or approval controls.

## Operation Definition Slice

[`src/operation-definitions.ts`](src/operation-definitions.ts) holds the Generative Kernel, Workspace, Thread and Turn family tables and the one administration read descriptor. `PRODUCT_OPERATION_DEFINITIONS` composes the public JSON families; `OPERATION_DEFINITIONS` also includes administration. Workspace collections retain nested authorized summaries, Thread creation retains private-default visibility, and Turn reads retain the ordinary product projection. It reuses existing domain payload schemas and exports inferred operation ids, inputs and outputs. HTTP placement, Tool spelling and model views derive from that table; executable handlers and current authority facts stay in NanoCore. Model views omit trusted fields without replacing the remaining schema objects. The built browser import-graph regression in Web covers this package transitively.

## Commands

- `pnpm --filter @openkit/app-api-schemas test`
- `pnpm --filter @openkit/app-api-schemas typecheck`
- `pnpm --filter @openkit/app-api-schemas build`
- `pnpm --filter @openkit/app-api-schemas lint`

Administration configuration payloads bind human confirmation to an immutable Artifact digest and report persistence separately from reload and restart requirements. Catalog changes are validated by the registered configuration owner; the request cannot supply actor authority or filesystem paths.

The generic runtime config file contract includes `model-catalog` for the deployment-admin model extension file; authorization and restart behavior remain NanoCore-owned.

Workspace Vault CRUD schemas admit bounded request-only material and return the existing redacted reference/grant shapes. Public grant creation accepts a reference and optional expiry for an ordinary gateway-only grant with no capability target, accepted by the selected MCP consumer under the existing authority check, or a separate user-space runtime-env `github-token` grant; callers cannot select arbitrary injection targets.

Conversation navigation projects visible active Threads with current/latest Chat, Task, Goal, or unknown activity; working, viewer-actionable, or idle state; and actual conversation recency. It defines neither a durable Thread kind nor unread state.

`WorkspaceWorkersResponseSchema` is the selected-Workspace, viewer-filtered current Worker read model, separate from the Agent Catalog. It validates exact known work, recorded state, bounded package details and last-used model attribution, with distinct unavailable and restricted states; it exposes no AgentSession or native runtime identifier.

The Thread dashboard pending-request projection includes derived `approvalEffect` (available complete detail or a safe unavailable reason) and `canRespond`; these are read-model fields, not durable request state.

## Native Environment Administration

The private administration GET/PUT projection exposes admitted defaults, literal authored overrides, managed names, desired image/default identities, file revision, reload agreement and audience-scoped native acknowledgement. PUT binds the existing configuration CAS to the current image/default identities. Preparation carries names, classification and defaults digest only; activation confirmation explicitly names the image/default digests. Raw defaults enter Core evidence only after fresh exact-image inspection at confirmed activation.

Native environment administration request and response readers, including nested identities and application status, discard inert additive envelope metadata. Image inspection readers likewise discard metadata and emit only the owned image, layout and names-only defaults core. Optional envelope keys are ignored regardless of their name; known core fields, literal maps and identity bounds remain validated. Measured native environment records retain their declared exclusions.

## Workspace Review Patch Bytes

Workspace review patch payloads retain UTF-8 text by default and use explicit canonical base64 encoding when Git patch bytes are not UTF-8. The payload reader discards inert additive members while encoding values stay closed and canonical base64 and decoded secret checks remain required. The shared byte decoder preserves the digest and byte count for persistence and Git; Web decodes those bytes only for presentation.

`RuntimeConfigFileDeleteRequestSchema` is the closed, revision-bound Provider deletion command. It permits only the `provider` kind and requires the exact existing source revision; successful deletion has an empty `204` response.

Structured conversation submission accepts optional canonical `reasoningEffort`. Conversation model choices expose optional `reasoningEffortLevels`, preserving the distinction between declared empty controls and absent controls. Existing product Turn projections expose the immutable admitted preference.

The capability-usage response exposes `routeLineage` as the Workspace audit projection, omitting the canonical extensions document, Provider/native-model identity and measurement references. It uses the shared closed failure kinds and preserves the existing system-prompt digest restriction.

The Knowledge family has 19 definitions and the retained minimal entry family has four definitions in `operation-definitions.ts`. Their strict inputs reuse the existing domain contracts with explicit Workspace/resource selectors. Retrieval and preparation are mutating for index/trace admission while retaining their request-scoped inputs without command identity. Public preparation exposes its bounded metadata view; trusted Task invocation separately projects the same definition to the existing trace-only contract.
