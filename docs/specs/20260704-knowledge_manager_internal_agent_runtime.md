---
status: Accepted
kind: boundary
implementation: Partial
aspect: knowledge
---
# Knowledge Manager Agent

This specification owns the Knowledge Manager internal agent role and its bounded query, context-preparation, proposal-drafting, repair-suggestion, health-inspection, and notebook-maintenance interface across User Memory, Workspace Knowledge, and Server Knowledge.

## Scope

### Owns

- The Knowledge Manager Internal Core Role (`docs/core/architecture.md#internal-core-roles`) and its operation families: `answer`, `prepare-context-material` (operation ID `knowledge.context.prepare`), `draft-proposal` (`knowledge.proposal.draft`), `suggest-repair`, `health-check`, `maintain`, and agent-facing `knowledge.ask` / `knowledge.tell` (`knowledge_ask`, `knowledge_tell`) and `memory.ask` / `memory.tell`.
- Isolated per-request query runs on dedicated `knowledge-manager` Threads and Turns, plus one nonresident maintenance Thread per notebook scope (`entryPath: "knowledge-manager"`).
- Caller admission, Tool sets, in-run compaction, output repair, run deadlines, terminal status/event mappings, and route error semantics.

### Does Not Own

- Canonical Knowledge Store and notebook semantics in `docs/core/knowledge.md`, governance rules in `docs/specs/20260702-knowledge_store_governance_rules.md`, or file layout, validation, and governed retrieval in `docs/specs/20260703-knowledge_store_implementation.md`.
- Fixed-base virtual editing and publication mechanics in `docs/specs/20260909-knowledge_notebook_editing.md`, or Personal Memory, scoped learning, and completed-work reflection in `docs/specs/20260909-personal_memory_and_knowledge_learning.md`.
- Semantic worker-context composition in `docs/specs/20260704-workflow_coordinator_internal_agent.md`, or Worker Context Package persistence, materialization, and delivery proof in `docs/specs/20260703-worker_context_package.md`.
- Role-agnostic internal Agent loop and profile resolution in `docs/specs/20260813-internal_agent_runtime.md`, in-run compaction mechanics in `docs/specs/20260902-agent_runtime_context_compaction.md`, or recurring schedule scanning in `docs/specs/20260711-scheduler_recurring_event_triggers.md`.
- Assistant direct answers outside knowledge query support (`docs/specs/20260704-chat_mode_assistant.md`) or Goal progression (`docs/specs/20261002-goal.md`).

### Core

- `docs/core/knowledge.md`
- `docs/core/architecture.md`
- `docs/core/work-model.md`
- `docs/core/policy.md`
- `docs/core/evidence.md`
- `docs/core/storage.md`

## Role Boundaries And Navigation Overviews

Knowledge Manager only queries and manages its admitted notebook scope (`user`, `workspace`, or `server`) using the shared internal Agent runtime ([decision](../decisions/20261017-bounded_knowledge_maintenance_and_shared_summaries.md)). It has no network Tools, Vault secret access, Worker-launch capability, or external-effect Tools; ordinary Provider transport remains with the shared runtime.

- Working internal agents and Workers receive the admitted Workspace or Server scope's bounded OKF root `index.md` overview (at most `4,096` UTF-8 content bytes without splitting a character; Knowledge Manager's own query and Workspace/User maintenance runs admit up to `16,384` UTF-8 bytes), naming the Notebook commit, canonical `contentDigest`, `deliveredDigest`, and truncation state. The overview is untrusted navigation, never authority or an exhaustive inventory; unavailable overviews emit a value-free notice, and User Memory never enters shared projections.
- Retrieval delegates to the single governed Retrieval Kernel owner in `docs/specs/20260703-knowledge_store_implementation.md`, reusing the Kernel tokenizer without adding a second tokenizer, selector, policy filter, ranker, or trace family.
- Model selection uses `apps/nanocore/src/internal-agents/profile-resolver.ts` (`user.jsonc` `internalRoles` override `workspace.jsonc` `internalRoles`, then matching `internal-role-profiles.jsonc` profile defaults before global/Gateway defaults, preserving optional `reasoningEffort` under `docs/specs/20260813-internal_agent_runtime.md#internal-role-execution-profile`).
- Knowledge Manager uses OpenKit summary-checkpoint compaction (`createCompactingInternalAgentProvider` under `docs/specs/20260902-agent_runtime_context_compaction.md`) only inside a single bounded run near its model threshold, writing an in-run source-bound context-summary Item with `strategy: "compaction"`, producing model ID, `sourceRange`, and `previousSummary: {itemId, digest}` when replacing an earlier summary in that run. Each run starts fresh; cross-run memory is the notebook and its commit history.

