---
status: Accepted
implementation: Partial
kind: boundary
---
# Knowledge Manager Agent

## Owns

- The Knowledge Manager agent role and its bounded query, integration and maintenance interface.
- Assistant-to-Knowledge Manager query support.
- Task-mode-service-to-Knowledge Manager context material requests.
- Explicit App API operations for governed proposal drafting, repair suggestions, and health inspection.
- Knowledge Manager output classes: answer, uncertainty report, context material, proposal draft, repair suggestion, and health report.
- Parallel request-scoped queries, one persistent maintenance Thread per notebook scope, admitted Tools, publication authority and failure semantics.

## Does Not Own

- Canonical Knowledge Store semantics, notebook semantics, Knowledge Page, Knowledge Source, Knowledge Proposal, Knowledge Review, or Context Package concepts. `docs/core/knowledge.md` owns those.
- Knowledge governance rules and OKF conformance. `docs/specs/20260702-knowledge_store_governance_rules.md` owns those.
- Knowledge Store file layout, validation pipeline, retrieval implementation, and memory-to-knowledge migration. `docs/specs/20260703-knowledge_store_implementation.md` owns those.
- Semantic worker-context composition, which Workflow Coordinator owns, or final worker-context persistence, materialization, delivery, and delivery proof, which the owning Task or Goal mode service and `docs/specs/20260703-worker_context_package.md` own.
- Assistant direct answers outside knowledge query support.
- Generic provider execution, the shared internal Agent loop, role-profile resolution, event hooks, or scheduling. `docs/specs/20260813-internal_agent_runtime.md` owns the role-agnostic provider and loop mechanism; this specification owns only when and how the Knowledge Manager role may use it.
- Goal Mode Knowledge calls or a `goal-mode` caller value; both require a separately accepted Goal-owner update.

## Core References

- `docs/core/knowledge.md`
- `docs/core/architecture.md`
- `docs/core/agent-workflow.md`
- `docs/core/permissions.md`
- `docs/core/audit.md`
- `docs/core/storage.md`

## Summary

Knowledge Manager is an Internal Core Role that retrieves, synthesizes and maintains Memory and Knowledge through governed Tools. Queries use parallel per-request runs. Each notebook scope has one persistent maintenance Thread whose requests arrive as Turns. Users inspect work and approve required changes there.

The Knowledge Store remains the durable content authority. The shared internal Agent runtime owns execution; existing Thread, Turn and Item records hold conversation history. Knowledge Manager cannot compose final Worker prompts, launch Workers, coordinate workflows or grant itself publication authority.

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
- Do not add passive hooks, scheduled learning, a separate runner, registry, scheduler, ledger or status family.

## Decision

Knowledge Manager uses the shared internal Agent runtime for semantic retrieval, synthesis, integration and organization. Deterministic search, validation and publication remain Tools, not a replacement coordinator. The [Knowledge Manager agent decision](../decisions/20261017-knowledge_manager_agent_and_compaction.md) records the accepted role and context boundary.

- Queries are bounded per-request runs bound to the asker's trusted query context. They may run in parallel without sharing context across audiences.
- Maintenance uses one persistent Thread per notebook scope and one writer. Each request is a bounded Turn; the Thread is not a second content store.
- The role exposes `answer`, `prepare-context-material`, `draft-proposal`, `suggest-repair`, `health-check` and `maintain`, plus agent-facing `knowledge_ask(question)` and `knowledge_tell(content,sources)`.
- Working internal agents and Workers receive the admitted scope's bounded OKF root `index.md`, kept current by Knowledge Manager. They ask Knowledge Manager for details.
- Retrieval uses the one governed Retrieval Kernel owner in [Knowledge Store Implementation](20260703-knowledge_store_implementation.md). Query analysis reuses the Kernel tokenizer. The role adds no tokenizer, selector, policy filter, ranker or trace family.
- Integration, organization and generated Memory/Knowledge writes go through Knowledge Manager and the existing fixed-base notebook publisher. Users supply intent, information and approval; simple direct edits remain available.
- Current scoped maintenance delegation permits ordinary publication. Otherwise the exact candidate requires proposal approval; critical content and sensitive effects retain their owning decisions.
- Knowledge Manager uses OpenKit summary-checkpoint compaction near its configured model threshold, not a durable rolling context window. [Context Compaction](20260902-agent_runtime_context_compaction.md) owns the mechanism.
- Every internal role uses configurable role profiles. Knowledge Manager selects its logical model through the existing resolver, without a separate model selector.

