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
- The optional semantic Knowledge Manager Turn, its activation boundary, initial Tool set, entry-specific mutation authority, and role-specific failure semantics.

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

Knowledge Manager is an Internal Core Role implemented as deterministic NanoCore service functions for knowledge retrieval support and governed maintenance. Existing knowledge specs own the store, governance, validation, proposals, the single governed retrieval owner, and durable records. This spec owns the typed operation families and their caller boundary.

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
- Do not let Knowledge Manager change content without current explicit instruction or maintenance delegation.
- Do not add unbounded synthesis or expand source access through notebook maintenance.
- Do not add passive hooks, scheduled envelopes, a Knowledge-specific loop, or a generic internal-agent framework.

## Background

`docs/core/knowledge.md` defines Knowledge Manager responsibilities. The governance and implementation specs define the durable records, validation, retrieval, proposal, and review paths. This contract keeps the callable service surface narrow so those existing owners are not duplicated by an agent runtime.

## Decision

- Knowledge Manager is an Internal Core Role implemented through direct deterministic service calls.
- It exposes bounded operation families: `answer`, `prepare-context-material`, `draft-proposal`, `suggest-repair`, `health-check`, and explicitly admitted `maintain`.
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

- creates one fixed-base notebook-change Knowledge Proposal from source material, worker output, user correction, or maintenance findings
- fixes exact owner scope, base/candidate commits, source versions, producer, confidence and rationale through the existing Proposal owner; candidate commit fixes all changed paths and bytes
- applies S61's terminal-work predicate exactly when the normalized source references contain any `turn`, `item`, or `context-package` reference; such a request must contain the complete matching terminal direct-Task tuple, while a proposal backed only by registered Source or existing Knowledge Page references does not claim worker output
- does not activate the proposal; this explicitly proposal-only operation leaves application to the currently authorized decision and shared notebook publisher

`suggest-repair`:

- V1 detects duplicate normalized titles and returns bounded review-required suggestions
- never applies a repair and reports every suggestion as non-auto-applicable

`health-check`:

- reports whether knowledge exists and whether duplicate-title suggestions need attention
- does not schedule work, draft proposals, apply repairs, or mutate knowledge

### Optional semantic Turn

The semantic path uses one bounded Turn through the shared internal Agent runtime when the request needs semantic judgment; deterministic answer, retrieval, validation and reports remain direct calls. Read/proposal entries keep the ordered Tools `knowledge.search`, `knowledge.source.read`, `knowledge.change.propose`. Their effects remain bounded reads and pending candidate creation. These entries never acquire maintenance tools because of message text or a model request.

`maintain` is a separate trusted entry for explicit notebook editing or the scoped learning owner's admitted personal capture composition. Its input is `{instruction,pageIds?,sourceIds?}` plus existing request identity; exact owner scope, actor, audience and authority come from the route/trusted caller. Page/source IDs select admitted content, never host paths. The initial App API route is `POST <scoped-knowledge-route>/manager/maintenance`, with existing User/Workspace/Server scope route and authorization conventions. The route, Core Client and bundled CLI project this same operation; no worker-facing route or Goal caller is added.

Maintenance receives exactly, in order, `knowledge.search`, `knowledge.source.read`, `knowledge.notebook_workspace.update`, `knowledge.notebook.update`. The notebook owner defines the latter pair's strict input/effect/limit/failure schemas: interpreted editing only in one fixed-base virtual filesystem, followed by submission of that exact candidate to the publisher. There is no raw host shell, Git Tool, arbitrary MCP execution, private loop or extra session owner. `knowledge.notebook.update` is a closed candidate-publication request, never a script or transaction language. The Tool closures retain the fixed snapshot across calls in this invocation only.

