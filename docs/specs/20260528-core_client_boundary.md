---
status: Accepted
implementation: Partial
kind: boundary
---
# Core Client Boundary

## Owns

This spec owns the package boundary between `@openkit/protocol`, `@openkit/app-api-schemas`, `@openkit/core-client`, NanoCore App API routes, and Web UI client consumption.

It owns the composed client surface, schema package split, typed client grouping, transport validation rules, and the removal of flat legacy aliases.

## Does Not Own

This spec does not own stable core protocol semantics, individual App API route behavior, Web UI screens, NanoCore service implementation, auth internals, runtime config semantics, worker runtime behavior, or the semantic contract of a public operation. [Operation Definition](20261002-operation_definition.md) owns that semantic contract.

## Core References

- `docs/core/protocol.md`
- `docs/core/communication.md`
- `docs/core/work-model.md`
- `docs/core/architecture.md`

Related specs:


## Related Docs

- `docs/specs/20260721-provider_subscription_accounts.md`
- `docs/specs/20260704-app_api_openapi_projection.md`
- `docs/specs/20260831-unified_conversation_composer.md`
- `docs/specs/20261002-operation_definition.md`
- `docs/specs/20260704-workspace_backup_export_import.md`

## Summary

`@openkit/core-client` is now a composed client instead of a flat mixed protocol and App API client.

Core protocol HTTP and SSE routes live under `client.core`.

NanoCore App API read models and app-local commands live under dedicated sub-clients.

Shared App API payload validation lives in `@openkit/app-api-schemas`, which is imported by both NanoCore and the client.

## Problem

The previous client package defined Core protocol schemas, App API schemas, removed aliases, OAuth payloads, runtime-config schemas, diagnostics schemas, dashboard schemas, and product read models in one file.

That made `@openkit/core-client` the accidental owner of NanoCore App API shapes.

It also forced the Web UI to consume a flat API surface where stable Core semantics and app-local read models were indistinguishable.

## Boundary Ownership

`@openkit/protocol` owns stable Core records, command requests, command responses, event envelopes, error shapes, capability metadata, and conformance fixtures.

`@openkit/app-api-schemas` owns runtime-neutral schemas for NanoCore App API payloads. Until a resource family is cut over, a hand-maintained schema in that package is that family's payload contract. When the family is cut over, the payload schema is the definition table's schema, and a hand-maintained schema for the same operation is not a second contract.

`apps/nanocore` owns App API route behavior and parses route output through `@openkit/app-api-schemas`.

`@openkit/core-client` owns transport, response validation, request-id insertion, SSE iteration, and the composed TypeScript client surface. Until a resource family is cut over, the hand-maintained client methods stated in this specification are that family's client contract. When the family is cut over, client typing is derived from the definition table, and the hand-maintained mapping is deleted with the old route.

`apps/web` consumes only the composed client.

## Operation Definition Projection

Until a resource family is cut over, the routes and hand-maintained client methods this specification states for that family remain its contract.

When that resource family is cut over, the accepted target applies. [Operation Definition](20261002-operation_definition.md) owns the definition table, the canonical operation id, and derived HTTP placement and transport spelling. This specification does not restate that mechanism. A JSON product operation in the family has one HTTP route per canonical operation id. Client typing for the family is derived from that definition table. The same cutover deletes the family's old route, its hand-maintained client mapping, and its hand-maintained descriptor together. A schema view derived from the definition is not a second contract.

The three Workspace archive operations `workspace.archive-download`, `workspace.archive-import-dry-run`, and `workspace.archive-import` keep their streaming bindings. [Workspace Backup, Export, and Import](20260704-workspace_backup_export_import.md) owns those bindings. This specification does not fold those three operations into one JSON route.

This specification keeps route and client projection detail. That detail is transport, response validation, request-id insertion, SSE iteration, the composed client surface, and the grouping of a derived operation on that surface.

## Client Shape

The public client is grouped by boundary:

