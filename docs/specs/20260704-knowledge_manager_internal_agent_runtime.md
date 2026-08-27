---
status: Accepted
implementation: Partial
---
# Knowledge Manager Service

## Owns

- The deterministic app-local service interface for the Knowledge Manager Internal Core Role.
- Assistant-to-Knowledge Manager query support.
- Task-mode-service-to-Knowledge Manager context material requests.
- Explicit App API operations for governed proposal drafting, repair suggestions, and health inspection.
- Knowledge Manager output classes: answer, uncertainty report, context material, proposal draft, repair suggestion, and health report.
- The optional semantic Knowledge Manager Turn, its activation boundary, initial Tool set, proposal-only mutation posture, and role-specific failure semantics.

## Does Not Own

- Canonical Knowledge Store semantics, notebook semantics, Knowledge Page, Knowledge Source, Knowledge Proposal, Knowledge Review, or Context Package concepts. `docs/core/knowledge.md` owns those.
- Knowledge governance rules and OKF conformance. `docs/specs/20260702-knowledge_store_governance_rules.md` owns those.
- Knowledge Store file layout, validation pipeline, retrieval implementation, and memory-to-knowledge migration. `docs/specs/20260703-knowledge_store_implementation.md` owns those.
- Semantic worker-context composition, which Workflow Coordinator owns, or final worker-context persistence, materialization, delivery, and delivery proof, which the owning Task or Goal mode service and `docs/specs/20260703-worker_context_package.md` own.
- Assistant direct answers outside knowledge query support.
- Generic provider execution, the shared internal Agent loop, an internal-role registry, event hooks, private lifecycle state, or scheduling. `docs/specs/20260813-internal_agent_runtime.md` owns the role-agnostic provider and loop mechanism; this specification owns only when and how the Knowledge Manager role may use it.
- Goal Mode Knowledge calls or a `goal-mode` caller value; both require a separately accepted Goal-owner update.

## Core References

- `docs/core/knowledge.md`
- `docs/core/architecture.md`
- `docs/core/agent-workflow.md`
- `docs/core/permissions.md`
- `docs/core/audit.md`
- `docs/core/storage.md`

## Summary

Knowledge Manager is an Internal Core Role implemented as deterministic NanoCore service functions for knowledge retrieval support and governed maintenance. Existing knowledge specs own the store, governance, validation, proposals, the single governed retrieval owner, and durable records. This spec owns only the five typed operation families and their caller boundary.

Knowledge Manager may prepare source-traceable material and draft proposals. It must not silently rewrite high-impact active knowledge, bypass validation, compose final worker prompts, own a private execution lifecycle, or become the workflow coordinator.

## Goals / Non-goals

### Goals

- Give the Assistant and Task Mode a stable Knowledge Manager interface.
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
- Do not add passive hooks, scheduled envelopes, a Knowledge-specific loop, or a generic internal-agent framework.

## Background

`docs/core/knowledge.md` defines Knowledge Manager responsibilities. The governance and implementation specs define the durable records, validation, retrieval, proposal, and review paths. This contract keeps the callable service surface narrow so those existing owners are not duplicated by an agent runtime.

## Decision

- Knowledge Manager is an Internal Core Role implemented through direct deterministic service calls.
- It exposes bounded operation families: `answer`, `prepare-context-material`, `draft-proposal`, `suggest-repair`, and `health-check`.
- Assistant may call Knowledge Manager for direct knowledge answers and uncertainty reports.
- Task Mode calls Knowledge Manager once for source-traceable material before final context assembly.
- `answer` and `prepare-context-material` MUST reuse the one deterministic governed retrieval owner defined by `docs/specs/20260703-knowledge_store_implementation.md`; Knowledge Manager MUST NOT own a parallel substring search, candidate selector, policy filter, ranking path, or retrieval trace family.
- Knowledge Manager writes must go through the knowledge service and must obey validation, proposal, review, and low-risk repair rules.
- V1 has no generic runner, registry, provider selection, tool allowlist, hook dispatcher, private event stream, private failure ledger, or independently resumable Knowledge Manager lifecycle.
- Deterministic operations remain the default. A provider-backed semantic Turn is optional only for an accepted request whose needed comparison, synthesis, conflict explanation, uncertainty-aware drafting, or Knowledge Proposal cannot be produced by the deterministic operations without losing meaning.
- A semantic Turn uses the role-agnostic runtime owned by `docs/specs/20260813-internal_agent_runtime.md`; this specification does not create another runner, registry, scheduler, event stream, or provider lifecycle.