All calls reauthorize current actor, scope, source, audience and policy. Missing or denied material remains a typed observation, never permission to widen scope or substitute sources. The Turn ends on its terminal typed result, cancellation or the shared runtime's limits. Maintenance output is one of `published` with `{baseRevision,notebookRevision,changedPageIds,receiptRef}`, `review_required` with `{proposalId,baseRevision,candidateRevision}`, `no_change`, or a bounded `conflict | denied | invalid_request | unavailable | recovery_required` result. An operation may publish at most once; the published or review-required result ends editing, and further changes require a new invocation. Model prose or quiescence cannot prove publication.

Restart/provider failure never resumes a virtual editing session. A new Turn reconstructs current authorized content; exact command replay inspects the existing owner outcome rather than rerunning the model. Cancellation discards unsaved edits, while an explicitly saved Proposal retains its candidate. No result can turn missing command evidence into success. Deterministic paths remain usable without activating a model.

### Callers

The exact V1 semantic caller vocabulary is `assistant`, `task-mode`, and `app-api`. `caller` identifies the owning invocation path and is assigned by that service or route; it is not a request actor, authorization claim, or client-selectable value. External App API payloads MUST NOT accept a caller override, and authentication plus audit records retain the separately authenticated actor.

| Operation | Allowed semantic callers |
| --- | --- |
| `answer` | `assistant`, `app-api` |
| `prepare-context-material` | `task-mode`, `app-api` |
| `draft-proposal` | `assistant`, `app-api` |
| `suggest-repair` | `app-api` |
| `health-check` | `app-api` |
| `maintain` | `assistant`, `app-api` |

- Assistant may call `answer`, or trusted private assembly may call `draft-proposal`/`maintain` for the exact scoped learning composition. Capture and maintenance permissions remain separate; a private conversation never implicitly authorizes Workspace/Server publication. Ordinary Assistant model Tools do not include the virtual filesystem.
- Direct Task Mode calls `prepare-context-material` exactly once for its accepted S39 path; that operation delegates to S61 exactly once and returns the existing retrieval trace reference. Task Mode does not call `answer`, S61, or another selector in parallel.
- Governed App API routes assign `app-api` after authorization and schema validation; an authenticated user remains the audit actor rather than becoming the semantic caller.
- No passive or scheduled caller is authorized in V1. A future trigger must be owned by a separately accepted specification and reuse these operations without adding a second lifecycle owner.

The caller table constrains routes that already exist; it does not authorize implementation of a missing integration. Goal Mode Knowledge calls require a separately accepted update to the Goal owner and this specification before `goal-mode` can enter the caller vocabulary.

### Write rules

- Every Knowledge Manager write must pass through the knowledge service.
- Invalid active knowledge must not enter retrieval.
- Ordinary generated edits require explicit instruction or current maintenance delegation; designated critical content and sensitive effects require the exact decision owned by the notebook publisher. Observations/claims/conflicts remain maintenance evidence, not self-granted publication authority.
- A drafted proposal's exact source references MUST be persisted through the existing Knowledge Proposal owner; returning lineage only in the operation response is insufficient. Its validation result is a response and diagnostic projection because application revalidates the fixed candidate against current authority.
- Report-only repair/health operations never apply changes. The separate admitted maintenance entry may apply ordinary corrections through the notebook publisher.

### Output and audit

Every result includes operation id, operation kind, exact semantic caller, and resolved owner scope (or ordered allowed scopes for retrieval); Workspace lineage is included only when applicable. `answer` additionally owns its answer or insufficient-evidence outcome, citations, confidence, and uncertainty; App API `prepare-context-material` owns its bounded selected and excluded projections plus the S61 retrieval trace reference, while Task Mode receives only that trace reference; `draft-proposal` owns the pending proposal, source lineage, validation result, and confidence; `suggest-repair` owns its outcome and bounded suggestions; and `health-check` owns its outcome, summary, checks, and embedded repair suggestions.

Outputs must not contain secret values, raw vault material, unrestricted file contents, unadmitted cross-scope knowledge, or content or source metadata from excluded, `restricted`, denied, missing, or unreadable candidates.

An `answer` or `prepare-context-material` result may reference the one governed S61 retrieval trace, which proves only selection and audit facts. It does not prove that Workflow Coordinator composed the material, that an owning mode materialized its bytes, or that a worker received it. Only the accepted S39 worker-Turn delivery trace may prove delivery of an exact `knowledgePageId + contentDigest` and byte projection.

