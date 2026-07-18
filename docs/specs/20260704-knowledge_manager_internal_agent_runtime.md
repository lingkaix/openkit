# Knowledge Manager Service

Status: Accepted
Implementation: Partial

## Owns

- The deterministic app-local service interface for the Knowledge Manager Internal Core Role.
- Assistant-to-Knowledge Manager query support.
- Task- and Goal-mode-service-to-Knowledge Manager context material requests.
- Explicit App API operations for governed proposal drafting, repair suggestions, and health inspection.
- Knowledge Manager output classes: answer, uncertainty report, context material, proposal draft, repair suggestion, and health report.

## Does Not Own

- Canonical Knowledge Store semantics, notebook semantics, Knowledge Page, Knowledge Source, Knowledge Proposal, Knowledge Review, or Context Package concepts. `docs/core/knowledge.md` owns those.
- Knowledge governance rules and OKF conformance. `docs/specs/20260702-knowledge_store_governance_rules.md` owns those.
- Knowledge Store file layout, validation pipeline, retrieval implementation, and memory-to-knowledge migration. `docs/specs/20260703-knowledge_store_implementation.md` owns those.
- Semantic worker-context composition, which Workflow Coordinator owns, or final worker-context persistence, materialization, and delivery, which the owning Task or Goal mode service owns.
- Assistant direct answers outside knowledge query support.
- Provider or model execution, a generic internal-role runner or registry, event hooks, private lifecycle state, or scheduling. Any future caller or provider-backed operation requires its own accepted design.

## Core References

- `docs/core/knowledge.md`
- `docs/core/architecture.md`
- `docs/core/agent-workflow.md`
- `docs/core/permissions.md`
- `docs/core/audit.md`
- `docs/core/storage.md`

## Summary

Knowledge Manager is an Internal Core Role implemented as deterministic NanoCore service functions for knowledge retrieval support and governed maintenance. Existing knowledge specs own the store, governance, validation, proposals, retrieval, and durable records. This spec owns only the five typed operation families and their caller boundary.

Knowledge Manager may prepare source-traceable material and draft proposals. It must not silently rewrite high-impact active knowledge, bypass validation, compose final worker prompts, own a private execution lifecycle, or become the workflow coordinator.

## Goals / Non-goals

### Goals

- Give the Assistant and the Task and Goal mode services a stable Knowledge Manager interface.
- Keep knowledge answers and context material source-traceable.
- Keep explicit knowledge maintenance requests governed and auditable.
- Ensure all writes go through the knowledge service and proposal/review rules.
- Keep Knowledge Manager separate from semantic worker-context composition, context delivery, and workflow routing.

### Non-goals

- Do not redefine Knowledge Store format or validation.
- Do not let Knowledge Manager write secrets or read vault material.
- Do not let Knowledge Manager directly launch workers.
- Do not let Knowledge Manager silently apply meaning-changing repairs.
- Do not build semantic knowledge v2 or history-derived preference synthesis beyond existing governance.
- Do not add passive hooks, scheduled envelopes, provider calls, or a generic internal-agent framework.

## Background

`docs/core/knowledge.md` defines Knowledge Manager responsibilities. The governance and implementation specs define the durable records, validation, retrieval, proposal, and review paths. This contract keeps the callable service surface narrow so those existing owners are not duplicated by an agent runtime.

## Decision

- Knowledge Manager is an Internal Core Role implemented through direct deterministic service calls.
- It exposes bounded operation families: `answer`, `prepare-context-material`, `draft-proposal`, `suggest-repair`, and `health-check`.
- Assistant may call Knowledge Manager for direct knowledge answers and uncertainty reports.
- Task and Goal mode services may call Knowledge Manager for source-traceable material, exclusions, and confidence signals before final context assembly.
- Knowledge Manager writes must go through the knowledge service and must obey validation, proposal, review, and low-risk repair rules.
- V1 has no generic runner, registry, provider selection, tool allowlist, hook dispatcher, private event stream, private failure ledger, or independently resumable Knowledge Manager lifecycle.