## Contract / Expected Behavior

### Operation families

`answer`:

- answers a bounded knowledge question for Assistant or user-facing knowledge lookup through the single governed retrieval owner
- returns cited knowledge pages, source references, confidence, and uncertainty
- may return `insufficient-evidence` instead of speculating

`prepare-context-material`:

- invokes the same governed retrieval owner used by `answer` and cannot add, remove, reorder, rerank, summarize, or otherwise change its dispositions
- for `task-mode`, returns exactly `{ retrievalTraceId }`; S39 resolves that S61 row and separately rereads and validates canonical page bytes
- for `app-api`, may additionally return bounded excerpts from selected `public` or `internal` pages only; excluded, `restricted`, denied, missing, or unreadable candidates expose no content or source metadata beyond S61's product-safe exclusion tuple
- does not assemble the final worker prompt
- creates no standalone selection trace, materialization, or delivery record

`draft-proposal`:

- creates one create-only candidate Knowledge Proposal from source material, worker output, user correction, or maintenance findings
- fixes one absent target `knowledgePageId`, exact canonical page bytes and `contentDigest`, source references, confidence, freshness, scope, and conflict notes in the existing proposal owner
- applies S61's terminal-work predicate exactly when the normalized source references contain any `turn`, `item`, or `context-package` reference; such a request must contain the complete matching terminal direct-Task tuple, while a proposal backed only by registered Source or existing Knowledge Page references does not claim worker output
- does not activate the proposal; only an authorized human review may apply its fixed page through the S61 owner

`suggest-repair`:

- V1 detects duplicate normalized titles and returns bounded review-required suggestions
- never applies a repair and reports every suggestion as non-auto-applicable

`health-check`:

- reports whether knowledge exists and whether duplicate-title suggestions need attention
- does not schedule work, draft proposals, apply repairs, or mutate knowledge

### Optional semantic Turn

The semantic Knowledge Manager path is one short, request-scoped Turn over the shared internal Agent runtime. It is not a replacement for deterministic retrieval, validation, context preparation, freshness checks, policy filtering, repair suggestions, or health inspection. The caller MUST use a deterministic operation when that operation can produce the required result, and model preference, convenience, or confidence is not an activation condition.

The complete initial Tool set is `knowledge.search`, `knowledge.source.read`, and `knowledge.change.propose`. `knowledge.search` returns bounded scope- and audience-filtered candidates with provenance, revision, freshness, visibility, conflict, and uncertainty evidence. `knowledge.source.read` reads only one explicitly selected source or bounded segment through its current source and permission owners. `knowledge.change.propose` creates only a reviewable Knowledge Proposal candidate with source lineage, intended scope, uncertainty, conflicts, and exclusions through the existing proposal owner. A Turn may receive a smaller subset when one or more operations are unreachable, but it may receive no additional mutation Tool under this contract.

Every Tool call is server-bound, reauthorized against the current actor, Workspace, output audience, source revision, and Knowledge policy, and returns only a bounded product-safe result. Tool presence grants no authority. Missing, denied, stale, conflicted, deleted, unreadable, or dependency-failed sources remain typed observations; the model MUST NOT infer their content, widen scope, substitute a different source silently, or convert uncertainty into a durable claim.

The Turn terminates after it returns a grounded answer, bounded context result, or accepted proposal receipt and has no runnable Tool call, or when the shared runtime returns its exact abort, limit, or failure outcome. Quiescence, model confidence, or a proposal draft never means that Knowledge was accepted, applied, replaced, deleted, published, or shared. Those mutations remain exclusively with the existing Knowledge service and review owners.