### Lifecycle and failure semantics

Each deterministic call and each optional semantic Turn is request-scoped and terminates with one schema-valid result or the owning typed failure. Neither creates a Knowledge Manager session, run, checkpoint, pending row, retry queue, or recovery record; the semantic Turn's ordinary Thread and Turn records belong to the shared internal Agent runtime and conversation owners rather than a Knowledge-specific lifecycle.

`answer` returns a cited answer or `insufficient-evidence` and never mutates knowledge. App API `prepare-context-material` may return bounded selected and excluded projections plus the existing S61 retrieval trace reference, while Task Mode returns exactly `{ retrievalTraceId }`; neither form assembles or materializes worker context. `draft-proposal` may create only a pending fixed-base notebook-change Knowledge Proposal through the existing proposal store and review flow, with its fixed base/candidate commits and sources durable before success. `suggest-repair` and `health-check` return reports and do not apply repairs, schedule work, or write knowledge.

Authorization keeps the existing authentication mapping, invalid request bodies return `invalid_request` with HTTP 400, a missing addressed resource returns the existing typed not-found response with HTTP 404, and a conflicting proposal request id returns `idempotency_key_conflict` with HTTP 409. When S61's deterministic owner-scope-plus-request proposal exists but the matching proposal-draft receipt is absent, the proposal route returns `recovery_required` with HTTP 409 and performs no additional mutation. Other operation failures return HTTP 500 with `knowledge_manager_answer_failed`, `knowledge_manager_context_failed`, `knowledge_manager_proposal_draft_failed`, `knowledge_manager_repair_suggest_failed`, or `knowledge_manager_health_check_failed` at their owning route. Every public error is a closed typed envelope with bounded, redacted details; caught exception messages, stack traces, local paths, query text, source bytes, credentials, and secret-like values MUST NOT be copied into a response. A failed call must not claim a proposal, repair, health action, context delivery, or worker availability that its owning durable record does not prove. Proposal drafting alone is a business mutation and MUST use its request id to return the same pending proposal on replay. Each answer, context preparation, repair suggestion, or health check is a distinct invocation; its usage or trace evidence is not retry state and does not authorize resumption.

After restart, only the Knowledge Store, Knowledge Proposal and review records, the S61 retrieval trace, any ordinary Thread and Turn history retained by their owners, and the separately owned S39 Context Package trace remain durable. Pure answer, repair-suggestion, and health-report calls have no resumable lifecycle, and a failed semantic Turn is retried only as a new Turn from those owners. Missing or invalid durable knowledge remains a knowledge-store recovery failure and must not be reconstructed from process memory, provider memory, or a Knowledge Manager diagnostics ledger.

## Accepted Design

Keep existing deterministic operations and one S61 retrieval owner. Optional semantic read/proposal Turns use their three-Tool set; explicitly admitted `maintain` uses its separate four-Tool set and the notebook publisher. Task Mode still requests S61 preparation once; Workflow Coordinator owns composition and S39 owns worker delivery. Neither maintenance nor a retrieval trace creates worker execution, scheduling, Goal integration or a second context owner.

## Scoped Memory And Learning Extension

`20260909-personal_memory_and_knowledge_learning.md` owns source capture, scope/audience and bounded extraction. `20260909-knowledge_notebook_editing.md` owns editing/publication/history. Capture opt-in alone cannot enable unattended maintenance. An assessment remains one bounded invocation recorded by existing Observation evidence, never a Judge service or self-approval. Deterministic retrieval retains exact scope, commit/digest, source authority and audience; contradictions are not resolved by simply preferring a higher scope.

## Current Implementation Projection

NanoCore exposes the five deterministic Knowledge Manager operations through App API schemas, `@openkit/core-client`, NanoCore routes, OpenAPI, the transport-neutral operation catalog, the bundled CLI, and the unified Skill. Answer and context preparation delegate to S61's governed retrieval owner; context preparation returns that owner's trace reference and exposes no standalone worker-context materialization or delivery surface.

