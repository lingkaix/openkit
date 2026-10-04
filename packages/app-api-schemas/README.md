# @openkit/app-api-schemas

Thread dashboard taskInputs carry only Item identity and objective from NanoCore-verified structured Worker requests. They add no durable task payload or runtime identity, and are shared by Web and the public Skill.

Thread dashboard schemas include the nullable authenticated viewer id and a narrow participant display-name projection. These release-coupled labels do not replace immutable protocol actors or expose private profile fields.

`@openkit/app-api-schemas` owns runtime-neutral Zod schemas for NanoCore App API payloads.

The [Core Client Boundary](../../docs/specs/20260528-core_client_boundary.md) permits browser-safe config-schema subpaths, including `@openkit/config-schema/native-environment` for shared native-environment literals. App API schemas never import the server-only config root; the built browser import graph regression lives in Web's `test/browser-package-boundary.test.ts`.

These schemas are shared by `apps/nanocore` and `@openkit/core-client` while the App API remains an implementation projection over the stable Core protocol.

`src/pending-request.ts` validates the derived approval-effect preview for App read models. User-input answer and pending-request withdrawal commands and their outcome belong to `@openkit/protocol`. NanoCore owns the durable request, grant, execution, and delivery lifecycle; a completed raising Turn does not close its request.

The private administration configuration candidate Artifact schema is shared by the server proposal/apply owner and Web human review. Its exact version and digest remain the application identity; the schema grants no configuration authority.

`src/goal.ts` defines the ten Goal operation inputs, joined read projection, revisioned cards, immutable Plan commitment bytes and digest, Task citations and completion or cancellation disposition. The definition table derives the public and Coordinator projections; durable authority and Pending Request consumption remain with NanoCore.

Provider-subscription payload schemas consume the browser-safe `@openkit/config-schema/provider-subscription` entry point so Web bundles do not traverse the config package's server-only root graph. Account list and detail admit the optional process-local `inferenceObservation` projection with independently timestamped `accessRejected` and `quotaExhausted` parts; the member must contain at least one observed part. This projection does not change locally resolvable login or overlay the live quota result. Codex and xAI quota responses share the provider-neutral quota union, with `authentication_required` for a verified current presented credential rejection separate from `available` and `temporarily_unavailable`, preserving observation time, optional same-call account metadata, bounded quota-window percentages, optional positive integer `limitWindowSeconds`, weekly/monthly period fields, and optional USD billing without exposing upstream account identity or raw billing data. Omitted percentages remain omitted so consumers can label Provider did not report usage; they are not inferred as zero used or exhausted. xAI auto-top-up uses the separate `ProviderSubscriptionAutoTopup` observation, locked to `subscriptionProviderId: "xai"`.

Vault administration schemas keep provider API keys in strict request-only payloads and expose only redacted configuration status responses. `ProviderApiKeyProfileIdSchema` is the shared file-, Vault-reference-, and response-safe id boundary used by NanoCore and Web.

Workspace export response schemas reuse the format version owned by `@openkit/config-schema` so manifests cannot drift between the storage and App API contracts.

Authentication schemas include optional exact-owner access-token issuance plus session-only redacted `server-admin` Token inventory and default-selection contracts; none of these response shapes accepts Token plaintext or hashes.

This package no longer projects an AgentSession backend-summary schema. Gateway endpoints, Gateway names, native Sandbox names, retired control transports, and hidden AgentSession continuity are not ordinary public read-model states; protected evidence and operator projections may retain only their separately authorized redacted lineage.

Remote Git materialization carries the full Sandbox-reported Git base commit so AEP, input-snapshot, materialization, and review records can enforce one immutable lineage.

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

[`src/operation-definitions.ts`](src/operation-definitions.ts) statically composes the browser-safe family tables, including the NanoHost and data-root administration tables in `src/nanohost-operations.ts` and `src/data-root-admin-operations.ts`. `PRODUCT_OPERATION_DEFINITIONS` composes the public JSON families; `OPERATION_DEFINITIONS` also includes administration and supplies the common JSON, client, CLI, OpenAPI and remote MCP projections. Administration definitions declare per-operation server, body-Workspace or actor-Quick-Chat scope and current deployment-administrator credentials; sink-writing NanoHost operations return redacted metadata only. Workspace collections retain nested authorized summaries, Thread creation retains private-default visibility, and Turn reads retain the ordinary product projection. It reuses existing domain payload schemas and exports inferred operation ids, inputs and outputs. `src/operation-contract.ts` owns the closed declaration vocabulary, duplicate-rejecting concrete composition and fact-derived MCP eligibility. Status, allowed dynamic statuses, invalid-input overrides, JSON/streaming binding and one-time-secret result posture are release-authored facts. HTTP placement, Tool spelling and model views derive from the composed tables; executable handlers and current authority facts stay in NanoCore. Model views omit trusted fields without replacing the remaining schema objects. The built browser import-graph regression in Web covers this package transitively.

