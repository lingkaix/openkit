---
status: Accepted
implementation: Implemented
kind: boundary
aspect: communication
---
# Core Client Boundary

This specification owns how `@openkit/core-client` groups Core protocol calls and App API calls.

## Scope

This specification owns the package boundary among `@openkit/protocol`, `@openkit/app-api-schemas`, `@openkit/core-client`, NanoCore App API routes, and Web client consumption. It owns the composed client surface, the schema package split, typed client grouping, transport validation, and removal of flat legacy aliases.

Does not own:

- Stable Core protocol semantics. [`docs/core/protocol.md`](../core/protocol.md) owns them.
- Individual App API route behavior, Web screens, and NanoCore service implementation. Those owners keep them.
- Auth internals, runtime config semantics, and worker runtime behavior. Those specifications own them.
- The semantic contract of a public operation. [Operation Definition](20261002-operation_definition.md) owns it.
- Provider, conversation, attention, synchronization, and feedback field sets. Their specifications own those fields. This specification owns client decode, failure, and cursor advancement.

Core: [`docs/core/protocol.md`](../core/protocol.md), [`docs/core/communication.md`](../core/communication.md), [`docs/core/work-model.md`](../core/work-model.md), [`docs/core/architecture.md`](../core/architecture.md).

## Boundary Ownership
`@openkit/protocol` owns stable Core records, command requests, command responses, event envelopes, error shapes, capability metadata, and conformance fixtures.

`@openkit/app-api-schemas` owns runtime-neutral schemas for NanoCore App API payloads. A migrated family's payload schema is the definition table's schema. A hand-maintained schema for the same operation is not a second contract.

`apps/nanocore` owns App API route behavior and parses route output through `@openkit/app-api-schemas`.

`@openkit/core-client` owns transport, response validation, request-id insertion, SSE iteration, and the composed TypeScript client surface. A migrated family's client typing is derived from the definition table. The hand-maintained mapping for that family is absent. The shared JSON transport may resend only a definite pre-effect capture refusal: HTTP 409 `workspace_frozen`, `Retry-After: 1`, a valid 64-hex stable retry context, and `retryable: true` for operation `capture`. The resend uses the same request bytes and the same request id, preserves cancellation, waits at most 1 second per resend and remains within the 20-second retry window. A timeout after the resend is an unknown outcome. The resend does not replay an uncertain effect. [Workspace Backup, Export, and Import](20260704-workspace_backup_export_import.md) owns the capture refusal.

`apps/web` consumes only the composed client.

## Operation Definition Projection
[Operation Definition](20261002-operation_definition.md) owns the definition table, the canonical operation id, and derived HTTP placement and transport spelling. This specification does not restate that mechanism. A JSON product operation in the family has one HTTP route per canonical operation id. Client typing for the family is derived from that definition table. The same cutover deletes the family's old route, its hand-maintained client mapping, and its hand-maintained descriptor together. A schema view derived from the definition is not a second contract.

`workspace.archive-download` keeps its streaming binding. Ordinary archive import is absent. `workspace.backup-download` is also a stream, and `client.operations` exposes it as a `ReadableStream`. [Workspace Backup, Export, and Import](20260704-workspace_backup_export_import.md) owns those bindings. This specification does not fold either stream into one JSON route.

This specification keeps route and client projection detail. That detail is transport, response validation, request-id insertion, SSE iteration, the composed client surface, and the grouping of a derived operation on that surface.

## Client Shape
The public client is grouped by boundary:

- `client.core`: meta and the turn event stream (`subscribeTurnEvents`).
- `client.app`: `workspace.archive-download`. Ordinary archive import methods are absent under [Online Workspace Snapshots And Scoped Recovery](../decisions/20261027-online_workspace_snapshots_and_recovery.md).
- `client.operations` exposes `workspace.backup-download` as a `ReadableStream`. The CLI provides the bounded file sink.
- `client.artifactFiles` and `client.conversationFiles`: exact original Artifact file upload and download streams, and exact Turn-input file submission on the canonical conversation operation.
- `client.operations[id]` for the runtime family: runtime config file list, read, create, update, validate, reload, and schema catalog routes.
- `client.operations[id]` for the provider-subscription family: provider inventory and provider-subscription account list, create, update, delete, status, login, cancellation, logout, quota, auto-top-up, Codex settings, and account use-reset routes.
- `client.auth.email`: Better Auth email sign-up, sign-in, and sign-out routes.
- `client.capabilities`: `refresh`, `snapshot`, `supports`, and `require` helpers over `/api/meta`.
- `client.operations`: Canonical Agent inventory, detail and health refresh operations, plus `diagnostics.app` and `diagnostics.setup` with empty logical input objects.
- `client.operations['attention.list']`: unified Human Attention read-model operation.

Deprecated flat aliases are removed.

There is no `getMeta`, `createMemoryEntry`, `updateMemoryEntry`, `respondToApproval`, `subscribeToTurn`, or `subscribeTurnEvents` method on the root client.

## App API Schema Package
`@openkit/app-api-schemas` exports schema families for dashboards, diagnostics, setup diagnostics, runtime config, provider-subscription accounts, auth responses, automations, search, turn feedback, workspace synchronization, Goal reads and Goal operations, Agent Catalog, Action Center, and the unified conversation target catalog and submission.

`@openkit/app-api-schemas` is runtime-neutral and browser-safe: no module reachable from its entry may import Node built-ins or use Node globals. The built-graph regression enforces this invariant, including delayed schema refinements. The reason is recorded in [App API Schemas Browser-Safe Subpaths](../decisions/20261001-app_api_schemas_browser_safe_subpaths.md).

It must remain runtime-neutral and must not import NanoCore services, filesystem code, Web UI code, or client transport helpers.

## Provider Subscription Slice
Provider-subscription operations use `client.operations[id](input)` with their canonical `provider-subscription.*` identities and complete logical provider and slot selectors. `provider-subscription.provider-list` takes `{}`; account list takes `{ subscriptionProviderId }`; addressed account operations take `{ subscriptionProviderId, accountSlotId }` plus the existing strict mutation payload fields. The family includes the separate auto-top-up read. Deletion maps the empty HTTP 204 response to logical `null`; every other operation validates its complete response schema. There is no provider-subscription namespace or alias.

Provider inventory returns `ProviderSubscriptionsResponse`; account list returns `ProviderSubscriptionAccountsResponse`; account create, update, status, login start, login cancel, and logout return the strict `ProviderSubscriptionAccount` union; account delete returns `Promise<null>`; account quota returns `ProviderSubscriptionQuota`; account auto-top-up returns `ProviderSubscriptionAutoTopup`. Create, update, login-start, and login-cancel inputs retain the strict request objects defined by the provider-subscription specification, extended with their logical selectors. These input and response types come directly from `@openkit/app-api-schemas`; the client adds no defaults, aliases, provider-family inference, credential handling, or alternate response shapes.

For this slice, a non-success `ApiError` becomes `ApiCallError` while preserving its HTTP status, stable code, and fixed sanitized message. A malformed successful payload becomes `ProtocolValidationError`; the client never accepts unknown response fields or repairs a response into another union branch.

The prior `client.oauth.openaiCodex` namespace and every root-level or nested alias for its methods are removed in the same release as the provider-neutral App API cutover. No old namespace remains. This removal does not remove or rename the separately owned actual-User Vault Login acquisition operation `vault.bootstrap-codex-auth`.

## Agent Catalog Slice
Agent inventory, detail and health refresh use the canonical definitions `agent.list`, `agent.read` and `agent.health-refresh` with complete logical input objects through `client.operations`. The Agent family derives its HTTP, OpenAPI, CLI and MCP projections from the same schemas; its list and detail return product-visible entries without adapter-native runtime configuration, and discovery remains candidate-first across authorized Workspaces.