The server assigns only `assistant`, `task-mode`, or `app-api`, rejects public caller overrides, validates generated candidate bytes and source lineage before proposal persistence, and returns bounded product-safe errors. Proposal drafting fixes one create-only page id, exact canonical bytes, digest, and source references through the existing proposal owner. Direct Task delivery remains proved only by S39's exact page, digest, provenance, and byte projection. Product-facing Knowledge Manager operations expose no worker-facing `knowledge.*` capability routes, and Goal Mode integration remains deferred outside this specification's acceptance boundary. The semantic read/proposal Turn, separate maintenance entry and Git publisher are not implemented, so the implementation is Partial; current deterministic operations remain conforming and must not be routed through a model merely to approximate the missing semantic path.

## Alternatives Considered

- Fold Knowledge Manager into Workflow Coordinator. Rejected: knowledge maintenance and workflow coordination have different ownership and review rules.
- Let Assistant read the Knowledge Store directly. Rejected: Knowledge Manager provides source traceability, uncertainty, and governance-aware answers.
- Make Knowledge Manager an external worker agent. Rejected: it maintains Core-owned knowledge and should stay in the coordination plane.

## Consequences

- The Assistant and Task Mode get a stable knowledge support interface.
- Knowledge maintenance remains governed by the same validation and proposal rules.
- V1 supports explicit active queries without authorizing passive or scheduled execution.

## Testing Strategy / Acceptance Criteria

- L1/L2 tests cover the five deterministic operation schemas, exact server-assigned callers, client-override rejection, authenticated actor separation, S61 delegation by both read operations, fixed-base notebook proposal output, deterministic-path non-activation, the exact semantic Tool set, and absence of a Knowledge-specific runner, scheduler, or private lifecycle state.
- One existing NanoCore route suite covers the bounded 400, 404, `idempotency_key_conflict`, `recovery_required`, and operation-specific 500 mappings plus successful-result isolation, error redaction, proposal request replay, and the fact that S61 retrieval evidence cannot satisfy S39 delivery.
- S18 alone owns the real Knowledge L6 story; this service spec authorizes no additional story or harness.

Acceptance: routes assign only `assistant`, `task-mode`, or `app-api` and reject client override; every call or semantic Turn is request-scoped; deterministic cases activate no model; both read operations use S61's single governed retrieval owner; semantic cases receive only their exact entry-specific Tools; public failures are typed and redacted; every proposal draft durably fixes its base/candidate commits and sources through the existing owner; S61 retrieval evidence never counts as S39 delivery proof; and no observable result depends on a Knowledge-specific runner, private lifecycle, second retrieval owner, second context owner, unauthorized publication path, or Goal integration.

## Risks & Mitigations

- Risk: Knowledge Manager over-synthesizes facts. Mitigation: source references and insufficient-evidence outcomes are required.
- Risk: maintenance changes surprise users. Mitigation: maintenance is explicitly delegated, history shows exact attributed diffs, and sensitive changes retain required human decisions.
- Risk: context material becomes too large. Mitigation: the owning mode service applies policy and package bounds before Coordinator composition and again at materialization without adding excluded material.

## Resolved Decisions

Previously open questions are resolved by accepted V1 defaults: health checks are explicit on-demand service calls, not scheduled work; Assistant-facing knowledge answers must carry structured citations by default, with product surfaces free to render them as inline markers, expandable details, or both; and semantic model use is an optional bounded Turn for demonstrated synthesis cases, never the default Knowledge Manager execution path.

## Deferred / Future Work

- Knowledge v2 synthesis from long-term history.
- Semantic retrieval and embedding-backed ranking.
- Implicit cross-Workspace factual sharing; audience-bounded personal scope selection is owned by the scoped Memory extension.
- Team review rules for shared knowledge.
- Tools or unattended triggers beyond the explicitly bounded notebook maintenance entry.

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
