# App API

Status: Accepted
Date: 2026-05-31
Updated: 2026-07-17

## Purpose

This document is the boundary map for NanoCore App API surfaces.

It explains which APIs are app-level projections, which packages own executable contracts, and where contributors should make changes.

It is not the canonical field-by-field payload contract.

Machine-readable App API payload contracts live in `@openkit/app-api-schemas`.

Core protocol payload contracts live in `@openkit/protocol`.

NanoCore route behavior lives in `apps/nanocore`.

Typed client behavior lives in `@openkit/core-client`.

Generated OpenAPI behavior is a build-time projection owned by `docs/specs/20260704-app_api_openapi_projection.md`.

The App API, `@openkit/core-client`, bundled CLI, unified Skill, and Web are release-coupled projections under `docs/core/contract-evolution.md`. They must agree within one OpenKit release but do not promise compatibility for an independently versioned client.

## Source Of Truth

| Concern | Canonical source |
| --- | --- |
| Stable Core concepts and object boundaries | `docs/core/core-concepts.md` |
| Stable Core command, event, item, lifecycle, and stream semantics | `docs/core/protocol.md` and `docs/core/communication.md` |
| Accepted workflow semantics, authority, failure, recovery, and verification contracts | The owning accepted file under `docs/specs/` |
| Core protocol records, requests, responses, errors, and event envelopes | `@openkit/protocol` |
| App API payload schemas | `@openkit/app-api-schemas` |
| NanoCore HTTP route behavior, status codes, and server-side redaction | `apps/nanocore` |
| Typed browser and integration-test client behavior | `@openkit/core-client` |
| Generated OpenAPI document and drift checks | `docs/specs/20260704-app_api_openapi_projection.md` |
| Web UI workflows that consume App API projections | `apps/web` |
| Change execution, rollout evidence, and archived work logs | `docs/changes/` and `docs/working_logs/` |

Accepted Core and specification contracts own the semantic target. Package schemas, routes, generated OpenAPI, clients, and tests own the currently executable projection and must be corrected when they conflict with that target; this document must label such divergence instead of silently treating current code as authorization. For a fact that is purely about the current route or payload shape and has no semantic design consequence, verified code and generated-contract evidence remain authoritative.

## Ownership

`@openkit/protocol` owns stable Core records, command requests, command responses, event envelopes, error shapes, capability metadata, and conformance fixtures.

`@openkit/app-api-schemas` owns runtime-neutral schemas for NanoCore App API payloads.

`apps/nanocore` owns App API route behavior, read-model builders, runtime config services, diagnostics assembly, OAuth coordination, Chat Mode execution, and gateway routing.

`@openkit/core-client` owns transport, response validation, request ID insertion, SSE iteration, and the composed TypeScript client surface.

`apps/web` consumes the composed client and should not duplicate route parsing or App API schemas.

## Boundary

The App API owns:

- UI read models for dashboards, item logs, Action Center rows, and product-visible agent catalog views.
- Settings, setup, runtime config, diagnostics, OAuth, and browser-auth payloads.
- Dashboard-local search across app records.
- Automation definitions and scheduling control surfaces.
- Chat Mode, Task Mode, and Goal Mode product projections over their owning durable records.
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
- Advance one exact release contract identity when a supported App API shape changes, update every first-party consumer together, and fail typed on mismatch.
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

The current generic Artifact `PATCH` route accepts title, status, and summary changes without an expected Artifact version or the exact `artifact-reference` Item lineage required by the target contract. It remains current-state documentation only, is excluded from the target command ledger, and is removal-only until an accepted owner-specific mutation contract replaces it. New consumers MUST use the producing Turn or accepted Artifact Review owner instead of extending this route or inventing `artifact.metadata.update`.

All mutating Core projection routes require `requestId`.

`@openkit/core-client` may generate a missing client-side `requestId`, but NanoCore still validates that the final request body includes one.

