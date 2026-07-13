# App API

Status: Accepted
Date: 2026-05-31
Updated: 2026-07-12

## Purpose

This document is the boundary map for NanoCore App API surfaces.

It explains which APIs are app-level projections, which packages own executable contracts, and where contributors should make changes.

It is not the canonical field-by-field payload contract.

Machine-readable App API payload contracts live in `@openkit/app-api-schemas`.

Core protocol payload contracts live in `@openkit/protocol`.

NanoCore route behavior lives in `apps/nanocore`.

Typed client behavior lives in `@openkit/core-client`.

Generated OpenAPI behavior is a build-time projection owned by `docs/specs/20260704-app_api_openapi_projection.md`.

## Source Of Truth

| Concern | Canonical source |
| --- | --- |
| Stable Core concepts and object boundaries | `docs/core/core-concepts.md` |
| Stable Core command, event, item, lifecycle, and stream semantics | `docs/core/protocol.md` and `docs/core/communication.md` |
| Core protocol records, requests, responses, errors, and event envelopes | `@openkit/protocol` |
| App API payload schemas | `@openkit/app-api-schemas` |
| NanoCore HTTP route behavior, status codes, and server-side redaction | `apps/nanocore` |
| Typed browser and integration-test client behavior | `@openkit/core-client` |
| Generated OpenAPI document and drift checks | `docs/specs/20260704-app_api_openapi_projection.md` |
| Web UI workflows that consume App API projections | `apps/web` |
| Prior implementation plans and trade-off notes | `docs/specs/` and `docs/working_logs/` |

When this document conflicts with a package schema, route implementation, or test, fix the drift instead of treating this document as executable truth.

## Ownership

`@openkit/protocol` owns stable Core records, command requests, command responses, event envelopes, error shapes, capability metadata, and conformance fixtures.

`@openkit/app-api-schemas` owns runtime-neutral schemas for NanoCore App API payloads.

`apps/nanocore` owns App API route behavior, read-model builders, runtime config services, diagnostics assembly, OAuth coordination, Chat Mode execution, internal-agent projections, and gateway routing.

`@openkit/core-client` owns transport, response validation, request ID insertion, SSE iteration, and the composed TypeScript client surface.

`apps/web` consumes the composed client and should not duplicate route parsing or App API schemas.

## Boundary

The App API owns:

- UI read models for dashboards, item logs, Action Center rows, and product-visible agent catalog views.
- Settings, setup, runtime config, diagnostics, OAuth, and browser-auth payloads.
- Dashboard-local search across app records.
- Automation definitions and scheduling control surfaces.
- Chat Mode, Task Mode, Goal Mode, and NanoCore internal-agent product projections.
- Knowledge and notebook product projections over Core knowledge semantics.
- Workspace repository resource setup and redacted diagnostics.
- Thread Goal Mode planning, plan approval, steering, progress, terminal summaries, and stored verification evidence projections.
- Provider registry summaries and gateway diagnostics that are safe for the UI.
- NanoCore readiness, token administration, vault unlock/status, workspace export/import, Git push records, and worker MCP catalog projections as those accepted specs are implemented.
- OpenAI-compatible gateway endpoints that agents can consume with standard SDKs.

The App API must not redefine:

- Core workspace, thread, turn, item, approval, artifact, knowledge, or agent-session semantics.
- The SSE event envelope or replay cursor rules.
- Turn lifecycle or active-turn input semantics.
- Agent runtime private protocols.
- Agent manifest resolution semantics.
- Secret vault semantics or raw credential material.

## Design Rules

- Keep the Core protocol stable and unchanged when adding UI convenience endpoints.
- Keep App API schemas in `@openkit/app-api-schemas`.
- Keep App API route behavior and read-model construction in `apps/nanocore`.
- Keep typed request helpers and response parsing in `@openkit/core-client`.
- Keep OpenAI-compatible gateway endpoints under `/v1/*` so agents can use standard SDKs.
- Generate OpenAPI from shared schemas and the canonical operation catalog used by runtime registrations; do not hand-edit the generated document or generate first-party types from it.
- Return server-composed read models that reduce Web round trips, but derive them from Core records where possible.
- Treat App API payloads as replaceable product projections over Core records.
- Do not expose raw provider API keys, OAuth tokens, authorization headers, account IDs, full prompt cache keys, host paths, worker launch commands, environment variables, or adapter-native runtime config.
- Because this repository is in internal development, remove obsolete App API shapes instead of preserving compatibility shims.