## Contract / Expected Behavior

### Operation families

`answer`:

- answers a bounded knowledge question for Assistant or user-facing knowledge lookup
- returns cited knowledge pages, source references, confidence, and uncertainty
- may return `insufficient-evidence` instead of speculating

`prepare-context-material`:

- selects source-traceable material for Coordinator
- returns material references, excerpts or summaries allowed by policy, exclusions, confidence, and trace metadata
- does not assemble the final worker prompt

`draft-proposal`:

- creates a candidate Knowledge Proposal from source material, worker output, user correction, or maintenance findings
- records source references, confidence, freshness, scope, and conflict notes
- does not activate the proposal without review unless governance allows a low-risk path

`suggest-repair`:

- V1 detects duplicate normalized titles and returns bounded review-required suggestions
- never applies a repair and reports every suggestion as non-auto-applicable

`health-check`:

- reports whether knowledge exists and whether duplicate-title suggestions need attention
- does not schedule work, draft proposals, apply repairs, or mutate knowledge

### Callers

The exact semantic caller vocabulary is `assistant`, `task-mode`, `goal-mode`, and `app-api`. `caller` identifies the owning invocation path and is assigned by that service or route; it is not a request actor, authorization claim, or client-selectable value. External App API payloads MUST NOT accept a caller override, and authentication plus audit records retain the separately authenticated actor.

| Operation | Allowed semantic callers |
| --- | --- |
| `answer` | `assistant`, `task-mode`, `goal-mode`, `app-api` |
| `prepare-context-material` | `task-mode`, `goal-mode`, `app-api` |
| `draft-proposal` | `app-api` |
| `suggest-repair` | `app-api` |
| `health-check` | `app-api` |

- Assistant may call `answer` and receive an answer or uncertainty report.
- Task and Goal mode services may call `prepare-context-material` and `answer` for planning or worker context, then pass bounded references through Workflow Coordinator decisions.
- Governed App API routes assign `app-api` after authorization and schema validation; an authenticated user remains the audit actor rather than becoming the semantic caller.
- No passive or scheduled caller is authorized in V1. A future trigger must be owned by a separately accepted specification and reuse these operations without adding a second lifecycle owner.

### Write rules

- Every Knowledge Manager write must pass through the knowledge service.
- Invalid active knowledge must not enter retrieval.
- High-impact generated output, observations, claims, and repairs require proposal and review unless policy explicitly allows direct application.
- This service never auto-applies repairs. Any future repair application remains governed by the Knowledge Store owner and requires separately accepted scope.

### Output and audit

Every result includes operation id, operation kind, exact semantic caller, and Workspace id. `answer` additionally owns its answer or insufficient-evidence outcome, citations, confidence, and uncertainty; `prepare-context-material` owns selected and excluded material plus trace metadata; `draft-proposal` owns the pending proposal, source lineage, validation result, and confidence; `suggest-repair` owns its outcome and bounded suggestions; and `health-check` owns its outcome, summary, checks, and embedded repair suggestions.

Outputs must not contain secret values, raw vault material, unrestricted file contents, or cross-workspace knowledge.

### Lifecycle and failure semantics

Each call is request-scoped and terminates with one schema-valid result or the owning App API error. It creates no Knowledge Manager session, run, checkpoint, pending row, retry queue, or recovery record.

`answer` returns a cited answer or `insufficient-evidence` and never mutates knowledge. `prepare-context-material` returns selected and excluded material plus trace metadata but does not assemble worker context; its route persists the returned context-package trace through the existing knowledge trace owner. `draft-proposal` may create only a pending Knowledge Proposal through the existing proposal store and review flow. `suggest-repair` and `health-check` return reports and do not apply repairs, schedule work, or write knowledge.