Retry after provider failure, stale input, restart, or an invalidated source is a new Turn reconstructed from the current request, Knowledge records, source revisions, proposal history, and evidence. No provider conversation, hidden transcript, or in-memory summary is recovery authority. If deterministic service can still answer the original request without semantic loss, the caller may use that existing operation; otherwise it returns the typed semantic failure or insufficient-evidence result and performs no mutation. Duplicate proposal calls retain the existing proposal request-identity rules, while read-only retries create no new durable Knowledge Manager state.

Observable acceptance requires that a deterministic case completes without a model Turn; a demonstrated semantic case receives only the admitted Tools and retains source identity, freshness, audience, conflict, and uncertainty; a mutation attempt can produce only a pending Knowledge Proposal; a missing or stale dependency cannot become accepted Knowledge; restart reconstructs from durable owners; and no generic runner, scheduler, event hook, private lifecycle record, or automatic publication path appears in the Knowledge Manager boundary.

### Callers

The exact V1 semantic caller vocabulary is `assistant`, `task-mode`, and `app-api`. `caller` identifies the owning invocation path and is assigned by that service or route; it is not a request actor, authorization claim, or client-selectable value. External App API payloads MUST NOT accept a caller override, and authentication plus audit records retain the separately authenticated actor.

| Operation | Allowed semantic callers |
| --- | --- |
| `answer` | `assistant`, `app-api` |
| `prepare-context-material` | `task-mode`, `app-api` |
| `draft-proposal` | `app-api` |
| `suggest-repair` | `app-api` |
| `health-check` | `app-api` |

- Assistant may call `answer` and receive an answer or uncertainty report.
- Direct Task Mode calls `prepare-context-material` exactly once for its accepted S39 path; that operation delegates to S61 exactly once and returns the existing retrieval trace reference. Task Mode does not call `answer`, S61, or another selector in parallel.
- Governed App API routes assign `app-api` after authorization and schema validation; an authenticated user remains the audit actor rather than becoming the semantic caller.
- No passive or scheduled caller is authorized in V1. A future trigger must be owned by a separately accepted specification and reuse these operations without adding a second lifecycle owner.

The caller table constrains routes that already exist; it does not authorize implementation of a missing integration. Goal Mode Knowledge calls require a separately accepted update to the Goal owner and this specification before `goal-mode` can enter the caller vocabulary.

### Write rules

- Every Knowledge Manager write must pass through the knowledge service.
- Invalid active knowledge must not enter retrieval.
- Generated Knowledge Page content and meaning-changing repairs require proposal and review. Observations, claims, and conflicts may use their existing maintenance owners but remain non-active until the governed proposal path promotes reusable knowledge.
- A drafted proposal's exact source references MUST be persisted through the existing Knowledge Proposal owner; returning lineage only in the operation response is insufficient. Its validation result is a response and diagnostic projection because application revalidates the fixed candidate against current authority.
- This service never auto-applies repairs. Any future repair application remains governed by the Knowledge Store owner and requires separately accepted scope.

### Output and audit

Every result includes operation id, operation kind, exact semantic caller, and Workspace id. `answer` additionally owns its answer or insufficient-evidence outcome, citations, confidence, and uncertainty; App API `prepare-context-material` owns its bounded selected and excluded projections plus the S61 retrieval trace reference, while Task Mode receives only that trace reference; `draft-proposal` owns the pending proposal, source lineage, validation result, and confidence; `suggest-repair` owns its outcome and bounded suggestions; and `health-check` owns its outcome, summary, checks, and embedded repair suggestions.

Outputs must not contain secret values, raw vault material, unrestricted file contents, cross-workspace knowledge, or content or source metadata from excluded, `restricted`, denied, missing, or unreadable candidates.

An `answer` or `prepare-context-material` result may reference the one governed S61 retrieval trace, which proves only selection and audit facts. It does not prove that Workflow Coordinator composed the material, that an owning mode materialized its bytes, or that a worker received it. Only the accepted S39 worker-Turn delivery trace may prove delivery of an exact `knowledgePageId + contentDigest` and byte projection.

### Lifecycle and failure semantics