## Core HTTP And SSE Projection

NanoCore exposes a current HTTP/SSE projection of the Core protocol for the Web UI and protocol integration tests.

These routes are transport projections over Core semantics, not App API ownership of Core records.

Their record, request, response, error, and SSE envelope schemas come from `@openkit/protocol`.

The typed client surface is `client.core` in `@openkit/core-client`.

The Core HTTP/SSE projection is deliberately outside the App API OpenAPI document. Its route schemas, event contract, coverage, and client behavior remain governed by `@openkit/protocol`, the Core documents, NanoCore Core-route tests, and `client.core`; serving both surfaces from NanoCore does not merge their ownership.

Current Core projection route families include the following.

| Surface | Routes |
| --- | --- |
| Discovery | `GET /api/meta` |
| Workspaces | `GET /api/workspaces`, `POST /api/workspaces`, `GET /api/workspaces/:workspaceId`, `PATCH /api/workspaces/:workspaceId`, `GET /api/workspaces/:workspaceId/resources` |
| Knowledge | `GET /api/workspaces/:workspaceId/knowledge`, `POST /api/workspaces/:workspaceId/knowledge`, `PATCH /api/workspaces/:workspaceId/knowledge/:knowledgeEntryId`, `DELETE /api/workspaces/:workspaceId/knowledge/:knowledgeEntryId` |
| Threads | `GET /api/workspaces/:workspaceId/threads`, `POST /api/workspaces/:workspaceId/threads`, `GET /api/workspaces/:workspaceId/threads/:threadId`, `PATCH /api/workspaces/:workspaceId/threads/:threadId`, `POST /api/workspaces/:workspaceId/threads/:threadId/archive` |
| Turns | `POST /api/turns`, `GET /api/workspaces/:workspaceId/threads/:threadId/turns/:turnId`, `POST /api/workspaces/:workspaceId/threads/:threadId/turns/:turnId/interrupt` |
| Approvals | `POST /api/approvals/:approvalRequestId/respond` |
| Artifacts | `GET /api/workspaces/:workspaceId/artifacts`, `GET /api/workspaces/:workspaceId/artifacts/:artifactId`, `PATCH /api/workspaces/:workspaceId/artifacts/:artifactId`, `GET /api/workspaces/:workspaceId/artifacts/:artifactId/content` |
| Turn stream | `GET /api/workspaces/:workspaceId/threads/:threadId/events?turnId=:turnId&since=:sequence` |

All mutating Core projection routes require `requestId`.

`@openkit/core-client` may generate a missing client-side `requestId`, but NanoCore still validates that the final request body includes one.

NanoCore persists command idempotency in the SQLite database that owns the command scope: workspace-scoped commands use that workspace's `workspace.sqlite`, while commands without a workspace scope such as `workspace.create` use the actor's `user.sqlite`.

The target ledger covers `workspace.create`, `workspace.update`, `knowledge.create`, `knowledge.update`, `knowledge.delete`, `thread.create`, `thread.update`, `thread.archive`, `turn.start`, `turn.input.submit`, `turn.interrupt`, `git_push.approval.request`, `approval.respond`, `artifact.metadata.update`, `artifact.review.decide`, and `goal.review.decide`.

Duplicate requests with the same command, resource scope, `requestId`, and canonical input hash return the current resource snapshot for the original response resource.

Concurrent duplicates in one server process await the same command result instead of racing a second mutation.

Reusing the same command, resource scope, and `requestId` with different input returns `409 idempotency_key_conflict`.

Idempotency records retain only command name, request ID, non-secret scope IDs, input hash, response resource kind and ID, creation timestamp, and expiry timestamp.