Authorization keeps the existing authentication mapping, invalid request bodies return `invalid_request` with HTTP 400, a missing addressed resource returns the existing typed not-found response with HTTP 404, and a conflicting proposal request id returns `idempotency_key_conflict` with HTTP 409. Other operation failures return HTTP 500 with `knowledge_manager_answer_failed`, `knowledge_manager_context_failed`, `knowledge_manager_proposal_draft_failed`, `knowledge_manager_repair_suggest_failed`, or `knowledge_manager_health_check_failed` at their owning route. A failed call must not claim a proposal, repair, health action, context delivery, or worker availability that its owning durable record does not prove. Proposal drafting alone is a business mutation and MUST use its request id to return the same pending proposal on replay. Each answer, context preparation, repair suggestion, or health check is a distinct invocation; its usage or trace evidence is not retry state and does not authorize resumption.

After restart, only the Knowledge Store, Knowledge Proposal and review records, retrieval traces, and persisted context-package traces owned by the knowledge specifications are recoverable. Pure answer, repair-suggestion, and health-report calls have no resumable lifecycle. Missing or invalid durable knowledge remains a knowledge-store recovery failure and must not be reconstructed from process memory or a Knowledge Manager diagnostics ledger.

## Accepted Design

NanoCore implements five direct deterministic functions over the existing knowledge store, retrieval, validation, proposal, and trace services. Assistant, Task and Goal mode services, and App API routes supply bounded inputs and consume typed outputs. Task and Goal mode boundaries own their durable mode transitions, final worker-context persistence, materialization, delivery, and worker launch; they request scheduler and Human Attention or Action Center effects through those existing owners. Workflow Coordinator retains semantic worker-context composition. No generic runner, registry, hooks, scheduler dependency, tool executor, or model call belongs to this service.

## Current Implementation Projection

The current implementation has completed the memory-to-knowledge route and projection rename across the active minimal knowledge slice. NanoCore now exposes deterministic Knowledge Manager `answer`, `prepare-context-material`, first-slice `draft-proposal`, first-slice `suggest-repair`, and bounded `health-check` operations through App API schemas, `@openkit/core-client`, NanoCore server routes, OpenAPI projection, the transport-neutral operation catalog, the bundled CLI, and the unified Skill as `knowledge.answer`, `knowledge.context-prepare`, `knowledge.proposal-draft`, `knowledge.repair-suggest`, and `knowledge.health-check`. The read operations are source-cited, return `insufficient-evidence` instead of speculating, and reuse the minimal workspace `KnowledgeEntry` store. The context-material operation returns material references, excerpts, exclusions, confidence, and trace metadata without assembling the final worker prompt. Task Mode prepares matching Knowledge refs, passes them to Workflow Coordinator, and now delivers those exact references inside the complete structured worker request through the scheduler, AEP, worker, Turn, and Item path. It still does not bind the referenced Knowledge material files or a materialized Context Package snapshot into that worker input. The proposal draft operation creates a pending app-local Knowledge Proposal through the existing proposal store and Action Center review flow instead of directly activating knowledge, and it returns deterministic source lineage plus validation status for each caller-supplied source reference. The lineage slice classifies references as registered workspace sources, existing workspace knowledge entries, or external unregistered references that require review. The repair suggestion operation detects duplicate knowledge titles and returns review-required suggestions without applying changes. The health-check operation summarizes current knowledge availability and review-required repair suggestions without scheduling maintenance, applying repairs, or writing new knowledge.

These App API and unified Skill operations are product-facing calls; they do not implement worker-facing `knowledge.*` capability routes. Current AEPs keep the capability plane disabled. Reference-level Knowledge-to-worker input is implemented through the Coordinator request, but material-content and Context Package snapshot binding are not; a caller must explicitly consume prepared material at an owning Core boundary until that delivery contract exists.