Stable Agent catalog records continue to come from `@openkit/protocol`. The distinct selected-Workspace current Worker read uses `client.operations['worker.list']({ workspaceId })`, preserving Thread audience, exact package supply and the separate audit requirement for usage. Workspace Skill, MCP and Plugin catalog operations likewise use `client.operations` with explicit Workspace and child selectors, existing request identities and immutable selection semantics. The drained `client.agents` and `client.catalog` namespaces and the former `client.app.listWorkspaceWorkers` member are absent.

## Unified Conversation Slice
NanoCore exposes:

- `POST /api/app/operations/conversation.targets`
- `POST /api/app/operations/conversation.submit`

`@openkit/app-api-schemas` owns the strict target catalog, structured request, and accepted response schemas defined by `docs/specs/20260831-unified_conversation_composer.md`. The client exposes `client.operations['conversation.targets']({ workspaceId })` and `client.operations['conversation.submit']({ workspaceId, threadId, ...input })`, inserts a request identity when omitted, and returns only schema-validated product fields.

The cutover removes `StartChatModeRequestSchema`, `StartChatModeResponseSchema`, `client.app.startChatMode`, the old thread `/chat` route, and the `chat.start` operation rather than retaining aliases. Direct Task, Goal, Knowledge Manager, and Core operations remain because they serve callers outside the Composer.

## Action Center Slice
NanoCore exposes:

- `POST /api/app/operations/attention.list`

This route is the unified Human Attention read model for pending human actions, review states, recovery prompts, and app-local attention sources.

Approval mutations stay on the definition-derived operation path at `POST /api/app/operations/approval.respond`.

Question response mutations use the definition-derived operation path at `POST /api/app/operations/question.answer`.

The client exposes `client.operations['attention.list']({ workspaceId })`.

## Workspace Source And Hosting Boundaries
[Workspace Data Source Catalog](20260704-workspace_data_source_catalog.md) owns registered repository inputs and source selection. [Hosting Goes Through The Gateway MCP](../decisions/20261002-hosting_through_gateway_mcp.md) retires the Workspace host repository resource and its setup surface. The client adds no repository setup API or host-repository reader. Source and configuration operations follow their existing definition and runtime-configuration owners.

Platform-managed hosting calls follow the selected vendor MCP's Gateway path under its authentication, authorization, approval, and audit owners. The Core Client does not introduce first-party Git operations or a replacement repository namespace. Worker-local Git and optional user-space native push retain their existing owners.

Any source summary exposed to Web must remain redacted. It must not expose raw host paths or adapter-native runtime configuration. Historical archive readers retain their separately owned shapes; reading an archive does not restore the removed resource, route, or client surface.

## Workspace Synchronization And Goal Mode Slices
Workspace synchronization read models and Goal operation projections are App API projections over stable Core workspace, thread, turn, item, artifact, and human-attention semantics.

Workspace synchronization derives its public methods through `client.operations`. `client.app` contains only `workspace.archive-download`. Both families are App API projections rather than standalone Core protocol objects.

Workspace synchronization uses the definition-derived `client.operations['sync.*']` methods from the synchronization definitions with one complete selector object, including review and recovery decisions. The former hand-maintained synchronization members of `client.app` are absent.

Goal client operations are create Goal, revise intent, card create, card edit, card cancel, Plan propose, Plan approval through a Pending Request, Goal cancel, completion acceptance through a Pending Request, and reads. This specification does not define their transport, catalog shape, or wire names. The legacy summary, start, plan, approval, step, steering, and Goal Review client methods are absent.

The Goal implementation removed the former deterministic test supervise-step route.

## Alias Cleanup Policy
This is a breaking change to release-coupled surfaces.

Removed aliases and old NanoCore response shapes are not preserved.