## Contract / Expected Behavior

### Operation families

Read operations inherit S61's trusted query context, narrowing-only source selection and qualified page references. Knowledge Manager cannot supply a different Actor, User or querying Thread, merge Memory with Knowledge, or compare rankings across separate sources. Synthesis may combine admitted evidence while retaining source distinctions. Citations retain the Core Protocol scope-qualified reference. Every result that identifies an existing selection trace uses `retrievalTraceRef` as `{scopeId,objectId}`, never a bare `retrievalTraceId`. Direct User App calls with no Thread or Turn return their existing selection/outcome projection without a trace id or reference; they publish no trace and retain S61's same source and current-access checks. A caller cannot omit existing Thread/Turn context to skip publication. This is the consumer projection of [Query Context, Sources, References And Acts](../decisions/20261015-context_sources_references_query_acts.md), not another retrieval owner.

`answer`:

- retrieves and synthesizes a bounded answer for an admitted internal-agent or Worker query through the single governed retrieval owner
- returns structured scope-qualified `page@revision` and `source@digest` citations, confidence, uncertainty and the observed revision time
- may return `insufficient-evidence` instead of speculating

`prepare-context-material`:

- invokes the same governed retrieval owner used by `answer` and cannot add, remove, reorder, rerank, summarize, or otherwise change its dispositions
- for `task-mode`, returns exactly `{ retrievalTraceRef }`; `retrievalTraceRef` is the Core Protocol `{scopeId,objectId}` reference to the querying Thread/Turn's S61 evidence; S39 resolves it with current access and separately rereads and validates canonical page bytes
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

### Query and maintenance execution

A query run receives bounded Retrieval Kernel search, page, Source and history reads. It may synthesize an answer but cannot mutate notebook content or acquire publication Tools from message text. Each Tool call applies the asker's current scope, source and audience checks. A separate admitted `draft-proposal` entry may create a pending candidate through the existing Proposal owner. It receives those reads and `knowledge.change.propose`, never notebook publication Tools.

`knowledge_ask(question)` invokes this query path. `knowledge_tell(content,sources)` sends supplied information and its admitted provenance to the scope's maintenance Thread. A tell is not a publication, an approval or evidence that a Worker completed work. Worker-output provenance still requires the existing exact completed Worker Turn and delivery evidence. Workers can address only their current Task's Workspace Knowledge. Internal-agent admission keeps Memory and Knowledge queries separate.

`maintain` admits an explicit integration or organization request. Its instruction and optional page/Source selections cannot choose actor, owner scope, audience or publication authority. Trusted invocation assembly binds those values. Page and Source IDs select admitted content, never host paths. Its input remains `{instruction,pageIds?,sourceIds?}` plus existing request identity. The scoped route, Core Client and bundled CLI project this same operation.

Maintenance receives bounded search, page, Source and history reads, `knowledge.notebook_workspace.update` and `knowledge.notebook.update`. The notebook owner defines the editing Tools: one fixed-base virtual filesystem and submission of its exact candidate to the publisher. There is no raw host shell, Git Tool, arbitrary MCP execution or separate session owner. `knowledge.notebook.update` remains a closed candidate-publication request, not a script or transaction language. The fixed editing snapshot lasts only for that Turn. Knowledge Manager updates the bounded root index with the content it organizes.

All calls reauthorize current actor, scope, source, audience and policy. Missing or denied material remains a typed observation, never permission to widen scope or substitute sources. The Turn ends on its terminal typed result, cancellation or the shared runtime's limits. Maintenance output is one of `published` with `{baseRevision,notebookRevision,changedPageIds,receiptRef}`, `review_required` with `{proposalId,baseRevision,candidateRevision}`, `no_change`, or a bounded `conflict | denied | invalid_request | unavailable | recovery_required` result. An operation may publish at most once; the published or review-required result ends editing, and further changes require a new invocation. Model prose or quiescence cannot prove publication.

Restart/provider failure never resumes a virtual editing session. A new Turn reconstructs current authorized content; exact command replay inspects the existing owner outcome rather than rerunning the model. Cancellation discards unsaved edits, while an explicitly saved Proposal retains its candidate. No result can turn missing command evidence into success. The persistent Thread does not retain an editable filesystem between Turns.