The five functional V1 Knowledge Manager operations are implemented. The current schema still uses `assistant`, `workflow-coordinator`, `user`, and `system`, context preparation defaults to `workflow-coordinator`, and Task Mode supplies that stale attribution; those values do not satisfy the exact semantic caller contract above. The proposal-draft generic fallback still uses the shared command helper's default HTTP 404 and multiple failure paths expose caught messages without a dedicated redaction audit. These caller and failure mismatches keep this specification Partial. The Knowledge Store implementation spec still owns the governed validation pipeline, retrieval pipeline, OKF-backed storage, legacy data validation report, and any future maintenance loop. Governed proposal validation beyond source-reference resolution, broader repair classes, scheduled health checks, broader Goal Mode Coordinator integration, semantic retrieval traces, and richer maintenance automation require separately accepted scope rather than expanding this service implicitly.

## Alternatives Considered

- Fold Knowledge Manager into Workflow Coordinator. Rejected: knowledge maintenance and workflow coordination have different ownership and review rules.
- Let Assistant read the Knowledge Store directly. Rejected: Knowledge Manager provides source traceability, uncertainty, and governance-aware answers.
- Make Knowledge Manager an external worker agent. Rejected: it maintains Core-owned knowledge and should stay in the coordination plane.

## Consequences

- The Assistant and the Task and Goal mode services get a stable knowledge support interface.
- Knowledge maintenance remains governed by the same validation and proposal rules.
- V1 supports explicit active queries without authorizing passive or scheduled execution.

## Testing Strategy / Acceptance Criteria

- L1: operation schema tests for answer, context material, proposal draft, repair suggestion, and health report.
- L1: write-path tests proving every proposed write goes through validation and proposal rules.
- L1: direct-service tests proving the five operations do not require a provider, runner, registry, hook dispatcher, scheduler, or private lifecycle state.
- L1: caller tests proving each operation accepts only its exact semantic caller, App API payloads cannot override `caller`, and authenticated actor attribution remains in the existing audit owner.
- L2: contract tests for the Assistant and the Task and Goal mode-service caller interfaces.
- L3: NanoCore black-box tests for knowledge answer, context material request, proposal draft, and health report, including exact 400, 404, 409, and operation-specific 500 mappings.
- L3: proposal request replay returns one pending proposal, while the four non-business-mutation operations remain distinct invocations with no resumable private state.
- L6: story acceptance where a user asks Assistant a knowledge-backed question, then a worker task receives Coordinator-composed and mode-service-materialized context sourced from Knowledge Manager material.

Acceptance: Knowledge Manager can answer with citations or uncertainty, prepare context material without assembling the final prompt, and propose knowledge changes without bypassing validation or review; no observable result depends on a generic internal-agent runtime or private lifecycle.

## Risks & Mitigations

- Risk: Knowledge Manager over-synthesizes facts. Mitigation: source references and insufficient-evidence outcomes are required.
- Risk: maintenance changes surprise users. Mitigation: this service returns review-required suggestions and only the governed proposal path may create reviewable change records.
- Risk: context material becomes too large. Mitigation: the owning mode service applies policy and package bounds before Coordinator composition and again at materialization without adding excluded material.

## Resolved Decisions

Previously open questions are resolved by accepted V1 defaults: health checks are explicit on-demand service calls, not scheduled work; Assistant-facing knowledge answers must carry structured citations by default, with product surfaces free to render them as inline markers, expandable details, or both.

## Deferred / Future Work

- Knowledge v2 synthesis from long-term history.
- Semantic retrieval and embedding-backed ranking.
- Cross-workspace knowledge sharing.
- Team review rules for shared knowledge.

## Links

- `docs/core/knowledge.md`
- `docs/core/architecture.md`
- `docs/core/agent-workflow.md`
- `docs/specs/20260702-knowledge_store_governance_rules.md`
- `docs/specs/20260703-knowledge_store_implementation.md`
- `docs/specs/20260703-worker_context_package.md`
- `docs/specs/20260704-chat_mode_assistant.md`
- `docs/specs/20260704-workflow_coordinator_internal_agent.md`