NanoCore persists command idempotency in the SQLite database that owns the command scope: workspace-scoped commands use that workspace's `workspace.sqlite`, while commands without a workspace scope such as `workspace.create` use the actor's `user.sqlite`.

The target ledger covers `workspace.create`, `workspace.update`, `knowledge.create`, `knowledge.update`, `knowledge.delete`, `thread.create`, `thread.update`, `thread.archive`, `turn.start`, `turn.input.submit`, `turn.interrupt`, `chat.start`, `task.start`, `goal.start`, `goal.plan`, `goal.plan.approve`, `goal.plan.revise`, `goal.pause`, `goal.resume`, `goal.step`, `goal.steering.send`, `goal.steering.follow_up`, `goal.steering.cancel`, `goal.review.decide`, `worker.recovery.retry`, `git_push.approval.request`, `approval.respond`, `artifact.import`, `artifact.introduce`, `artifact.review.decide`, `material.create`, `material.save`, `material.bind`, `material.unbind`, `material.exclude`, and `material.restore`.

By default, duplicate requests with the same command, resource scope, `requestId`, and canonical input hash return the current resource snapshot for the original response resource. An owning accepted specification MAY instead require one bounded immutable non-secret result snapshot when a command spans multiple owners or reports a completed transition that no single current resource can replay; that snapshot is evidence only and cannot own lifecycle state. `goal.steering.send` always replays its original immutable `queued` acceptance response even after delivery reaches a terminal state.

Concurrent duplicates in one server process await the same command result instead of racing a second mutation.

Reusing the same command, resource scope, and `requestId` with different input returns `409 idempotency_key_conflict`.

Idempotency records retain only command name, request ID, non-secret scope IDs, input hash, response resource kind and ID, creation timestamp, and expiry timestamp. A multi-owner command that cannot replay from one current resource MAY retain one bounded schema-specific non-secret result snapshot; `goal.step` is limited to Goal, task, Turn, outcome, stop reason, evidence, and review identifiers. Such a snapshot is replay evidence only and MUST NOT drive business transitions or become a second workflow owner.

Within the active workflow contract group, `task.start` stores no payload snapshot and replays from its response Turn plus existing Item, Artifact, Review, and Goal owners. `chat.start` is the narrower mutable-clarification exception: its accepted specification permits only a closed result kind, the HTTP success status, and required downstream Task Turn or Goal and Goal Turn identifiers. The normal receipt resource identifier names the original Chat Turn; NanoCore derives the initiating and result Item identifiers from that Turn and the closed result-kind mapping. Neither command may retain a Turn, Item, Coordinator decision, completion text, explanation, prompt, or response body in the ledger.

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

The summary route returns no-goal, planning, awaiting-plan-approval, running, paused, reviewing, awaiting-user, blocked, failed, aborted, and completed read models. Goal schemas and workspace import reject the unowned `verifying` lifecycle value; verification remains a separate evidence record rather than a Goal state.

Goal summaries can include the current task, task counts, pending human attention, terminal stop reason, terminal summary, stored task verification evidence, artifact ids, risks, and suggested next work. They expose no queued or applied steering counts until the exact S16 durable state exists; fixed zero values are not an implementation. Task Evaluator loops and an independent final-verifier completion gate remain deferred.

Goal Task read models, NanoCore storage and workspace-import contracts, and generated OpenAPI reject the unowned `skipped` and `needs_revision` states. Task counts and terminal summaries expose neither state.

The start, plan creation, approval, revision, pause, resume, and bounded step routes require a client-visible `requestId`. Goal start records the objective as a deterministic durable user-message Item and rejects a second active Goal in the same Thread. Pause and resume accept exactly `{ requestId }`; the Core Client may generate a missing client-side identity, but NanoCore rejects an absent or extended raw request body.