## Commands

- `pnpm --filter @openkit/app-api-schemas test`
- `pnpm --filter @openkit/app-api-schemas typecheck`
- `pnpm --filter @openkit/app-api-schemas build`
- `pnpm --filter @openkit/app-api-schemas lint`

Administration configuration payloads bind human confirmation to an immutable Artifact digest and report persistence separately from reload and restart requirements. Catalog changes are validated by the registered configuration owner; the request cannot supply actor authority or filesystem paths.

The generic runtime config file contract includes `model-catalog` for the deployment-admin model extension file; authorization and restart behavior remain NanoCore-owned.

`UpdateMcpBindingRequestSchema` carries optional `credentialBindings` from the browser-safe `@openkit/config-schema/mcp-credentials` entry. Omission preserves current bindings, a supplied array replaces them, and the shared schema keeps sink and raw/bearer presentation admission aligned with canonical configuration.

Workspace Vault CRUD schemas admit bounded request-only material and return the existing redacted reference/grant shapes. Public grant creation accepts a reference and optional expiry for an ordinary gateway-only grant with no capability target, accepted by the selected MCP consumer under the existing authority check, or a separate user-space runtime-env `github-token` grant; callers cannot select arbitrary injection targets.

Conversation navigation projects visible active Threads with current/latest Chat, Task, Goal, or unknown activity; working, viewer-actionable, or idle state; and actual conversation recency. It defines neither a durable Thread kind nor unread state.

`WorkspaceWorkersResponseSchema` is the selected-Workspace, viewer-filtered current Worker read model, separate from the Agent Catalog. It validates exact known work, recorded state, bounded package details and last-used model attribution, with distinct unavailable and restricted states; it exposes no AgentSession or native runtime identifier.

The Thread dashboard pending-request projection includes derived `approvalEffect` (available complete detail or a safe unavailable reason) and `canRespond`; these are read-model fields, not durable request state.

## Native Environment Administration

The private `runtime.agent-environment-read` and `runtime.agent-environment-update` projection exposes admitted defaults, literal authored overrides, managed names, desired image/default identities, file revision, reload agreement and audience-scoped native acknowledgement. The update binds the existing configuration CAS to the current image/default identities. Preparation carries names, classification and defaults digest only; activation confirmation explicitly names the image/default digests. Raw defaults enter Core evidence only after fresh exact-image inspection at confirmed activation.

Native environment administration request and response readers, including nested identities and application status, discard inert additive envelope metadata. Image inspection readers likewise discard metadata and emit only the owned image, layout and names-only defaults core. Optional envelope keys are ignored regardless of their name; known core fields, literal maps and identity bounds remain validated. Measured native environment records retain their declared exclusions.

## Workspace Review Patch Bytes

Workspace review patch payloads retain UTF-8 text by default and use explicit canonical base64 encoding when Git patch bytes are not UTF-8. The payload reader discards inert additive members while encoding values stay closed and canonical base64 and decoded secret checks remain required. The shared byte decoder preserves the digest and byte count for persistence and Git; Web decodes those bytes only for presentation.

`RuntimeConfigFileDeleteRequestSchema` is the closed, revision-bound Provider deletion command. It permits only the `provider` kind and requires the exact existing source revision; successful deletion has an empty `204` response.

Structured conversation submission accepts optional canonical `reasoningEffort`. Conversation model choices expose optional `reasoningEffortLevels`, preserving the distinction between declared empty controls and absent controls. Existing product Turn projections expose the immutable admitted preference.

The capability-usage response exposes `routeLineage` as the Workspace audit projection, omitting the canonical extensions document, Provider/native-model identity and measurement references. It uses the shared closed failure kinds and preserves the existing system-prompt digest restriction.

The Knowledge family has 19 definitions and the retained minimal entry family has four definitions in `knowledge-operation-definitions.ts`. Their strict inputs reuse the existing domain contracts with explicit Workspace/resource selectors. Retrieval and preparation are mutating for index/trace admission while retaining their request-scoped inputs without command identity. Public preparation exposes its bounded metadata view; the Knowledge-owned private Task entry shares admission and retrieval and owns its existing trace-only contract.

`ARTIFACT_OPERATION_DEFINITIONS` declares inventory, inline read, import, introduction, Review list and exact version Review decision. Inputs reuse the owned Artifact schemas with explicit selectors; the refined import and decision schemas retain their cross-field checks when trusted fields are omitted from model views. Import and introduction declare success status 201. `artifact.review-list` keeps its settled CLI identity, while `artifact.review.decide` keeps the settled domain command identity without a hyphenated alias.