Each deterministic call and each optional semantic Turn is request-scoped and terminates with one schema-valid result or the owning typed failure. Neither creates a Knowledge Manager session, run, checkpoint, pending row, retry queue, or recovery record; the semantic Turn's ordinary Thread and Turn records belong to the shared internal Agent runtime and conversation owners rather than a Knowledge-specific lifecycle.

`answer` returns a cited answer or `insufficient-evidence` and never mutates knowledge. App API `prepare-context-material` may return bounded selected and excluded projections plus the existing S61 retrieval trace reference, while Task Mode returns exactly `{ retrievalTraceId }`; neither form assembles or materializes worker context. `draft-proposal` may create only a pending, create-only Knowledge Proposal through the existing proposal store and review flow, with its fixed target page id, bytes, digest, and sources durable before success. `suggest-repair` and `health-check` return reports and do not apply repairs, schedule work, or write knowledge.

Authorization keeps the existing authentication mapping, invalid request bodies return `invalid_request` with HTTP 400, a missing addressed resource returns the existing typed not-found response with HTTP 404, and a conflicting proposal request id returns `idempotency_key_conflict` with HTTP 409. When S61's deterministic Workspace-plus-request proposal exists but the matching proposal-draft receipt is absent, the proposal route returns `recovery_required` with HTTP 409 and performs no additional mutation. Other operation failures return HTTP 500 with `knowledge_manager_answer_failed`, `knowledge_manager_context_failed`, `knowledge_manager_proposal_draft_failed`, `knowledge_manager_repair_suggest_failed`, or `knowledge_manager_health_check_failed` at their owning route. Every public error is a closed typed envelope with bounded, redacted details; caught exception messages, stack traces, local paths, query text, source bytes, credentials, and secret-like values MUST NOT be copied into a response. A failed call must not claim a proposal, repair, health action, context delivery, or worker availability that its owning durable record does not prove. Proposal drafting alone is a business mutation and MUST use its request id to return the same pending proposal on replay. Each answer, context preparation, repair suggestion, or health check is a distinct invocation; its usage or trace evidence is not retry state and does not authorize resumption.

After restart, only the Knowledge Store, Knowledge Proposal and review records, the S61 retrieval trace, any ordinary Thread and Turn history retained by their owners, and the separately owned S39 Context Package trace remain durable. Pure answer, repair-suggestion, and health-report calls have no resumable lifecycle, and a failed semantic Turn is retried only as a new Turn from those owners. Missing or invalid durable knowledge remains a knowledge-store recovery failure and must not be reconstructed from process memory, provider memory, or a Knowledge Manager diagnostics ledger.

## Accepted Design

NanoCore keeps the five direct deterministic functions over the existing knowledge store, validation, proposal, and trace services as the default path, with both read operations delegating to S61's single governed retrieval owner. For demonstrated semantic cases only, the Knowledge Manager role may execute one bounded Turn through `docs/specs/20260813-internal_agent_runtime.md` with only `knowledge.search`, `knowledge.source.read`, and `knowledge.change.propose`; mutation remains proposal-only. Assistant, the existing Task Mode integration, and App API routes supply bounded inputs and consume typed outputs. Task Mode owns its durable transitions, final worker-context persistence, materialization, S39 delivery proof, and worker launch; it requests scheduler and Human Attention or Action Center effects through those existing owners. Workflow Coordinator retains semantic worker-context composition but cannot change S61's Knowledge selection dispositions. S61 retrieval evidence remains audit-only and MUST NOT be promoted into the S39 owner. No generic runner, registry, hooks, scheduler dependency, Knowledge-specific Tool executor, Goal integration, automatic Knowledge mutation, or second retrieval or context-delivery owner belongs to this service.

## Current Implementation Projection

NanoCore exposes the five deterministic Knowledge Manager operations through App API schemas, `@openkit/core-client`, NanoCore routes, OpenAPI, the transport-neutral operation catalog, the bundled CLI, and the unified Skill. Answer and context preparation delegate to S61's governed retrieval owner; context preparation returns that owner's trace reference and exposes no standalone worker-context materialization or delivery surface.