Pause and resume separate the historical command result from mutable Goal truth: pause returns `{ outcome: "paused", goal }`, resume returns `{ outcome: "resumed", goal }`, and `goal` is the current projection of the exact original Goal named by the command receipt. The receipt contains only that Goal id and never a copied Goal response. NanoCore reads or writes that receipt in the same Workspace transaction as the status transition, requires `currentTaskId=null`, `terminalStopReason=null`, and no non-terminal `pending`, `running`, or `awaiting_human` Turn, and replays without repeating the transition or resolving a newer Goal. The existing Goal and Task reservation writes now recheck and commit together so a concurrent bounded step cannot silently undo an accepted pause; this narrow lifecycle mutex does not satisfy the still-open complete `goal.step` launch-fence contract.

The plan route accepts exactly `{ requestId }`, obtains one complete validated Plan from Workflow Coordinator, stores it as an immutable Workspace-scoped `GoalPlanRecord`, and returns both that Plan and its lightweight `plan` Item projection. The record and `GoalRecord.planItemId` are approval authority; the Item proves visible Workspace and Thread lineage but cannot replace, mutate, or reconstruct Plan content. Revision requires `{ requestId, revision }`, preserves the old immutable Plan and Item, clears the active pointer, and records the revision as a deterministic request-owned Item before a later plan command creates a new authority pair.

Approval accepts exactly `{ requestId, planItemId }`; NanoCore loads the active immutable Plan server-side, verifies its digest, Goal and Plan Item lineage, and graph, then creates every complete ordered immutable Goal Task snapshot and changes the Goal to `running` with `currentTaskId=null` in one Workspace transaction. Dependency-free Tasks start `ready`, dependent Tasks start `pending`, and no worker Turn starts. A non-active Plan id returns `stale`; missing, corrupt, lineage-invalid, or partially applied authority returns `recovery_required`; graph invalidity returns `goal_plan_invalid`; no path trusts caller Plan content or repairs authority from the lightweight Item or current read model.

Approval exact replay and changed-input conflict use the existing app-local command receipt. The accepted two-store compromise persists that receipt immediately after the Workspace approval transaction; if a crash leaves the complete approved Goal and Task tuple without its receipt, retry returns `recovery_required` instead of inferring the winning request, synthesizing a receipt, reverting Tasks, or creating a settlement workflow.

Workspace export reads Goal, historical and active Plan, and Goal Task records from one SQLite snapshot. Import validates source digests and Plan/Task coherence before reminting, applies all imported rows in one transaction, remints identity-bearing references through the canonical maps, recomputes each Plan digest only after reminting, and rejects malformed, duplicate, incomplete, or incoherent records instead of dropping or repairing them.

The step route accepts exactly `{ requestId }` and starts one bounded worker envelope iteration. It reads the complete immutable approved Goal Task, verifies its active Plan lineage, and gives Workflow Coordinator the exact objective, acceptance criteria, ordered resources, expected Artifacts, context budget, verification checks, review policy, escalation conditions, and eligible Review context; incomplete or mismatched request facts return `recovery_required` before step effects. The parsed Coordinator request becomes the existing Turn, scheduler, AEP, worker, and Turn-owned Item input as compact JSON. `reviewPolicyOverride`, `followUpDrainMode`, and generic queue fields are rejected rather than treated as compatibility input. The response is exactly `{ goal, result }`, where `goal` is the current projection of the original Goal and `result` contains only `taskId`, `turnId`, `outcome`, `shouldStop`, `stopReason`, Item and Artifact evidence ids, and nullable `reviewId`. Coordinator, Context Assembly, worker Session, checkpoint-stage, and duplicate pending-attention projections remain with their owning diagnostics, recovery, Goal, and Action Center records rather than the replay receipt. NanoCore now derives the Turn from request identity, commits the runnable Goal, first ready Task, allowed launch decision, and request-bound `preparing` checkpoint together, performs receipt-first replay, blocks competing steps behind any uncleared Goal checkpoint, and publishes the bounded receipt before terminal cleanup.