Conversation, Task, Attention and Pending Request operations are composed from their family definition tables; they reuse the existing structured schemas and preserve Task HTTP 202 and owner-selected conversation HTTP 200/202.

`workspace-archive-history.ts` validates pre-retirement Git push and repository metadata only for archive verification. It defines no public operations, live resource, or execution authority.

`automation-operations.ts`, `scheduler-operations.ts` and `recovery-operations.ts` declare nine browser-safe operations and are imported statically into the composed product tables. Strict complete inputs retain opaque automation ids, selected Workspace queue identities and full recovery Turn/request lineage. Automation creation declares HTTP 201; deletion declares logical `null` and HTTP 204. Model views derive from those same schemas.

`src/workspace-transfer.ts` defines `workspace.export`, `workspace.import-dry-run`, and `workspace.import`, reusing complete storage response and import request schemas. `operation-definitions.ts` composes the family statically; model schema views retain the existing handle refinements.

`generative-operations.ts` declares the remaining eight Kernel operations and all five Generative UI operations using their existing schemas; `operation-definitions.ts` composes them statically with the Kernel pair. Model views omit trusted identity fields while retaining object refinements.

`src/sync-operations.ts` declares the fifteen existing Workspace synchronization operations with complete logical selectors and existing output schemas; `operation-definitions.ts` composes it statically.

`src/workspace-lifecycle-operations.ts` defines the sixteen sharing, invitation, leave, ownership, recovery, user-disable and deletion operations, reusing complete Workspace-sharing schemas with `safeExtend` so deletion confirmation refinements survive model projections. Canonical-user and server authorization scopes stay distinct from their mutation targets; invitation targets carry only minimal Core lineage selectors. The statically composed definitions also declare invitation creation’s secret-input sensitivity for the CLI.

`InjectionVisibilitySchema` in `src/vault-injection.ts` defines the closed visibility set shared by public injection-plan responses, NanoCore storage typing, and Workspace archive validation. Workspace plan lists include runtime-env plans without exposing credential values.

The eleven ordinary Workspace, Thread and Turn commands and Quick Chat operations belong to `src/workspace-operations.ts`, `src/thread-operations.ts`, `src/turn-operations.ts` and the existing Conversation table. They preserve complete existing schemas and each schema's unknown-field policy, while the CLI retains its separate strict input projection; no parallel core-command table exists. Its static composition in `operation-definitions.ts` derives the JSON, client, OpenAPI, MCP and CLI surfaces; SSE remains separate.

Addressed ordinary Turn targets declare the closed `not-found` or `interrupt-failed` missing policy. Recovery checkpoint targets retain their distinct strategy and cannot declare the interrupt policy; opaque feedback derives its Workspace from the existing minimum Turn-map lineage. These facts preserve the native refusal without transport or operation-name dispatch.

`turn.start` keeps its existing Product Turn schema and HTTP 202 binding; its definition describes the durable admission response and current-owner replay. Worker completion is observed through existing product reads and exact replay.

`runtime-config-operations.ts` and `provider-subscription-operations.ts` declare ten configuration and eleven subscription operations. Their complete inputs preserve CAS, exact provider-slot selectors and native environment extension tolerance. Both deletion definitions declare bodyless HTTP 204 with logical `null`; all other results reuse the complete existing public schemas.

`src/agent-operations.ts`, `src/worker-operations.ts` and `src/catalog-operations.ts` declare seventeen strict browser-safe JSON operations over the existing complete payload schemas. Skill default selection refuses a null digest while Skill pin removal accepts it; model views preserve this distinction. Each family is composed once into the public operation table.

The `governance-operations.ts`, `environment-operations.ts`, `app-search-operations.ts` and `vault-operations.ts` tables declare the 27 governance, AEP snapshot, App search and Vault contracts. Complete logical inputs include Workspace and child selectors; existing output schemas retain their refinements and redaction checks. Vault material inputs declare `secret stdin`, while outputs expose only redacted metadata.

`worker-environment-operations.ts`, `administration-operations.ts` and `app-update-operations.ts` declare the twelve administrator operations composed into `ADMINISTRATION_OPERATION_DEFINITIONS`. Preparation and result-only recovery expose separate strict objects derived from the canonical command branches, with no public mode. Their model views preserve requirements, exclusions, null defaults and raw-secret checks; family joins supply the fixed internal mode before the existing receipt owner. App-update status retains its host receipt `requestId` as a read selector; command identity uses the header only for mutations.