### Callers

The operation caller vocabulary is `assistant`, `task-mode`, `app-api`, `internal-agent` and `worker`. Native internal-role calls bind `internal-agent` and the role identity from trusted invocation context. The `worker` caller is bound by the authenticated Task capability context and admits only `knowledge_ask` and `knowledge_tell`. `caller` identifies the owning invocation path and is assigned by that service or route; it is not a request actor, authorization claim, or client-selectable value. External App API payloads MUST NOT accept a caller override, and authentication plus audit records retain the separately authenticated actor.

| Operation | Allowed semantic callers |
| --- | --- |
| `answer` | `assistant`, `app-api` |
| `prepare-context-material` | `task-mode`, `app-api` |
| `draft-proposal` | `assistant`, `app-api` |
| `suggest-repair` | `app-api` |
| `health-check` | `app-api` |
| `maintain` | `assistant`, `app-api` |
| `knowledge_ask`, `knowledge_tell` | `assistant`, `internal-agent`, `worker` |

- Assistant may call `answer`, or trusted private assembly may call `draft-proposal`/`maintain` for explicit scoped integration. Capture and maintenance permissions remain separate; a private conversation never implicitly authorizes Workspace/Server publication. Ordinary Assistant model Tools do not include the virtual filesystem.
- Direct Task Mode calls `prepare-context-material` exactly once for its accepted S39 path; that operation delegates to S61 exactly once and returns the existing retrieval trace reference. Task Mode does not call `answer`, S61, or another selector in parallel.
- Governed App API routes assign `app-api` after authorization and schema validation; an authenticated user remains the audit actor rather than becoming the semantic caller.
- `answer` and both Task and public `prepare-context-material` share the `knowledge.read` admission in [Policy Enforcement Mapping](20260703-policy_enforcement_mapping.md) and the one governed retrieval in [Knowledge Store Implementation](20260703-knowledge_store_implementation.md). They keep the caller rows and output views in this section. `task-mode` remains trusted caller context assigned by the Task service and is never a caller-supplied field. Source and audience rules remain in force. The S61 trace remains selection evidence only. Retrieval keeps the mutating posture [Policy Enforcement Mapping](20260703-policy_enforcement_mapping.md) states when the call updates an authoritative index or trace, and `answer` still never mutates knowledge.
- No passive or scheduled learning caller is authorized before v0.1.0. A future trigger must be owned by a separately accepted specification and reuse these operations without adding a second lifecycle owner.

The caller table constrains the operation entries. Worker ask/tell and native internal-role ask/tell are the admitted integrations; they do not broaden the older operation rows. Goal Mode Knowledge calls require a separately accepted update to the Goal owner and this specification before `goal-mode` can enter the caller vocabulary.

### Write rules

- Every Knowledge Manager write must pass through the knowledge service.
- Invalid active knowledge must not enter retrieval.
- Ordinary generated edits require explicit instruction or current maintenance delegation; designated critical content and sensitive effects require the exact decision owned by the notebook publisher. Observations/claims/conflicts remain maintenance evidence, not self-granted publication authority.
- A drafted proposal's exact source references MUST be persisted through the existing Knowledge Proposal owner; returning lineage only in the operation response is insufficient. Its validation result is a response and diagnostic projection because application revalidates the fixed candidate against current authority.
- Report-only repair/health operations never apply changes. The separate admitted maintenance entry may apply ordinary corrections through the notebook publisher.

### Output and audit

Every result includes operation id, operation kind, exact semantic caller, and resolved owner scope (one context-admitted source for retrieval); Workspace lineage is included only when applicable. `answer` additionally owns its answer or insufficient-evidence outcome, citations, confidence, and uncertainty; App API `prepare-context-material` owns its bounded selected and excluded projections plus the S61 retrieval trace reference, while Task Mode receives only that trace reference; `draft-proposal` owns the pending proposal, source lineage, validation result, and confidence; `suggest-repair` owns its outcome and bounded suggestions; and `health-check` owns its outcome, summary, checks, and embedded repair suggestions.

Outputs must not contain secret values, raw vault material, unrestricted file contents, unadmitted cross-scope knowledge, or content or source metadata from excluded, `restricted`, denied, missing, or unreadable candidates.