- `client.core`: meta, workspaces, knowledge, threads, turns, items, approvals, artifacts, and turn SSE.
- `client.app`: dashboards, Goal reads and the Goal operations, workspace synchronization read models, search, quick chat, automations, diagnostics, setup diagnostics, and feedback.
- `client.runtimeConfig`: runtime config file list, read, create, update, validate, reload, and schema catalog routes.
- `client.providerSubscriptions`: provider inventory and provider-subscription account list, create, update, delete, status, login, cancellation, logout, and quota routes.
- `client.auth.email`: Better Auth email sign-up, sign-in, and sign-out routes.
- `client.capabilities`: `refresh`, `snapshot`, `supports`, and `require` helpers over `/api/meta`.
- `client.agents`: Agent Catalog list, get, and health refresh routes.
- `client.actionCenter`: unified Human Attention read-model route.
- `client.repositories`: workspace repository resource list, diagnostics, and default repository setup routes.

Deprecated flat aliases are removed.

There is no `getMeta`, `createMemoryEntry`, `updateMemoryEntry`, `respondToApproval`, `subscribeToTurn`, or `subscribeTurnEvents` method on the root client.

## App API Schema Package

`@openkit/app-api-schemas` exports schema families for dashboards, diagnostics, setup diagnostics, runtime config, provider-subscription accounts, auth responses, automations, quick chat, search, turn feedback, repository resources, workspace synchronization, Goal reads and Goal operations, Agent Catalog, Action Center, and the unified conversation target catalog and submission.

`@openkit/app-api-schemas` is runtime-neutral and browser-safe: no module reachable from its entry may import Node built-ins or use Node globals. The built-graph regression enforces this invariant. The reason is recorded in [App API Schemas Browser-Safe Subpaths](../decisions/20261001-app_api_schemas_browser_safe_subpaths.md).

It must remain runtime-neutral and must not import NanoCore services, filesystem code, Web UI code, or client transport helpers.

## Provider Subscription Slice

`client.providerSubscriptions` is the only provider-subscription client namespace. It exposes exactly these methods in public operation order:

```ts
listProviders()
listAccounts(subscriptionProviderId)
createAccount(subscriptionProviderId, input)
updateAccount(subscriptionProviderId, accountSlotId, input)
deleteAccount(subscriptionProviderId, accountSlotId)
getAccountStatus(subscriptionProviderId, accountSlotId)
startAccountLogin(subscriptionProviderId, accountSlotId, input)
cancelAccountLogin(subscriptionProviderId, accountSlotId, input)
logoutAccount(subscriptionProviderId, accountSlotId)
getAccountQuota(subscriptionProviderId, accountSlotId)
```

The methods map one-to-one and in the same order to `listSubscriptionProviders`, `listProviderSubscriptionAccounts`, `createProviderSubscriptionAccount`, `updateProviderSubscriptionAccount`, `deleteProviderSubscriptionAccount`, `getProviderSubscriptionAccountStatus`, `startProviderSubscriptionAccountLogin`, `cancelProviderSubscriptionAccountLogin`, `logoutProviderSubscriptionAccount`, and `getProviderSubscriptionAccountQuota`. `listProviders()` returns `ProviderSubscriptionsResponse`; `listAccounts()` returns `ProviderSubscriptionAccountsResponse`; create, update, status, login, cancel, and logout return the strict `ProviderSubscriptionAccount` status union; delete returns `Promise<void>` from the `204` empty response; and quota returns `ProviderSubscriptionQuota`. The four `input` parameters use the strict create, update, login, and cancel request objects defined by the provider-subscription specification. Request and response types come directly from `@openkit/app-api-schemas`; the client adds no defaults, aliases, provider-family inference, credential handling, or alternate response shapes.

For this slice, a non-success `ApiError` becomes `ApiCallError` while preserving its HTTP status, stable code, and fixed sanitized message. A malformed successful payload becomes `ProtocolValidationError`; the client never accepts unknown response fields or repairs a response into another union branch.