### Server Maintenance Thread

Server Knowledge maintenance uses the general `server` Thread owner from `docs/core/core-concepts.md#thread` with no Workspace anchor ([Server Knowledge Is Shared Knowledge](../decisions/20261017-server_knowledge_is_shared_knowledge.md#general-server-thread-owner)). Current Server administration authority admits its history (`thread.server.list`, `thread.server.read`), interruption (`turn.server.interrupt`), explicit inputs (`knowledge.server.tell`, `knowledge.server.maintain`), and Proposal review (`knowledge.server.proposal.read`, `knowledge.server.proposal.decide`); Workspace membership and asking-call lineage grant no Server access.

One nonresident maintenance Thread serializes the Server's bounded request and daily runs (`knowledgeMaintenance.schedule.enabled`, current default `false`). Server maintenance learns only from explicit requests, admitted Server Sources, and human edits to the Server notebook since the last completed processed base (`sourceRange` is empty because no Workspace or User Thread history enters Server learning). Current usable Server administration responsibility supplies the scheduled system actor; missing authority or an active writer records a visible failed or skipped Turn without model execution.

### Operation Families

Read operations inherit `docs/specs/20260703-knowledge_store_implementation.md` trusted `queryContext`, narrowing-only source selection, and [Core Protocol](../core/protocol.md#scope-qualified-object-references) scope-qualified page references ([Query Context, Sources, References And Acts](../decisions/20261015-context_sources_references_query_acts.md)). Every result identifying a selection trace uses `retrievalTraceRef` as `{scopeId, objectId}`, never a bare `retrievalTraceId`; threadless direct User App calls publish no trace and omit `retrievalTraceRef`, while callers with a Thread or Turn MUST NOT omit that context to skip trace publication. Workspace work queries Workspace Knowledge and admitted Server Knowledge in separate invocations with separate rankings and budgets; Worker `knowledge.tell` is Workspace-only, and User Memory never enters shared work.

- `answer` (`knowledge.ask` / `memory.ask`, `KnowledgeManagerAnswerRequestSchema` -> `KnowledgeManagerAnswerResponseSchema` in `packages/app-api-schemas/src/knowledge-manager.ts`): retrieves and synthesizes a bounded answer for an admitted internal-agent, Worker, or App API query through the governed retrieval owner, returning scope-qualified `page@revision` and `source@digest` citations (`KnowledgeManagerAnswerCitationSchema`), uncertainty, and observed revision time, or `insufficient-evidence` without speculating; never mutates knowledge.
- `prepare-context-material` (operation ID `knowledge.context.prepare`, `KnowledgeManagerPrepareContextRequestSchema` -> `KnowledgeManagerPrepareContextResponseSchema`): invokes the same governed retrieval owner without adding, removing, reordering, reranking, or summarizing dispositions. For `task-mode`, internal preparation returns `{retrievalTraceRef}` only; for `app-api`, it returns bounded selected (`public` or `internal` excerpts) and product-safe excluded projections plus `retrievalTraceRef`; neither assembles or materializes Worker prompts.
- `draft-proposal` (`knowledge.proposal.draft`, `KnowledgeManagerDraftProposalRequestSchema`): creates one fixed-base `notebook-change` Knowledge Proposal fixing exact `ownerScope`, base and candidate commits, source versions, producer, confidence, and rationale; when `sourceReferences` includes any `turn`, `item`, or `context-package` reference, it enforces the complete terminal direct-Task Worker trio from `docs/specs/20260703-knowledge_store_implementation.md`. It never activates the proposal.
- `suggest-repair`: detects duplicate normalized titles and returns bounded review-required suggestions marked non-auto-applicable without applying repairs.
- `health-check`: reports whether knowledge exists and whether duplicate-title suggestions need attention, without scheduling work, drafting proposals, or mutating knowledge.

### Query And Maintenance Execution

When addressed via `knowledge.ask` (including from a Chat Thread), Knowledge Manager creates its own isolated `knowledge-manager` Thread and Turn (`entryPath: "knowledge-manager"`) for the query run while retaining the asking Thread and Turn IDs for lineage and binding the asker's `queryContext` on the retrieval trace; copying the returned answer and citations into the asking Chat Thread is answer projection only, and the Chat Thread is not the Knowledge Manager execution owner.

Each query or maintenance run submits its final output through `knowledge.result`, validated by the shared Tool loop (plain model text is not a result). Current default run budgets are `8` model turns, `24` Tool calls, and a `300`-second deadline (replaceable by a pinned role profile), shared across the run, in-run summary compaction, the virtual notebook editor, and at most `1` bounded output-repair turn. Repair may read missing evidence or submit an unsubmitted native notebook outcome, but MUST NOT repeat an edit script or a notebook submission already attempted. An `insufficient-evidence` result with no citations and zero completed usable retrieval calls mechanically triggers that single repair turn. Query Tools reject wildcard patterns in `types` and `appliesTo` (guiding the model to omit optional selectors for an unfiltered search) and reject guessed or excluded page IDs. A failed query returns typed `knowledge_query_failed` (or `503` when provider/compaction supply is unavailable) with its retained Thread and Turn references rather than an unclassified HTTP `500`.

A query run receives bounded Retrieval Kernel search, page, Source, and history reads only. Its model-facing search Tool exposes content-free exclusions containing only excluded identity (`reference`), `revision`, and `reason`, with no `contentDigest` or `sourceReferences` (`apps/nanocore/src/knowledge/knowledge-agent.ts`); in-run compaction verifies that selection projection through the existing trace owner and current selected-page admission, while full trace reads and exports keep their complete source checks at the retrieval owner. Model-visible Tool names derive from canonical operation IDs by replacing dots with underscores (`knowledge_ask`, `knowledge_tell`, while keeping hyphens inside segments as in `knowledge.notebook-workspace.update`). The Assistant uses `memory.ask` and `memory.tell` for the current User's Memory under private Timeline admission; one private User maintenance Thread in the User's personal Workspace records `memory.maintain` runs and required approvals, preflighting the personal Workspace before any User-notebook initialization.

`maintain` (`POST <scoped-knowledge-route>/manager/maintenance`, Core Client, CLI, and daily schedule entry) takes `{instruction, pageIds?, sourceIds?}` plus request identity; trusted assembly binds actor, `ownerScope`, audience, and publication authority, reusing the scope's single nonresident maintenance Thread (`entryPath: "knowledge-manager"`, returning `recovery_required` if multiple matching Thread IDs exist or the retained Thread is unavailable). Each run starts a fresh Turn from the notebook overview (up to `16 KiB`), run inputs, and authorized Thread records, retaining `baseRevision`, processed `sourceRange` since the previous completed run (failed or incomplete runs never mark their range processed), trigger (`schedule` or `request`), and instructions. Recent human edits and diffs are preserved as inputs, while unchanged bootstrap `index.md` seeds and Knowledge Manager's own run records are excluded.

Workspace, User, and Server maintenance runs receive read-only authoring guidance from their active Scope Schema occupying at most `16 KiB` UTF-8 in run context; if the schema guidance exceeds `16 KiB`, it is omitted in full with an explicit unavailable notice rather than truncated, while the publisher still validates candidates against the complete active schema. Maintenance receives bounded history reads, `knowledge.notebook-workspace.update`, and `knowledge.notebook.update`, and may publish at most once per run. The public maintenance response follows `KnowledgeMaintenanceResponseSchema` / `KnowledgeMaintenanceOutcomeSchema`. The native notebook Tool result is that Tool's publication outcome and is not the public maintenance schema. Bounded errors stay with their existing error owner.

Caller cancellation ends a nonterminal Knowledge Manager query or maintenance Turn as `cancelled` and emits `turn.completed` with payload `turn-completed` and `stopReason=aborted`; an owned role deadline without caller cancellation ends the Turn as `failed` with `knowledge_manager_timeout` and `stopReason=error`; normal completion emits `stopReason=completed` ([Four Turn Terminal States](../decisions/20260921-four_turn_terminal_states.md)). No late result Item may be appended after terminal completion is sealed. Restart or provider failure never replays a model run or resumes a virtual editing filesystem.

When Workspace `knowledge.tell` retains its supplied Source and reaches the owned role deadline before any known or unresolved Notebook effect, its terminal Status Item reports the exact currently admitted Source and the existing continuation. The same command replays that result. A fresh `knowledge.maintain` can select the Source by ID at the current Notebook base and under current admission. A submission whose effect is unknown requires inspection.

## Callers, Audit, And Route Errors

Entry paths use `assistant`, `task-mode`, `app-api`, `internal-agent`, and `worker`. Semantic operation results and retrieval traces retain `KnowledgeManagerCallerSchema` (mapping `internal-agent` queries to `assistant` and `worker` queries to `task-mode`, while the Knowledge Manager Turn retains the actual role, model, and usage). External App API payloads MUST NOT supply a `caller` override.

| Operation | Allowed callers |
| --- | --- |
| `answer` | `assistant`, `app-api` |
| `prepare-context-material` | `task-mode`, `app-api` |
| `draft-proposal` | `assistant`, `app-api` |
| `suggest-repair` | `app-api` |
| `health-check` | `app-api` |
| `maintain` | `assistant`, `app-api`, `internal-agent` |
| `knowledge_ask`, `knowledge_tell` | `assistant`, `internal-agent`, `worker` |

Direct Task Mode calls `prepare-context-material` once for its Context Package path and receives `{retrievalTraceRef}` only; Goal Coordinator uses the `internal-agent` ask/tell path without a separate `goal-mode` caller value. Query and maintenance model usage is attributed to Knowledge Manager (`UsageRecord`, `Thread`, `Turn`, `Item`, `CapabilityCall`), linking the asking call for lineage only; a Worker `knowledge_ask` `CapabilityCall` retains the exact delivered answer bytes as answer-delivery evidence.

On deterministic and report routes, invalid request bodies return `400 invalid_request`, missing resources return `404`, conflicting proposal `requestId`s return `409 idempotency_key_conflict`, a deterministic proposal without a completed draft receipt returns `409 recovery_required`, and unhandled route failures return `500` (`knowledge_manager_answer_failed`, `knowledge_manager_context_failed`, `knowledge_manager_proposal_draft_failed`, `knowledge_manager_repair_suggest_failed`, or `knowledge_manager_health_check_failed`) with redacted details that never echo stack traces, local paths, query text, source bytes, or credentials. Retained Proposal, Review, Source, maintenance-ledger, and retrieval-trace readers ignore unknown descriptive additions at each object level and preserve owned annotations on rewrite.

## Acceptance

- Under [OpenKit Test Strategy](20260529-test_strategy.md) and [L6 Story Acceptance](20260529-l6_story_acceptance.md), S18 alone owns the real Knowledge L6 story (this specification adds no separate story or evaluation harness), while cross-boundary verification proves the S61 trace-only `task-mode` preparation vs S39 exact-byte Context Package delivery boundary, `CapabilityCall` answer-byte proof without claiming cited-page delivery, in-run compaction trace verification, and zero model or virtual-editor replay across failures, cancellations, or restarts.

## Implementation

- Knowledge Manager query, maintenance, authoring guidance, and schedule runners: `apps/nanocore/src/knowledge/`, `apps/nanocore/src/`.
- Shared internal Agent loop, profile resolver, and in-run compaction wrapper: `apps/nanocore/src/internal-agents/`, `apps/nanocore/src/context/`.
- Operation and maintenance configuration schemas: `packages/app-api-schemas/src/`, `packages/config-schema/src/`.

## Implementation Gaps

- Model-backed `draft-proposal` entry and `knowledge.change.propose` Tool - `knowledge.proposal.draft` stores a caller-supplied candidate deterministically without a model run - #504
- Long-term Knowledge v2 history synthesis - Only bounded explicit and daily maintenance runs are implemented - #258
- Usage aging, candidate-specific AI assessment, and triggers beyond the daily maintenance schedule - Deferred beyond the current bounded maintenance implementation - #259, #262, #264, #313

## Decisions

- [Four Turn Terminal States](../decisions/20260921-four_turn_terminal_states.md)
- [Query Context, Sources, References And Acts](../decisions/20261015-context_sources_references_query_acts.md)
- [Bounded Knowledge Maintenance And Shared Summaries](../decisions/20261017-bounded_knowledge_maintenance_and_shared_summaries.md)
- [Knowledge Manager Agent And Compaction](../decisions/20261017-knowledge_manager_agent_and_compaction.md)
- [Server Knowledge Is Shared Knowledge](../decisions/20261017-server_knowledge_is_shared_knowledge.md)