They are retained for seven days and must not contain prompts, knowledge content, context package content, provider config, OAuth state, secrets, full request bodies, or full response bodies.

The live event stream is turn-scoped SSE.

Because this stream belongs to the Core projection, it is not registered as an App API OpenAPI operation. A future App API-owned streaming route would follow the conditional projection rule in `docs/specs/20260704-app_api_openapi_projection.md` without changing ownership of this Core stream.

Every SSE message uses the event envelope defined by `docs/core/protocol.md`.

Command-caused events carry the initiating command `requestId`, while system or replay-only events carry `requestId: null`.

The `since` cursor, reconnect, terminal replay, cursor-expiry, and `204 No Content` terminal-cursor rules are defined by the stream cursor and replay rules in `docs/core/protocol.md`.

## App API Slices

This section lists current App API slices for orientation only.

Payload fields, optionality, and validation rules belong in `@openkit/app-api-schemas`.

Client method names belong in `@openkit/core-client`.

### Dashboards And Item Read Models

The dashboard slice returns product-shaped read models for workspace and thread screens.

Current route families are `GET /api/app/workspaces/:workspaceId/dashboard`, `GET /api/app/workspaces/:workspaceId/threads/:threadId/dashboard`, and `GET /api/app/workspaces/:workspaceId/threads/:threadId/items`.

Schema ownership lives in `packages/app-api-schemas/src/dashboard.ts`.

Client methods live under `client.app` and `client.core` where the item history route is exposed as a Core-adjacent replay helper.

Routing explanations and product work status are App API read models, not Core protocol events.

### Workspace Repository Resources

Workspace repository resources bind a workspace to a local git repository that governed worker flows may use through declared workspace materialization, review, and apply contracts.

Current route families are `GET /api/app/workspaces/:workspaceId/repositories`, `GET /api/app/workspaces/:workspaceId/repositories/diagnostics`, `POST /api/app/workspaces/:workspaceId/repositories/default`, `PUT /api/app/workspaces/:workspaceId/repositories/default`, `POST /api/app/workspaces/:workspaceId/repositories/:resourceId/git-push/approval`, `POST /api/app/workspaces/:workspaceId/repositories/:resourceId/git-push`, `GET /api/app/workspaces/:workspaceId/repositories/git-push-records`, and `GET /api/app/workspaces/:workspaceId/repositories/git-push-records/:pushRecordId`.

The set-default routes validate that the submitted local path exists and looks like a git repository, but response payloads are redacted and do not expose raw host paths.

Repository diagnostics report safe display names, readiness state, validation codes, and user-safe messages.

Schema ownership lives in `packages/app-api-schemas/src/repository.ts`.

Route behavior and local path validation live in `apps/nanocore`.

The current Web UI consumes the repository prerequisite indirectly through Goal Mode and worker-turn errors; a first-class repository picker remains deferred.

### Goal Mode

Goal Mode is an App API workflow over the stable Core workspace, thread, turn, and item model.

Current route families are `GET /api/app/workspaces/:workspaceId/threads/:threadId/goal`, `POST /api/app/workspaces/:workspaceId/threads/:threadId/goal`, `POST /api/app/workspaces/:workspaceId/threads/:threadId/goal/plan`, `POST /api/app/workspaces/:workspaceId/threads/:threadId/goal/plan/approve`, `POST /api/app/workspaces/:workspaceId/threads/:threadId/goal/plan/revise`, `POST /api/app/workspaces/:workspaceId/threads/:threadId/goal/pause`, `POST /api/app/workspaces/:workspaceId/threads/:threadId/goal/resume`, `POST /api/app/workspaces/:workspaceId/threads/:threadId/goal/step`, `POST /api/app/workspaces/:workspaceId/threads/:threadId/goal/steering`, and `POST /api/app/workspaces/:workspaceId/threads/:threadId/goals/:goalId/reviews/:reviewId/decision`.

The summary route returns no-goal, planning, awaiting-plan-approval, running, paused, reviewing, verifying, awaiting-user, blocked, failed, aborted, and completed read models.