An `answer` or `prepare-context-material` result may reference the one governed S61 retrieval trace, which proves only selection and audit facts. It does not prove that Workflow Coordinator composed the material, that an owning mode materialized its bytes, or that a worker received it. For pushed Task context, only the accepted S39 worker-Turn delivery trace proves its exact `knowledgePageId + contentDigest` and byte projection. A Worker `knowledge_ask` CapabilityCall instead retains the exact answer bytes delivered as that call's delivery evidence. This proves delivery of the answer, not every cited page or Worker use. It creates no separate delivery ledger.

### Lifecycle and failure semantics

Each query run and maintenance Turn terminates with one schema-valid result or the owning typed failure. The maintenance Thread persists through existing Thread, Turn and Item owners; query context never becomes shared maintenance memory. No Knowledge-specific run store, retry queue, checkpoint store, scheduler, ledger or status family is created.

`answer` returns a cited answer or `insufficient-evidence` and never mutates knowledge. App API `prepare-context-material` may return bounded selected and excluded projections plus the existing S61 retrieval trace reference, while Task Mode returns exactly `{ retrievalTraceRef }`; neither form assembles or materializes worker context. `draft-proposal` may create only a pending fixed-base notebook-change Knowledge Proposal through the existing proposal store and review flow, with its fixed base/candidate commits and sources durable before success. `suggest-repair` and `health-check` return reports and do not apply repairs, schedule work, or write knowledge.

Authorization keeps the existing authentication mapping, invalid request bodies return `invalid_request` with HTTP 400, a missing addressed resource returns the existing typed not-found response with HTTP 404, and a conflicting proposal request id returns `idempotency_key_conflict` with HTTP 409. When S61's deterministic owner-scope-plus-request proposal exists but the matching proposal-draft receipt is absent, the proposal route returns `recovery_required` with HTTP 409 and performs no additional mutation. Other operation failures return HTTP 500 with `knowledge_manager_answer_failed`, `knowledge_manager_context_failed`, `knowledge_manager_proposal_draft_failed`, `knowledge_manager_repair_suggest_failed`, or `knowledge_manager_health_check_failed` at their owning route. Every public error is a closed typed envelope with bounded, redacted details; caught exception messages, stack traces, local paths, query text, source bytes, credentials, and secret-like values MUST NOT be copied into a response. A failed call must not claim a proposal, repair, health action, context delivery, or worker availability that its owning durable record does not prove. Within these five report/query/proposal operations, proposal drafting is the business mutation and MUST return the same pending proposal on request replay. Each query, context preparation, repair suggestion or health check is a distinct invocation. Usage and selection traces are not retry state.

After restart, reconstruct authorized context from the existing notebook, Proposal/Review records, Thread/Turn/Item history and their owned evidence. Never replay a model run or resume a virtual editing filesystem. Retry failed semantic work as a new Turn. Exact command replay inspects the publisher's existing outcome rather than rerunning the model. Missing or invalid durable content requires store recovery, not reconstruction from provider memory or diagnostics.

Retained Proposal, Review, Source, maintenance-ledger and retrieval-trace readers ignore descriptive additions at each object level and project only known fields; normal rewrites preserve owned annotations, immutable Proposal bytes and their referenced digest, and append-only Review order, while proposal and review instructions remain exact. Public Review decision projection and accepted-decision recovery verify the retained ordered decision core, identities, Proposal digest and content digest; descriptive annotations alone do not require recovery.

## Scoped Memory And Learning

[Personal Memory And Scoped Knowledge Learning](20260909-personal_memory_and_knowledge_learning.md) owns source intake, scope and audience. [Notebook Editing](20260909-knowledge_notebook_editing.md) owns publication and history. Capture permission never grants publication authority. Facts, observations, model confidence and repeated claims supply no authority. Verify volatile claims against current Sources; report unresolved contradictions and uncertainty.

Automatic extraction, consolidation, usage aging and AI assessment are deferred until after v0.1.0. Explicit asks, tells and organization requests use the current role and publisher.

## Bounded Source And Knowledge Context