A Goal worker user-input or approval gate is an acknowledged nonterminal step result. The response or decision command attaches its Item to the same Turn, closes that old Turn and checkpoint, returns the Task to `ready`, leaves the Goal `running` with `currentTaskId=null`, and requires a new `goal.step`; approval denial preserves its durable denial evidence for the next Coordinator input. The command receipt is published only after the exact Item, Turn, checkpoint, Goal Task, and Goal tuple is durable, and no path resumes the prior worker Session.

`POST /api/turns` accepts two strict payloads. Ordinary input is exactly `{ workspaceId, threadId, requestId, input, modelId? }`; a response to an exact user-input gate is exactly `{ workspaceId, threadId, turnId, requestId, answers }`, where `answers` is `{ [questionId]: [string] }`, its keys equal every and only question id in the referenced completed request Item, and the one array member is non-empty. V1 has no multi-select mode. Request producers reject duplicate question ids before writing the Item. A gate containing a secret question returns `400 secret_input_not_supported` before writes until a safe secret-answer owner exists. Unknown fields, mixed `input` and `answers`, zero or multiple values, and missing or extra answers return `400 invalid_request`; a missing or terminal Turn returns `409 stale`, an existing Turn without an active gate returns `409 not_awaiting_input`, and duplicate ids or a missing or contradictory durable gate-to-Item owner tuple returns `409 recovery_required`. Every failure occurs before a response Item or command receipt. Approval decisions continue through the approval route, and both gate commands commit Core business owners before any non-authoritative runtime notification.

Terminal checkpoint recovery is a derived read over existing final-status, Turn, Session, checkpoint, evidence, mode, review, backend, lease, capacity, and command-receipt owners. Live closeout, exact replay, and boot recovery use the same Task or Goal classifier. A complete deterministic tuple may publish a missing receipt and clear the checkpoint; a terminal checkpoint with zero mode closeout writes may execute the original mode transaction once; any partial, conflicting, or non-canonical tuple stays discoverable as `recovery_required`. The App API does not expose a caller-selected closeout label or persist another recovery phase.

An immutable Goal Task with `reviewPolicy.required=true` creates a durable actionable unresolved Goal Review whose evidence, prompt, worker Turn, and creating step request are fixed but whose decision tuple is initially null; `required=false` takes the same accepted closeout path without a Review. The resolution request requires `requestId` and one exact verdict from `accept`, `refine`, `retry`, or `abort`; `refine` also requires `revisionInstruction`, while `retry` and `abort` require `reason`. One Workspace transaction records the authenticated actor and decision, applies the verdict, and stores the bounded immutable Task, Goal, outcome, and next-ready projection defined by the Goal Mode specification without another Coordinator call. First-writer compare-and-set, exact replay, input conflict, stale request, contradictory-state recovery, workspace portability, and generated OpenAPI use that same bounded contract. A later `refine` or `retry` step creates a new Turn whose exact compact-JSON Coordinator request carries the eligible Review context and prior evidence; the latest eligible context remains sticky until a newer Review supersedes it or the Task terminates.

The Goal steering route is currently reserved and returns `503 goal_steering_delivery_unavailable` before Item, pending-row, command, Turn, or scheduler writes because the real worker path lacks the immutable delivery trace required by S16. The accepted future path may return `queued` only after the exact active Goal and Turn have that delivery owner; human-gate responses remain separate commands.

The accepted terminal steering targets are `POST /api/app/workspaces/:workspaceId/threads/:threadId/goal/steering/:pendingTurnId/follow-up` as `convertGoalSteeringToFollowUp` and `POST /api/app/workspaces/:workspaceId/threads/:threadId/goal/steering/:pendingTurnId/cancel` as `cancelGoalSteering`. Each request body is exactly `{ requestId }`, where that identity belongs to the terminal command and remains distinct from the original send request stored by the pending owner. The follow-up response is exactly `{ state: "follow-up", pendingTurnId, requestId, sourceRequestId, contentItemId, goalId, activeTurnId, followUpTurnId, followUpItemId }`; the cancel response omits only the two follow-up identities and has `state="cancelled"`. S16 owns their completed Core-local history-Turn, proof-snapshot, replay, cleanup, and failure predicates. These target routes remain unimplemented and MUST NOT be added before the shared S16 authority exists.

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