Goal summaries can include the current task, task counts, pending human attention, queued and applied steering counts, terminal stop reason, terminal summary, stored task verification evidence, artifact ids, risks, and suggested next work. Task Evaluator loops and an independent final-verifier completion gate remain deferred.

The start route records the objective as a durable user-message item and rejects a second active goal in the same thread.

The plan route currently uses the app-local planner path and deterministic fallback to produce an approvable plan.

The approval route persists ordered goal tasks and marks dependency-free tasks ready without starting a worker turn.

The step route starts one bounded worker envelope iteration. The request requires `requestId` and may include `followUpDrainMode` plus `reviewPolicyOverride: human | none`; omission defaults to `human`. The response returns the refreshed goal summary, worker turn id, stop reason, checkpoint stage, redacted or nullable worker session id, evidence item and artifact ids, stop decision, and product-facing pending attention.

`human` creates a durable actionable unresolved Goal Review. Accepting it atomically resolves the review and advances the task graph. `none` skips only that completed step's review and still advances dependencies and remaining tasks.

The steering route records active safe-point steering or human-gated follow-up input and returns whether the input was queued or blocked.

The test supervise-step route is a deterministic test-support surface for local e2e and story validation. It is not the product path and should not be used by Web outside deterministic fixtures.

Schema ownership lives in `packages/app-api-schemas/src/dashboard.ts`.

Typed browser helpers live under `client.app` in `@openkit/core-client`.

### Agent Catalog And Action Center

The Agent Catalog slice returns product-visible agent entries without adapter-native runtime config.

Current route families are `GET /api/app/agents`, `GET /api/app/agents/:agentId`, and `POST /api/app/workspaces/:workspaceId/agents/health/refresh`.

The global list and detail reads are built only from the request actor's visible workspace set. Workspace-scoped tokens are limited to token-bound workspaces with active membership before catalog entries are projected; entries continue to exclude adapter-native runtime config.

The current global routes still de-duplicate the union of visible workspace catalogs by agent id and use the first visible workspace in store order for both list and detail reads. This is an implementation projection, not the canonical workspace-visible catalog semantic owned by `docs/core/agent-supply.md`; an explicit workspace route shape or a deliberate cross-workspace index remains unresolved.

The Action Center slice returns unified Human Attention rows for pending human actions and product-visible review states.

Current route families are `GET /api/app/workspaces/:workspaceId/action-center`, `POST /api/app/workspaces/:workspaceId/artifacts/:artifactId/review`, and `POST /api/app/workspaces/:workspaceId/threads/:threadId/goals/:goalId/reviews/:reviewId/decision`.

The Goal Review projection includes live default-accept unresolved rows with an executable accept action; other verdicts retain their own projected actions.

Approval response mutation stays on the Core command path at `POST /api/approvals/:approvalRequestId/respond`.

Question response mutation stays on the Core turn-input path at `POST /api/turns`.

Schema ownership lives in `packages/app-api-schemas/src/agents.ts`, `packages/app-api-schemas/src/action-center.ts`, and the health-refresh schema in `packages/app-api-schemas/src/dashboard.ts`.

Client methods live under `client.agents` and `client.actionCenter`.

### Diagnostics And Setup

The Settings diagnostics slice returns service status, gateway endpoint status, gateway usage summaries, provider diagnostics, provider registry summaries, default provider selections, Codex OAuth account summaries, runtime config status, internal-agent availability, and capability flags.

Current route families are `GET /api/app/diagnostics` and `GET /api/setup/diagnostics`.

The aggregate `GET /api/diagnostics` route is a redacted service inspection surface, not the Settings App API contract.

Diagnostics responses must never include prompts, raw knowledge content, raw context package content, raw provider tokens, authorization headers, API keys, account IDs, raw prompt cache keys, or secret-bearing provider config.

Schema ownership lives in `packages/app-api-schemas/src/diagnostics.ts`.

Client methods live under `client.app`.

### Storage Layout Report