The prior `client.oauth.openaiCodex` namespace and every root-level or nested alias for its methods are removed in the same release as the provider-neutral App API cutover. No old namespace remains. This removal does not remove or rename the separately owned Vault administration client method for `/api/app/vault/bootstrap/codex-auth-json`.

## Agent Catalog Slice

NanoCore exposes:

- `GET /api/app/agents`
- `GET /api/app/agents/:agentId`
- `POST /api/app/workspaces/:workspaceId/agents/health/refresh`

The list and detail routes return product-visible agent catalog entries without adapter-native runtime config.

The client exposes `client.agents.list()`, `client.agents.get(agentId)`, and `client.agents.refreshHealth(workspaceId)`.

Stable agent catalog records continue to come from `@openkit/protocol`.

App API wrappers add only NanoCore-local read-model behavior.

## Unified Conversation Slice

NanoCore exposes:

- `GET /api/app/workspaces/:workspaceId/conversation-targets`
- `POST /api/app/workspaces/:workspaceId/threads/:threadId/conversation-turns`

`@openkit/app-api-schemas` owns the strict target catalog, structured request, and accepted response schemas defined by `docs/specs/20260831-unified_conversation_composer.md`. The client exposes `client.app.listConversationTargets(workspaceId)` and `client.app.submitConversationTurn(workspaceId, threadId, input)`, inserts a request identity when omitted, and returns only schema-validated product fields.

The cutover removes `StartChatModeRequestSchema`, `StartChatModeResponseSchema`, `client.app.startChatMode`, the old thread `/chat` route, and the `chat.start` operation rather than retaining aliases. Direct Task, Goal, Knowledge Manager, and Core operations remain because they serve callers outside the Composer.

## Action Center Slice

NanoCore exposes:

- `GET /api/app/workspaces/:workspaceId/action-center`

This route is the unified Human Attention read model for pending human actions, review states, recovery prompts, and app-local attention sources.

Approval mutations stay on the Core command path at `POST /api/approvals/:approvalRequestId/respond`.

Question response mutations stay on the Core turn-input path at `POST /api/turns`.

The client exposes `client.actionCenter.listHumanAttention(workspaceId)`.

## Workspace Repository Slice

NanoCore exposes:

- `GET /api/app/workspaces/:workspaceId/repositories`
- `GET /api/app/workspaces/:workspaceId/repositories/diagnostics`
- `PUT /api/app/workspaces/:workspaceId/repositories/default`

This slice is a redacted App API projection for workspace repository resources.
It must not expose raw host paths or adapter-native runtime config through Web-facing payloads.

The client exposes `client.repositories.list(workspaceId)`, `client.repositories.diagnostics(workspaceId)`, and `client.repositories.setDefault(workspaceId, input)`.

## Workspace Synchronization And Goal Mode Slices

Workspace synchronization read models and Goal operation projections are App API projections over stable Core workspace, thread, turn, item, artifact, and human-attention semantics.

The client exposes these routes through `client.app` because they are workflow/product projections, not standalone Core protocol objects.

Workspace synchronization client methods include review listing, review retrieval, input snapshots, materialization records, change sets, staged reviews, apply-result listing, and apply-result retrieval.

Goal client operations are create Goal, revise intent, card create, card edit, card cancel, Plan propose, Plan approval through a Pending Request, Goal cancel, completion acceptance through a Pending Request, and reads. This specification does not define their transport, catalog shape, or wire names. The current implementation may still expose the legacy summary, start, plan, approval, step, steering, and Goal Review methods until the Goal implementation; that exposure is current implementation, not this contract.

The current implementation's deterministic test supervise-step route remains outside the public product client surface until the Goal implementation removes it.

## Alias Cleanup Policy

This is a breaking change to release-coupled surfaces.

Removed aliases and old NanoCore response shapes are not preserved.