The Goal Review projection exposes one unresolved evidence row with `accept_review`, `request_refinement`, `retry_work`, and `abort` actions and no verdict in its source. First-party clients map those action kinds to the four canonical decisions; refinement, retry, and abort collect their required instruction or reason before calling the decision route, and cancellation leaves the row unresolved.

The current unversioned Artifact review route cannot identify the reviewed Artifact version, does not implement S16's version-owned decision and follow-up contract, and is removal-only. It MUST NOT remain as a fallback or alias after the versioned target route below is implemented.

Approval response mutation stays on the Core command path at `POST /api/approvals/:approvalRequestId/respond`.

Question response mutation stays on the Core turn-input path at `POST /api/turns`.

Schema ownership lives in `packages/app-api-schemas/src/agents.ts`, `packages/app-api-schemas/src/action-center.ts`, and the health-refresh schema in `packages/app-api-schemas/src/dashboard.ts`.

Client methods live under `client.agents` and `client.actionCenter`.

### Artifact And Material Interaction Target

The accepted S16 target adds the following App API operations. These method, path, and `operationId` identities are closed; implementation MUST replace the removal-only Artifact mutation and review shapes instead of adding aliases.

| Method and path | `operationId` | Success identity |
| --- | --- | --- |
| `POST /api/app/workspaces/:workspaceId/artifacts/imports` | `importWorkspaceArtifact` | `{ artifactId, artifactVersion }` |
| `POST /api/app/workspaces/:workspaceId/threads/:threadId/artifacts/:artifactId/introductions` | `introduceWorkspaceArtifact` | `{ artifactId, artifactVersion, turnId, itemId }` |
| `GET /api/app/workspaces/:workspaceId/artifacts/:artifactId/reviews` | `listArtifactReviews` | `{ reviews }`, ordered by `artifactVersion` ascending |
| `POST /api/app/workspaces/:workspaceId/artifacts/:artifactId/versions/:artifactVersion/review/decision` | `submitArtifactReviewDecision` | `{ reviewId, artifactId, artifactVersion, decision, followUpTurnId }` |
| `GET /api/app/workspaces/:workspaceId/materials` | `listWorkspaceMaterials` | `{ materials }`, ordered by `createdAt`, then `materialId` |
| `POST /api/app/workspaces/:workspaceId/materials` | `createWorkspaceMaterial` | `{ materialId }` |
| `GET /api/app/workspaces/:workspaceId/materials/:materialId` | `getWorkspaceMaterial` | `{ material }` |
| `GET /api/app/workspaces/:workspaceId/materials/:materialId/revisions` | `listWorkspaceMaterialRevisions` | `{ revisions }`, ordered by `createdAt`, then `revisionId` |
| `POST /api/app/workspaces/:workspaceId/materials/:materialId/revisions` | `saveWorkspaceMaterialRevision` | `{ materialId, revisionId }` |
| `GET /api/app/workspaces/:workspaceId/materials/:materialId/revisions/:revisionId` | `getWorkspaceMaterialRevision` | `{ revision }` |
| `GET /api/app/workspaces/:workspaceId/threads/:threadId/material` | `getThreadMaterial` | `{ material }`, where `material` is the singular Thread projection or null |
| `POST /api/app/workspaces/:workspaceId/threads/:threadId/materials/:materialId/bind` | `bindThreadMaterial` | `{ materialId, threadId, outcome: "bound" }` |
| `POST /api/app/workspaces/:workspaceId/threads/:threadId/materials/:materialId/unbind` | `unbindThreadMaterial` | `{ materialId, threadId, outcome: "unbound" }` |
| `POST /api/app/workspaces/:workspaceId/threads/:threadId/materials/:materialId/exclude` | `excludeThreadMaterial` | `{ materialId, threadId, outcome: "excluded" }` |
| `POST /api/app/workspaces/:workspaceId/threads/:threadId/materials/:materialId/restore` | `restoreThreadMaterial` | `{ materialId, threadId, outcome: "included" }` |