The storage layout report slice returns the read-only NanoCore data-root ownership report for operator inspection: server, user, and workspace database presence, migration ledgers, derived-index directory status, and quarantined storage files.

The current route family is `GET /api/app/storage/layout-report`.

The route is a deployment-wide administration surface, not a workspace diagnostic, and follows the local-or-`server-admin` authority rule owned by `docs/specs/20260704-remote_auth_credential_bootstrap.md`.

The report is diagnostic and read-only. It must not repair, migrate, delete, salvage, or read quarantined file contents.

Schema ownership lives in `packages/app-api-schemas/src/storage.ts`.

Client methods live under `client.app`.

### Runtime Config And Settings

Runtime config, Settings editor payloads, Admin API schemas, provider config summaries, and stale-session status are App API projections.

Current route families are `GET /api/admin/config/files`, `GET /api/admin/config/file?id=:fileId`, `POST /api/admin/config/file`, `PUT /api/admin/config/file`, `POST /api/admin/config/validate`, `POST /api/admin/config/reload`, and `GET /api/admin/config/schemas`.

Schema ownership lives in `packages/app-api-schemas/src/runtime-config.ts`.

Client methods live under `client.runtimeConfig`.

`MaterializedWorkspaceRoot` is App/NanoCore-local.

Core protocol agent session records may expose only product-safe sandbox summaries or workspace root references, never host paths, worker paths, launch commands, environment variables, or adapter-native config.

### Auth And Codex OAuth

Better Auth email/password routes are mounted under `/api/auth/*`.

Their browser-facing client methods live under `client.auth.email`.

OpenAI Codex/ChatGPT subscription access uses Codex-managed account slots.

Current account-management route families are `GET /api/app/oauth/openai-codex/accounts`, `POST /api/app/oauth/openai-codex/accounts`, `PATCH /api/app/oauth/openai-codex/accounts/:accountSlotId`, `DELETE /api/app/oauth/openai-codex/accounts/:accountSlotId`, `GET /api/app/oauth/openai-codex/accounts/:accountSlotId/status`, `POST /api/app/oauth/openai-codex/accounts/:accountSlotId/start`, `POST /api/app/oauth/openai-codex/accounts/:accountSlotId/cancel`, and `POST /api/app/oauth/openai-codex/accounts/:accountSlotId/logout`.

All OAuth actions are account-scoped.

NanoCore must not expose unscoped status, start, cancel, or logout routes.

Public OAuth payloads expose only sanitized account state and login-flow metadata.

Token material stays inside Codex-managed auth storage under the server data root.

Schema ownership lives in `packages/app-api-schemas/src/auth.ts` and `packages/app-api-schemas/src/oauth.ts`.

Client methods live under `client.auth.email` and `client.oauth.openaiCodex`.

### Automations

Automations are app-level scheduling definitions.

They are separate from Core turns until an enabled automation actually starts work.

When an enabled automation fires, Core should represent the actual work through the normal workspace, thread, turn, and item model.

Current route families are `GET /api/app/automations`, `POST /api/app/automations`, `PATCH /api/app/automations/:automationId`, and `DELETE /api/app/automations/:automationId`.

Schema ownership lives in `packages/app-api-schemas/src/automation.ts`.

Client methods live under `client.app`.

### Chat Mode And Internal Agents

Chat Mode is the lightweight App API projection over the Core Assistant contract.

It is not a replacement for the Core turn protocol, Task Mode, or Goal Mode.

It must not allocate a worker session directly.

The current implementation route family is `POST /api/app/quick-chat`.

Current behavior returns completed, non-streaming responses.

Persistence and `GET /api/app/quick-chat/:quickChatId` are not part of the current contract.

The accepted target is `docs/specs/20260704-chat_mode_assistant.md`: Assistant answers, clarification gates, Task Mode handoff, and Goal Mode handoff are product projections over Core Assistant and Workflow Coordinator records. The `quick-chat` route name is implementation debt if it cannot carry that target clearly.

Schema ownership lives in `packages/app-api-schemas/src/quick-chat.ts` and internal-agent diagnostics live in `packages/app-api-schemas/src/diagnostics.ts`.