Provider diagnostics use the strict current object shape but do not duplicate provider-subscription account state. The legacy `oauth.openaiCodexAccounts` field is removed rather than renamed, and account status and quota remain available only through `client.operations[id]` for the provider-subscription family.

Runtime config, diagnostics, and provider-specific OAuth fields that existed only for earlier placeholder responses are removed from the typed surface.

## Correctness Notes
Auth responses now use concrete schemas instead of `unknown`.

`artifact.read` returns the `GetArtifactResponseSchema` payload type.

Definition-derived empty deletions return their declared logical `null`.

For Turn SSE, `@openkit/core-client` is the sole decoder of terminal-affiliated envelopes and projects the Core-owned classification, cursor, delivery, termination, and recovery semantics through its async iterator. Web and other consumers receive only admitted events and do not repeat outer-envelope, embedded-Turn, terminal-status, or exact-owner decoding.

The Core Client validates the forward-compatible outer envelope and every applicable embedded `Turn` before advancing its sequence cursor. A protocol-valid but semantically noncanonical terminal-affiliated envelope above the cursor advances the cursor, is skipped from iterator delivery, continues processing or reconnects with the latest `since`, and never becomes terminal proof.

An invalid outer envelope or applicable embedded `Turn` surfaces `ProtocolValidationError` from the async iterator without cursor advancement, consumer delivery, silent filtering, or terminal proof. The failing iterator read rejects, the active Fetch stream is aborted or the active EventSource is closed, automatic reconnect and further transport processing stop, and the next iterator read returns `done`.

After `ProtocolValidationError`, the failed subscription exposes no private cursor as recovery authority, performs no automatic recovery, and adds no public recovery shape. A later caller-created subscription supplies only a caller-owned `since` value or no `since`, and it may fail again until an authoritative read establishes usable state or a compatible client-server upgrade is installed.

Turn feedback submissions use the strict shared `SubmitTurnFeedbackRequestSchema`: NanoCore and `@openkit/core-client` reject unknown request fields, while the generated OpenAPI projection documents the same closed object shape. NanoCore checks retained `schemaVersion: 1` before its fixed native v1 feedback decoder, validates its known fields and owning Turn strictly, admits and preserves safe descriptive additions on disk updates, and emits only the known response fields without defining a second public schema. Missing or unsupported retained markers fail before decoding or replacement; no conversion is supplied.

### Turn Feedback Attribution And History

Turn feedback remains Workspace-owned under its existing Turn and Thread audience. Each accepted submission appends `{actor,submittedAt,rating,note}` to `history` in the existing `feedback.json`. Native invocation supplies the canonical Actor reference from current authenticated context; request bodies cannot choose it. The timestamp records submission time. The response includes this ordered history and the current `rating` and `note` from the latest submission. A cleared rating is still a submission and does not remove earlier judgments.

A completed Turn's initial unrated record has an empty history and claims no human decision. Updates preserve prior entries and safe descriptive additions, then use the existing atomic durable file writer. Failure does not acknowledge a partial history; reopen reads the retained file. This creates no separate feedback store, revision counter or retry ledger. Current authorization and audience checks apply to current feedback and its history alike. The [accepted pre-stable reset boundary](../decisions/20261014-pre_stable_data_continuity.md) applies to predecessor records without history; no inferred actor or compatibility reader is added.

## Turn Event Stream