Provider diagnostics use the strict current object shape but do not duplicate provider-subscription account state. The legacy `oauth.openaiCodexAccounts` field is removed rather than renamed, and account status and quota remain available only through `client.providerSubscriptions`.

Runtime config, diagnostics, and provider-specific OAuth fields that existed only for earlier placeholder responses are removed from the typed surface.

## Correctness Notes

Auth responses now use concrete schemas instead of `unknown`.

`getArtifact` returns the `GetArtifactResponseSchema` payload type.

Empty successful delete routes return `void` without parsing through `z.never`.

For Turn SSE, `@openkit/core-client` is the sole decoder of terminal-affiliated envelopes and projects the Core-owned classification, cursor, delivery, termination, and recovery semantics through its async iterator. Web and other consumers receive only admitted events and do not repeat outer-envelope, embedded-Turn, terminal-status, or exact-owner decoding.

The Core Client validates the forward-compatible outer envelope and every applicable embedded `Turn` before advancing its sequence cursor. A protocol-valid but semantically noncanonical terminal-affiliated envelope above the cursor advances the cursor, is skipped from iterator delivery, continues processing or reconnects with the latest `since`, and never becomes terminal proof.

An invalid outer envelope or applicable embedded `Turn` surfaces `ProtocolValidationError` from the async iterator without cursor advancement, consumer delivery, silent filtering, or terminal proof. The failing iterator read rejects, the active Fetch stream is aborted or the active EventSource is closed, automatic reconnect and further transport processing stop, and the next iterator read returns `done`.

After `ProtocolValidationError`, the failed subscription exposes no private cursor as recovery authority, performs no automatic recovery, and adds no public recovery shape. A later caller-created subscription supplies only a caller-owned `since` value or no `since`, and it may fail again until an authoritative read establishes usable state or a compatible client-server upgrade is installed.

Turn feedback submissions use the strict shared `SubmitTurnFeedbackRequestSchema`: NanoCore and `@openkit/core-client` reject unknown request fields, while the generated OpenAPI projection documents the same closed object shape. NanoCore derives persisted feedback validation from `TurnFeedbackResponseSchema` and applies strict validation at the disk boundary without defining a second public schema.

## Current Implementation Projection

Web's [built browser package graph regression](../../apps/web/test/browser-package-boundary.test.ts) follows the shipped schema and client entries with browser package resolution and rejects reachable Node imports and globals, including delayed schema refinements.

The composed `@openkit/core-client` surface and shared `@openkit/app-api-schemas` package include `client.providerSubscriptions` with exactly the ten accepted methods, strict request and response validation, `void` handling for the empty delete response, and stable `ApiCallError` conversion. The prior `client.oauth.openaiCodex` namespace and Codex-specific provider-subscription schemas are absent; no alias or second client remains. The unified conversation slice is implemented through `client.app.getConversationTargets` and `client.app.submitConversation` with strict target-catalog, Artifact-reference, logical-model, structured request, and response schemas. The removed `client.app.startChatMode` and text-only `/chat` App route have no compatibility surface.

NanoCore's ten checked App API operations, the generated OpenAPI projection, the Core Client methods, and the bundled Skill's ten generic catalog mappings share the same schema owners and operation identities. Package tests keep App API schemas runtime-neutral, and OpenAPI tests prevent first-party clients from reversing direction and consuming the generated artifact as source contract. Those hand-maintained mappings remain for families awaiting cutover under Operation Definition Projection. Knowledge and retained Knowledge Entry operations now use the definition-derived `client.operations` map; their former `client.app` and `client.core` mappings are absent.

Provider-neutral Web consumption is now complete. This spec remains `Partial` only because the items named in Future Slices stay outside this spec until their owning specifications, NanoCore routes, schemas, and client methods land.

## Future Slices

Sustained Mode, Delegation, Vault, Policy, gateway audit streams, and canonical Knowledge Store injection records remain out of the client until their specs, NanoCore routes, and schemas land in the same slice.