Client methods live under `client.app`.

### V1 Foundation And Administration Surfaces

The 20260704 accepted specs add App API projection requirements for NanoCore readiness, remote auth token administration, vault unlock and status, workspace backup/export/import, Git push approval and records, worker MCP catalog read models, capability usage summaries, and App API OpenAPI serving.

These route families are accepted target surfaces even when their implementation is not started.

Their schemas belong in `@openkit/app-api-schemas`, their route behavior belongs in `apps/nanocore`, their typed helpers belong in `@openkit/core-client` when first-party consumers need them, and their OpenAPI entries must be generated from the same schema and route registrations.

The App API projection must keep each surface inside its owning contract:

- boot, liveness, readiness, and recovery diagnostics follow `docs/specs/20260704-nanocore_bootstrap_readiness.md`
- storage layout reports follow `docs/specs/20260703-storage_layout_record_ownership.md`
- bearer-token bootstrap and bundled CLI channel auth follow `docs/specs/20260704-remote_auth_credential_bootstrap.md`
- vault unlock/status and backend summaries follow `docs/specs/20260704-vault_backend_implementation.md`
- workspace export/import and data-root migration follow `docs/specs/20260704-workspace_backup_export_import.md`
- commit-on-apply and GitHub-only push records follow `docs/specs/20260704-git_write_workflow.md`
- worker MCP catalog and call projections follow `docs/specs/20260704-worker_mcp_tool_supply.md`
- capability usage summaries follow `docs/specs/20260704-capability_usage_gateway_foundation.md`
- OpenAPI generation and serving follow `docs/specs/20260704-app_api_openapi_projection.md`

### Search And Feedback

Dashboard-local search returns product search results across app records.

The current route family is `GET /api/app/search`.

Per-turn feedback is product metadata attached to a turn.

The current route family is `POST /api/turns/:turnId/feedback`.

Feedback does not redefine the Core turn lifecycle.

Schema ownership lives in `packages/app-api-schemas/src/search.ts` and `packages/app-api-schemas/src/feedback.ts`.

Client methods live under `client.app`.

## Agent-Facing LLM Gateway

NanoCore exposes an OpenAI-compatible gateway for agents and SDK clients.

These endpoints are not under `/api/app/*` because agents should be able to point standard OpenAI SDK clients at NanoCore.

The agent-facing gateway belongs to the capability plane described in `docs/core/communication.md`.

It is not the Core-to-agent control protocol and must not expose raw workspace, turn, item, or secret internals.

Current route families are `GET /health`, `GET /api/health`, `GET /v1/models`, `POST /v1/chat/completions`, and `POST /v1/responses`.

NanoCore does not expose `POST /v1/completions`.

Agents should use `/v1/chat/completions` or `/v1/responses`.

`POST /v1/chat/completions` accepts OpenAI-compatible Chat Completions requests and routes them through the configured gateway provider.

`POST /v1/responses` accepts OpenAI-compatible Responses requests and routes them through the configured gateway provider.

Provider-specific unknown OpenAI-compatible fields pass through to the provider dispatcher when the selected route supports them.

When the selected provider is `openai_codex`, Chat Completions are supported through the text-only Chat Completions to Responses bridge because ChatGPT subscription inference is Responses-native.

The Gateway supports native Responses providers and bridgeable chat-native providers.

Bridgeable requests are limited to text input, instructions, simple function tools, token limits, temperature, reasoning effort, and simple tool choice.

Rich Responses features such as built-in tools, remote MCP, computer use, file input, image input, and non-text content return `unsupported_gateway_feature` when the selected provider is chat-only.

OpenAI-compatible cache fields such as `prompt_cache_key` and `prompt_cache_retention` pass through gateway routes.

Every native upstream Chat Completions or Responses request sent by the Gateway includes `prompt_cache_key`.

NanoCore resolves the key from the caller's top-level key, then `metadata.openkit.promptCacheKey`, then stable non-secret OpenKit scope metadata, then a request-scoped fallback.

The fallback satisfies the upstream wire shape but does not create cross-request cache reuse.