The Core Turn stream uses `GET /api/workspaces/:workspaceId/threads/:threadId/events` with required `turnId` and optional nonnegative integer `since`, defaulting to zero. The route checks exact Workspace, Thread, and Turn lineage and current access before replay. It rechecks access before each publication. A missing `turnId` returns HTTP 400 `missing_turn_id`. An invalid cursor returns HTTP 400 `invalid_since`. An expired non-initial cursor returns HTTP 410 `core.stream.cursor_expired` under [Core Protocol](../core/protocol.md#stream-cursor-and-replay). A cursor at or beyond the retained terminal event receives HTTP 204. Other admitted requests receive `text/event-stream`, with one JSON protocol envelope per SSE `data` frame. Sequence and event identity come from that envelope. This route emits no application keep-alive frame. It streams retained replay followed by live events and closes after terminal publication. A transport close alone proves no terminal outcome.

The public Core Client subscribes only to this Workspace-scoped stream. Server-owned Turn event records omit `workspaceId` and use their Server owner. This client exposes no Server SSE address. Server history uses its separately admitted read operations. The event taxonomy imposes no common numeric payload limit. Boundary owners govern their payload limits. Large content follows the protocol's incremental-update and file-reference rules.

## Derived Client Families

The former `client.repositories` namespace and the Workspace repository list, diagnostics, and default-setup routes are absent. The client exposes no repository sub-client. The current operation definitions add no replacement first-party repository API. The retained `workspace-archive-history` schema remains a historical reader of retired host repository records, not a repository administration surface. Ordinary Workspace import parsing is absent.

`diagnostics.app` and `diagnostics.setup` derive their JSON routes, OpenAPI, Core Client, and CLI projections from the diagnostics operation definitions. Their former routes and named App methods are absent. Connection metadata, health, raw diagnostics, and OpenAPI serving remain support bindings outside operation discovery.

Automation, Scheduler, and Recovery operations use `client.operations`. Their former `client.app` members are absent. The generic transport maps a declared bodyless HTTP 204 to logical `null` through the operation output schema. It keeps normal API-error conversion and JSON response validation. Recovery input contains the exact Workspace, Thread, Turn, and request identities. The UI checkpoint identifier remains local.

`workspace.export` derives its schema, HTTP binding, Core Client method, and CLI entry from the workspace-transfer definitions. `workspace.archive-download` retains its streaming binding. Ordinary portable import is absent.

The ordinary Workspace, Thread, and Turn commands, the Workspace dashboard, and opaque Turn feedback use definition-derived canonical operation ids and `client.operations` with complete logical selectors. Native invocation preserves current Workspace and Thread admission, exact command replay, and owner outcomes. Their former JSON routes and client members are absent. The Thread event stream remains the route above. `thread.update` accepts `name` and `status` through the shared Thread request schema, with command identity and exact replay. It has no revision field and no revision precondition. Workspace Thread operations use HTTP 404 `not_found` for a missing or inaccessible addressed Thread. Server history retains its own error contract.

NanoCore's checked App API catalog, the generated OpenAPI projection, Core Client methods, and the bundled administrator CLI share the same schema owners and operation identities. OpenAPI tests prevent a first-party client from consuming the generated artifact as the source contract. Artifact, Knowledge, retained Knowledge Entry, Conversation, Task, Attention, Pending Request, Runtime Configuration, and Provider Subscription operations use `client.operations`. Their former family mappings are absent.

Kernel and Generative UI use `client.operations` with complete logical inputs. Their former App methods and mappings are absent. Generative UI resource results remain JSON. Mutations retain the definition-derived request-id header binding.

The synchronization methods use complete Workspace and child selectors and the original decision request identity. Their former `client.app` members are absent. The [Workspace Synchronization specification](20260703-workspace_synchronization.md#implementation) describes their native owners.

## Implementation

<a id="current-implementation-projection"></a>

- `packages/core-client/`
- `packages/app-api-schemas/`
- `packages/protocol/`
- `apps/nanocore/src/`
- `apps/web/`

## Implementation Gaps

None.

## Decisions

- [Online Workspace snapshots and scoped recovery](../decisions/20261027-online_workspace_snapshots_and_recovery.md)
- [App API schemas browser-safe subpaths](../decisions/20261001-app_api_schemas_browser_safe_subpaths.md)
- [Hosting through the Gateway MCP](../decisions/20261002-hosting_through_gateway_mcp.md)
- [Pre-stable data continuity](../decisions/20261014-pre_stable_data_continuity.md)