Mutation request bodies are exactly the canonical inputs in S16 plus the required `requestId`; path identifiers are scope, not duplicated caller input. Artifact import returns version 1, Artifact introduction returns the deterministic completed Turn and Item, and Artifact Review decision returns the version-owned Review plus nullable deterministic follow-up Turn. Material responses return stable identities only; callers use the read operations for current projections. Exact replay returns the same success identity, changed input returns `idempotency_key_conflict`, and typed conflict, stale, busy, and recovery results follow S16 without success-shaped error payloads.

The Artifact Review list exposes only S16's closed `ArtifactReviewView`, never the full owner row or its `decisionRequestId`. Material list, detail, revision-summary, exact-revision-content, and Thread material responses use only the other closed public view shapes in S16; owner-only request proof is not added to a response. The Thread material read does not retain expected-base conflict state. Workspace Sync Review remains a different owner and route family under S49; its exact `artifactId` relationship excludes that presentation Artifact from generic Artifact Review projection, and neither route may translate or fall back to the other.

These operations are target contracts until their schemas, NanoCore routes, generated OpenAPI entries, Core Client methods, and first-party consumers land together. The user-facing removal-only MCP package gains no corresponding methods; Agent-facing use is projected through the transport-neutral operation catalog, bundled CLI, and unified Skill only after the App API contract is executable.

### Diagnostics And Setup

The Settings diagnostics slice returns service status, gateway endpoint status, gateway usage summaries, provider diagnostics, provider registry summaries, Core, Quick Chat, and Gateway default selections, Codex OAuth account summaries, runtime config status, and capability flags. `GET /api/app/diagnostics` does not expose a generic internal-agent registry, failure ledger, hook ledger, or `internalTasks` default; the strict App API schema rejects those removed fields.

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

### Chat Mode And Quick Chat

Chat Mode is the lightweight App API projection over the Core Assistant contract.

It is not a replacement for the Core turn protocol, Task Mode, or Goal Mode.

It must not allocate a worker session directly.

Current route families are `POST /api/app/quick-chat` for the standalone provider-backed Quick Chat call and `POST /api/app/workspaces/:workspaceId/threads/:threadId/chat` for Thread-scoped Chat Mode.

Standalone Quick Chat returns one completed, non-streaming response. Thread-scoped Chat Mode returns one typed answer, clarification, Task handoff, Goal handoff, or refusal outcome; system failure uses the typed App API error contract rather than a success-shaped outcome.

When Thread-scoped Chat runs in a Quick Chat Workspace and selects a Task or Goal intent, the project guard returns the durable `refused` outcome with reason `project_workspace_required`. The initiating Chat command owns the terminal Turn, user and refusal Items, and replay receipt; no downstream Task or Goal tuple exists. Direct project-only routes against Quick Chat continue to return their stable App API error before mutation.

Standalone Quick Chat persistence and `GET /api/app/quick-chat/:quickChatId` are not part of the current contract. Thread-scoped Chat Mode persists its user input and answer, clarification, or handoff projection through the ordinary Thread and Item owners.

The accepted target is `docs/specs/20260704-chat_mode_assistant.md`: Assistant answers, clarification gates, Task Mode handoff, and Goal Mode handoff are product projections over Core Assistant and Workflow Coordinator records. The `quick-chat` route name is implementation debt if it cannot carry that target clearly.

Quick Chat schema ownership lives in `packages/app-api-schemas/src/quick-chat.ts`, Thread-scoped Chat Mode schema ownership lives in `packages/app-api-schemas/src/chat-mode.ts`, and provider and default-selection diagnostics remain in `packages/app-api-schemas/src/diagnostics.ts`.

`ChatModeOutcomeSchema` exposes only successful product projections: answer, clarification, Task handoff, Goal handoff, or refusal. System failure uses the typed App API error contract and is never encoded as a success-shaped `failed` response.

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