Knowledge Manager reads and model input follow [Internal Agent Runtime](20260813-internal_agent_runtime.md#minimal-tool-contract) and [Context Package](20260703-worker_context_package.md#bounded-model-projection). Preserve original source/page digests and separately identify delivered excerpts or descriptors. Retrieve exact ranges on demand under current source and destination authority. A selection trace remains selection evidence; the immutable Context Package proves pushed Worker context, while a pull answer uses its CapabilityCall delivery evidence. Source-owned PDF text-layer and explicit bounded vision processors do not publish Knowledge. Missing, unsupported, or failed processing returns bounded truthful coverage, never a full-body fallback or complete absence claim.

## Current Implementation Projection

NanoCore currently exposes five deterministic Knowledge Manager operations through shared operation definitions, native invocation, App API, Core Client, CLI and remote MCP. They preserve S61's qualified references, current source checks and Task's exact trace-only preparation view. Threadless direct User calls publish no selection trace. Fixed-base agent maintenance, persistent maintenance Threads and Worker ask/tell supply are not implemented. These existing service functions are substrates for the accepted agent path, not its completion.

The existing resolver is `apps/nanocore/src/internal-agents/profile-resolver.ts`. The maintenance route is `POST <scoped-knowledge-route>/manager/maintenance`, under existing scope authorization. For each role, a User's per-Workspace `user.jsonc` `internalRoles` override Workspace `workspace.jsonc` `internalRoles`; a selected matching profile in `internal-role-profiles.jsonc` supplies role defaults before global/Gateway defaults. Invalid selected profiles fail resolution. An explicit requested logical model must be admitted by the resolved profile. Knowledge Manager reuses this mechanism. The current deployment choice is Grok 4.7; it is configuration, not a product constant.

## Alternatives Considered

- Fold Knowledge Manager into Workflow Coordinator. Rejected: knowledge maintenance and workflow coordination have different ownership and review rules.
- Let Assistant read the Knowledge Store directly. Rejected: Knowledge Manager provides source traceability, uncertainty, and governance-aware answers.
- Make Knowledge Manager an external worker agent. Rejected: it maintains Core-owned knowledge and should stay in the coordination plane.

## Consequences

- The Assistant and Task Mode get a stable knowledge support interface.
- Knowledge maintenance remains governed by the same validation and proposal rules.
- V1 supports explicit active queries without authorizing passive or scheduled execution.

## Testing Strategy / Acceptance Criteria

- Query runs remain isolated across audiences, use the one Retrieval Kernel and return source-qualified citations or explicit insufficient evidence.
- Working agents receive the bounded admitted index. Worker ask/tell schemas bind the current Task's Workspace and cannot select personal Memory or another scope.
- One notebook maintenance Thread serializes agent writes. Users can inspect requests, changes and required approvals there.
- Model selection reuses role-profile precedence. Knowledge Manager uses summary-checkpoint compaction; it never adopts the durable rolling window.
- Fixed-base conflicts preserve the current winner. Failure, cancellation and restart cannot replay a model or repeat a publication; saved Proposals survive.
- Routes reject caller overrides and keep typed, redacted authorization, validation, not-found, conflict, recovery and operation-failure results.
- Task preparation retains the S61 trace-only response and S39 exact-byte delivery boundary. Worker ask delivery retains exact answer bytes in its CapabilityCall and makes no claim of cited-page delivery or use.
- Proposal drafts retain exact sources and base/candidate revisions. Only existing scope authority and required review permit publication; facts and model confidence cannot grant it.
- No new store, registry, scheduler, ledger, status family, Goal integration or independent context-delivery owner is required.

S18 alone owns the real Knowledge L6 story. This specification adds no story or harness.

## Risks & Mitigations

- Risk: Knowledge Manager over-synthesizes facts. Mitigation: source references and insufficient-evidence outcomes are required.
- Risk: maintenance changes surprise users. Mitigation: maintenance is explicitly delegated, history shows exact attributed diffs, and sensitive changes retain required human decisions.
- Risk: context material becomes too large. Mitigation: the owning mode service applies policy and package bounds before Coordinator composition and again at materialization without adding excluded material.

## Deferred / Future Work

- Knowledge v2 synthesis from long-term history.
- Semantic retrieval and embedding-backed ranking.
- Implicit cross-Workspace factual sharing; audience-bounded personal scope selection is owned by the scoped Memory extension.
- Team review rules for shared knowledge.
- Automatic extraction, consolidation, usage aging, AI assessment and unattended triggers after v0.1.0.

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