The server assigns only `assistant`, `task-mode`, or `app-api`, rejects public caller overrides, validates generated candidate bytes and source lineage before proposal persistence, and returns bounded product-safe errors. Proposal drafting fixes one create-only page id, exact canonical bytes, digest, and source references through the existing proposal owner. Direct Task delivery remains proved only by S39's exact page, digest, provenance, and byte projection. Product-facing Knowledge Manager operations expose no worker-facing `knowledge.*` capability routes, and Goal Mode integration remains deferred outside this specification's acceptance boundary. The optional semantic Knowledge Manager Turn and its three-Tool assembly are not implemented, so the implementation is Partial; current deterministic operations remain conforming and must not be routed through a model merely to approximate the missing semantic path.

## Alternatives Considered

- Fold Knowledge Manager into Workflow Coordinator. Rejected: knowledge maintenance and workflow coordination have different ownership and review rules.
- Let Assistant read the Knowledge Store directly. Rejected: Knowledge Manager provides source traceability, uncertainty, and governance-aware answers.
- Make Knowledge Manager an external worker agent. Rejected: it maintains Core-owned knowledge and should stay in the coordination plane.

## Consequences

- The Assistant and Task Mode get a stable knowledge support interface.
- Knowledge maintenance remains governed by the same validation and proposal rules.
- V1 supports explicit active queries without authorizing passive or scheduled execution.

## Testing Strategy / Acceptance Criteria

- L1/L2 tests cover the five deterministic operation schemas, exact server-assigned callers, client-override rejection, authenticated actor separation, S61 delegation by both read operations, create-only proposal output, deterministic-path non-activation, the exact semantic Tool set, and absence of a Knowledge-specific runner, scheduler, or private lifecycle state.
- One existing NanoCore route suite covers the bounded 400, 404, `idempotency_key_conflict`, `recovery_required`, and operation-specific 500 mappings plus successful-result isolation, error redaction, proposal request replay, and the fact that S61 retrieval evidence cannot satisfy S39 delivery.
- S18 alone owns the real Knowledge L6 story; this service spec authorizes no additional story or harness.

Acceptance: routes assign only `assistant`, `task-mode`, or `app-api` and reject client override; every call or semantic Turn is request-scoped; deterministic cases activate no model; both read operations use S61's single governed retrieval owner; semantic cases receive only the three admitted Tools; public failures are typed and redacted; every proposal draft is create-only and durably fixes its target page id, bytes, digest, and sources through the existing owner; S61 retrieval evidence never counts as S39 delivery proof; and no observable result depends on a Knowledge-specific runner, private lifecycle, second retrieval owner, second context owner, automatic publication path, or Goal integration.

## Risks & Mitigations

- Risk: Knowledge Manager over-synthesizes facts. Mitigation: source references and insufficient-evidence outcomes are required.
- Risk: maintenance changes surprise users. Mitigation: this service returns review-required suggestions and only the governed proposal path may create reviewable change records.
- Risk: context material becomes too large. Mitigation: the owning mode service applies policy and package bounds before Coordinator composition and again at materialization without adding excluded material.

## Resolved Decisions

Previously open questions are resolved by accepted V1 defaults: health checks are explicit on-demand service calls, not scheduled work; Assistant-facing knowledge answers must carry structured citations by default, with product surfaces free to render them as inline markers, expandable details, or both; and semantic model use is an optional bounded Turn for demonstrated synthesis cases, never the default Knowledge Manager execution path.

## Deferred / Future Work

- Knowledge v2 synthesis from long-term history.
- Semantic retrieval and embedding-backed ranking.
- Cross-workspace knowledge sharing.
- Team review rules for shared knowledge.
- Additional semantic Knowledge Tools or any automatic Knowledge mutation.

## Links

- `docs/core/knowledge.md`
- `docs/core/architecture.md`
- `docs/core/agent-workflow.md`
- `docs/specs/20260702-knowledge_store_governance_rules.md`
- `docs/specs/20260703-knowledge_store_implementation.md`
- `docs/specs/20260703-worker_context_package.md`
- `docs/specs/20260704-chat_mode_assistant.md`
- `docs/specs/20260704-workflow_coordinator_internal_agent.md`
- `docs/specs/20260813-internal_agent_runtime.md`