`prompt_cache_retention` is only passed through.

NanoCore does not default retention to `24h` because that would change retention semantics.

Provider diagnostics expose endpoint-specific capability metadata through the App Diagnostics provider registry:

```json
{
  "chatCompletions": "native",
  "responses": "bridged"
}
```

Capability values are:

- `native`: the provider has a direct wire API for that endpoint family.
- `bridged`: NanoCore can convert a compatible request to another native endpoint family.
- `unsupported`: NanoCore rejects the request for that provider.

Default assignments are:

- `openai`: Chat Completions native and Responses native.
- `openai_codex`: Responses native and Chat Completions bridged.
- Other OpenAI-compatible providers: Chat Completions native and Responses bridged.

Public App API and diagnostics surfaces expose only sanitized account and provider metadata.

They never expose tokens, account IDs, authorization headers, or raw prompt cache keys.

## Change Checklist

Use this checklist for App API changes.

1. If the change affects stable Core semantics, update `@openkit/protocol` and `docs/core/*` before changing App API projections.
2. Add or update tests first in `@openkit/app-api-schemas` when payload shape changes.
3. Update NanoCore route tests and route behavior in `apps/nanocore`.
4. Update `@openkit/core-client` tests and client methods when browser or integration consumers need typed access.
5. Update Web tests and UI code when `apps/web` consumes the changed surface.
6. Update this document when a route family, ownership rule, or boundary rule changes.
7. Remove obsolete App API shapes instead of preserving compatibility aliases.
8. Re-run the relevant package tests, typechecks, lints, and builds for the changed packages.

Do not add App API schemas to `@openkit/core-client`.

Do not add Core protocol records to `@openkit/app-api-schemas`.

Do not add route-local read-model schemas inside NanoCore handlers when they should be shared with the client.

## Related Docs

- `docs/core/core-concepts.md`
- `docs/core/protocol.md`
- `docs/core/communication.md`
- `docs/core/agent-capability.md`
- `docs/core/identity.md`
- `docs/core/knowledge.md`
- `docs/specs/20260628-protocol_contract_consolidation.md`
- `docs/specs/20260628-nanocore_config_identity_contract.md`
- `docs/specs/20260526-llm_gateway_responses_api.md`
- `docs/specs/20260526-codex_chatgpt_subscription_login.md`
- `docs/specs/20260528-core_client_boundary.md`
- `docs/specs/20260704-chat_mode_assistant.md`
- `docs/specs/20260704-task_mode_worker_delegation.md`
- `docs/specs/20260704-goal_mode_coordination.md`
- `docs/specs/20260704-workflow_coordinator_internal_agent.md`
- `docs/specs/20260704-knowledge_manager_internal_agent_runtime.md`
- `docs/specs/20260704-nanocore_bootstrap_readiness.md`
- `docs/specs/20260704-remote_auth_credential_bootstrap.md`
- `docs/specs/20260704-vault_backend_implementation.md`
- `docs/specs/20260704-workspace_backup_export_import.md`
- `docs/specs/20260704-git_write_workflow.md`
- `docs/specs/20260704-worker_mcp_tool_supply.md`
- `docs/specs/20260704-capability_usage_gateway_foundation.md`
- `docs/specs/20260704-app_api_openapi_projection.md`

## External References

- [HKUDS/nanobot provider registry](https://github.com/HKUDS/nanobot/blob/main/nanobot/providers/registry.py)
- [HKUDS/nanobot provider factory](https://github.com/HKUDS/nanobot/blob/main/nanobot/providers/factory.py)
- [HKUDS/nanobot OpenAI-compatible API server](https://github.com/HKUDS/nanobot/blob/main/nanobot/api/server.py)
- [HKUDS/nanobot configuration docs](https://github.com/HKUDS/nanobot/blob/main/docs/configuration.md)
- [Bifrost dual OpenAI provider support](https://docs.getbifrost.ai/providers/supported-providers/openai)
- [OpenAI Responses API reference](https://developers.openai.com/api/reference/resources/responses/methods/create)
