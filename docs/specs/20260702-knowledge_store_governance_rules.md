---
status: Accepted
implementation: Partial
---
# Knowledge Store Governance Rules

Implementation note: the accepted V1 validation, source, maintenance-record, create-only proposal review and application, unchanged-page reversal, and S39-only worker-delivery boundaries are implemented. Governed retrieval remains Partial because it does not yet surface or exclude relevant unresolved conflict-ledger authority; scoped ownership, Git notebook publication and bounded learning are accepted extensions that remain Not Started.

## Summary

This specification defines the concrete governance rules that make the canonical Knowledge model enforceable in portable files, schemas, validation, proposals, human review, content lineage, retrieval, and bounded maintenance.

OpenKit uses OKF-compatible Markdown as the portable envelope, an OpenKit Knowledge Profile for system-wide governance, and one scope schema for owner-specific constraints; the existing Workspace Schema is its current Workspace-only projection.

Programmatic validation protects structural correctness, the Knowledge Manager supports semantic maintenance through separately owned explicit operations, and explicit maintenance delegation and required human Knowledge Review preserve authority.

Generated learning uses the unified notebook publisher under current maintenance authority or an exact required human Review. It never self-authorizes, self-confirms or bypasses a required decision.

## Owns

- OKF-compatible Markdown as the portable knowledge envelope.
- The OpenKit Knowledge Profile and Scope Schema governance layers.
- Scope schema lifecycle, validation, migration, conformance levels, and failure behavior.
- Save-time enforcement for governed knowledge records.
- Source identity, source immutability expectations, derived-representation lineage, and source-reference health.
- Observation, claim, conflict, delegated editing, required proposal/review, content-lineage and history governance.
- Knowledge-selection trace requirements contributed to a separately owned Context Package.

## Does Not Own

- Canonical Knowledge semantics, which `docs/core/knowledge.md` owns.
- Concrete file paths, record encodings, content-digest encoding, database tables, routes, protocol fields, or migration implementation, which the Knowledge Store implementation contract owns.
- Knowledge Manager operation names, callers, typed outputs, or request lifecycle, which the Knowledge Manager service contract owns.
- Context Package identity, files, delivery trace, replay, worker materialization, or final prompt composition, which their owning workflow and Context Package contracts own.
- Permission-policy semantics, audit record schemas, Vault storage, worker capability transport, workspace synchronization, or UI design.
- Domain-specific schemas or raw source-of-truth records owned by external systems.

## Core References

- `docs/core/knowledge.md`
- `docs/core/permissions.md`
- `docs/core/audit.md`
- `docs/core/storage.md`

## Goals / Non-goals

Goals:

- Keep knowledge user-readable and portable while making active records machine-checkable.
- Keep invalid, stale, conflicting, sensitive, or unauthorized material from silently influencing workers.
- Preserve human authority and exact source, proposal, review, page-content, actor, request, and audit lineage.
- Make accepted proposal application and reversal bounded, idempotent, restart-safe, and fail-closed without another workflow.
- Keep Knowledge selection explainable without duplicating Context Package delivery ownership.

Non-goals:

- Do not define concrete routes, tables, paths, protocol payloads, UI components, or worker prompt assembly.
- Do not create a persistent Knowledge Manager agent, hook system, maintenance runner, retry queue, settlement workflow, or rollback service.
- Do not auto-promote generated learning or use citations, elapsed time, schedules, or absence of rejection as review authority.
- Do not require a specific editor, renderer, search engine, vector store, or graph database.
- Do not define domain-specific HR, marketing, finance, analytics, or engineering schemas.

## Decision

The governed Knowledge Store has three layers:

```text
OKF-compatible files
  -> OpenKit Knowledge Profile
    -> Scope Schema
```

Only active `scope-schema-valid` pages that pass authorization, sensitivity, freshness, conflict, and retrieval policy may enter default worker Knowledge selection.

Ordinary generated edits may publish under explicit notebook maintenance delegation; critical content and sensitive effects retain exact required human decisions under `20260909-knowledge_notebook_editing.md`.

An accepted review authorizes one Knowledge Store application, but active knowledge changes only when the exact resulting page revision and its complete lineage become durable.

Restoration and removal use the same exact-base notebook publisher, with current validation and required confirmation, preserving prior content/history and operation evidence.

## Format And Schema Contract

OKF-compatible files provide Markdown, YAML frontmatter, links, citations, index files, and log files as the portable envelope.

The OpenKit Knowledge Profile defines mandatory governance fields and base rules that every owner scope preserves.

The Scope Schema defines allowed page, source, observation, and claim types plus field constraints, views, proposal rules, review rules, and lint rules for one User, Workspace or Server owner.

Each owner scope MUST have one active machine-checkable Scope Schema in YAML or JSON.

The schema MUST identify its version, owner or maintainer, active status, timestamps, allowed extension points, validation rules, and review requirements.

Scope schemas MAY strengthen OpenKit rules but MUST NOT remove or weaken required governance fields.

Schema changes MUST use a reviewable migration flow:

1. Draft and validate the schema change.
2. Dry-run it against existing pages, sources, maintenance records, proposals, indexes, and trace references.
3. Produce a validation report identifying valid, migrated, invalid-draft, and needs-review records.
4. Require human review when active retrieval, required fields, sensitivity, source-reference shape, or review rules change.
5. Apply the change only after authorization and preserve the previous valid schema plus the report.

If migration cannot repair a record safely, that record becomes an invalid or needs-review draft excluded from active retrieval.

If schema migration cannot prove a complete valid result, OpenKit MUST retain the previous valid schema and MUST NOT publish a partially migrated active schema.

## Conformance And Required Fields

OpenKit distinguishes portable format compatibility from active Knowledge validity.

| Level | Meaning | Permitted use |
| --- | --- | --- |
| `OKF-compatible` | The material follows the pinned portable Markdown and frontmatter envelope. | Import, inspection, source retention, or transformation. |
| `OpenKit-profile-valid` | The record satisfies OpenKit-required fields and base rules. | Drafts, proposals, generic tooling, and validation workflows. |
| `scope-schema-valid` | The record satisfies the active Scope Schema. | Active Knowledge after review and policy eligibility. |

External material MAY remain a source or lower-conformance draft until transformed and reviewed; format compatibility alone never authorizes active retrieval.

Every active Knowledge Page and every draft Knowledge Page validated for possible activation MUST carry these fields or equivalent structured metadata. Proposals, reviews, source-registry rows, maintenance ledgers, retrieval traces, indexes, audit records, and usage records use their separately owned exact schemas and are not active Knowledge Pages:

- `type`
- `title`
- `schema_version`
- `openkit_status`
- `scope`
- `source_refs`
- `review_state`
- `sensitivity`
- `freshness`
- `created_at`
- `updated_at`

Field behavior:

- `type` MUST be an OpenKit base type or an allowed Scope Schema extension.
- `title` MUST be human-readable and non-empty.
- `schema_version` MUST identify the validating Scope Schema.
- `openkit_status` is the unique OpenKit lifecycle authority and MUST distinguish draft, active, archived, superseded, invalid, and deleted records. Standard OKF `status` is a deterministic projection: draft maps to `draft`, active maps to `stable`, and the other four states map to `deprecated`. A missing standard status means `stable`; a conflicting projection is invalid. Standard status alone never activates an external page.
- Notebook revision is the service-resolved Git commit ID, outside page frontmatter. Profile v4 removes the unimplemented `openkit_revision` counter; exact identity is owner scope, notebook revision, page path and SHA-256 content digest.
- `scope` MUST identify the exact User, Workspace or current Server owner under `20260909-personal_memory_and_knowledge_learning.md`; narrower source restrictions remain additional constraints, never scope substitution.
- `source_refs` MUST exist even when empty; empty references are allowed only for direct user-authored notes, indexes, or policy-approved seed pages.
- `review_state` MUST distinguish unreviewed, user-authored, delegated, accepted, rejected, deferred, and needs-review records; there is no provisional active state.
- `sensitivity` MUST be explicit even when material is public or internal.
- `freshness` MUST distinguish evergreen, time-bound, stale, expired, and unknown material.
- `created_at` and `updated_at` MUST be machine-readable timestamps.

Reusable base types are `SourceSummary`, `KnowledgePage`, `Entity`, `Topic`, `Observation`, `Claim`, `Procedure`, `Decision`, `Lesson`, `Proposal`, `Index`, and `Log`.

Scope Schemas MAY add domain types, but consumers MUST preserve the base governance fields even when they do not understand an extension. OpenKit Knowledge Profile v4 uses `openkit_status`; the standard OKF lifecycle does not add a second state machine, retry policy, or recovery owner. Unknown nested YAML metadata is retained as data, including provenance, trust, and Attested Computation fields; reading or saving it never executes code, performs attestation, accesses a network, or grants authority. Secret-like field and value rejection applies recursively, including arrays; cyclic or excessive alias expansion is rejected before traversal.

## Save-Time Enforcement

All governed writes MUST pass through the Knowledge Store validation boundary.

Code MUST reject an invalid active write or retain it only as an invalid draft excluded from active retrieval.

Validation MUST cover malformed frontmatter, missing fields, disallowed types, invalid `openkit_status`, conflicting standard OKF `status` projection, invalid review state or source references, forbidden secret-like fields, missing sensitivity, invalid freshness or expiration metadata, and attempts to weaken OpenKit-required fields.

An invalid edit MUST NOT overwrite the latest valid active page.

Imports, rough notes, integrations, and drafts MAY be retained as invalid drafts when preserving the material is useful, and their validation errors MUST remain inspectable.

Repairing an invalid draft may produce a valid active page only under current explicit maintenance authority or an exact required human Review through the notebook publisher; otherwise it remains a valid draft or pending proposal. Structural validity alone never authorizes activation.

## Source Identity And Lineage

Every Knowledge Source MUST have stable identity across changes to derived representations, summaries, or Knowledge Pages.

Source metadata SHOULD record source identity, type, original location when available, capture time, producer, integrity digest when practical, access and sensitivity, derived-representation links, and retention policy when relevant.

Captured source evidence is immutable by default.

Replacing or recapturing evidence creates a new Knowledge Source id and registry record rather than silently mutating old captured evidence.

Every Derived Representation MUST retain lineage to the exact Knowledge Source id and content digest from which it was produced.

An external locator without captured identity MAY support review, but it MUST NOT be presented as immutable captured evidence.

## Personal Memory, Scoped Capture And Assessment

User Memory, Workspace Knowledge and Server Knowledge use the same governance with distinct current owners and output audiences. Personal conversation enters through a source-registered exact snapshot; it is not Worker/S39 evidence. The interaction-bounded, opt-in personal capture defined by `20260909-personal_memory_and_knowledge_learning.md` is an explicit exception to the older future-only passive-learning direction and does not authorize a recurring background job.

Generated learning and consolidation use explicitly delegated ordinary publication or the existing exact required Review path. Optional AI prove is a digest/source/rubric-bound assessment recorded as an existing Observation with result and limitations; it is never a Review or an authorization source. A policy-free advisory assessment cannot veto an authorized human decision. An explicitly authored critical-content policy may require assessment evidence before generated activation; the enforcement owner is that policy, not the model. Direct user editing stays available, invalidates content-bound assessment and cannot falsely preserve an accepted or verified label.

## Maintenance Records

Observations, candidate claims, conflicts, stale signals, lint findings, and health reports belong to the maintenance layer rather than the default notebook view.

Observation capture MUST be selective and the owning scope policy SHOULD bound allowed types, producers, required sources, retention, expiration, aggregation, promotion criteria, and high-impact review requirements.

An Observation MAY be ignored, retained, summarized, aggregated, attached to a pending proposal, or expired; repetition does not promote it automatically.

A Claim is a reusable assertion that may influence future work and therefore MUST carry sources, confidence, freshness, scope, review state, and conflict status.

Claims MAY guide source-grounded notebook editing, but a claim record is never publication authority; current maintenance delegation or an exact required Review remains necessary.

Conflict states SHOULD distinguish conflicting, needs-review, weak-evidence, stale, resolved, superseded, and partially superseded material.

Knowledge selection MUST surface unresolved conflicts and MUST NOT present one side as uncontested truth when the owning scope intentionally preserves competing views.

Maintenance records SHOULD use bounded append-only ledgers or equivalent history-preserving records; they MUST NOT create another Knowledge source of truth.

## Proposal And Human Review Rules

`20260909-knowledge_notebook_editing.md` owns one edit/publication contract. Ordinary authorized maintenance publishes a validated fixed-base Git revision without a synthetic review. A required review uses the existing Knowledge Proposal/Review owners and freezes owner scope, base/candidate commits, candidate digest, source references, producer, rationale and current assessment/critical-content requirements. The human accepts, rejects or defers exactly those bytes. Changed content/base requires a new proposal; no model may accept its own candidate. Pending/rejected/deferred candidates remain outside published content.

Publication revalidates scope, path, OKF/profile/schema, sources, confidentiality, current authority and exact base. Its unique content decision is the compare-and-set published ref; Audit and command receipts separately establish successful command completion. Failure and replay follow the notebook owner, with no inference from current page bytes, no duplicated prior-page Source archive and no repair runner. Human direct edits use the same publisher and are user-authored; delegated edits are marked delegated, not human-reviewed. Changed content invalidates earlier content-bound review/assessment labels.

Generated knowledge retains exact registered Source references or the existing strict completed-worker Turn/final Item/S39 evidence trio when claiming worker output. Current or historical generated pages may guide organization and comparison but are not independent factual evidence; preserve their underlying admitted source lineage. Imported, workspace-only, reconstructed or standalone retrieval history cannot masquerade as a new worker result. Only S39 proves worker delivery. Source references and captured evidence remain owned by their existing records, not Git history alone.

Active pages may preserve explicitly marked uncertainty; retrieval keeps the existing conflict exclusions. A relevant unresolved conflict is still determined from the latest conflict row's target/source subjects, not the conflict row's own evidence references. Its states `conflicting`, `needs_review`, `weak_evidence` and `stale` remain unresolved; `resolved`, `superseded` and `partially_superseded` do not independently block use. A conflict affecting publication under authored review policy requires that actual decision; a model score cannot suppress the conflict or fabricate resolution.

Archive/supersede are retained metadata edits through the same publisher. Multi-page merge/split and link repair are final-tree edits, not distinct workflows. Removing published pages requires exact human confirmation; restore appends an exact-base validated revision. Explicit forgetting additionally suppresses current and normal historical retrieval and automatic re-extraction, with truthful source/evidence/backup retention. No historical reset or downstream-effect reversal is implied.

Knowledge Manager owns the bounded invocation and semantic editing; the Knowledge Store owns all publication. Explicit maintenance and the accepted personal capture composition may call it; a new recurring/event trigger still needs its own accepted owner. No private lifecycle, automatic trigger, evaluation authority or second scheduler follows from the permission to edit.

## Health And Repair

The Knowledge Manager service contract exclusively owns the V1 health operation and report shape.

This governance contract requires that health inspection remain explicit and report-only.

It MUST NOT apply repairs, draft proposals, schedule work, or mutate knowledge.

Ordinary semantic repair uses explicitly delegated notebook maintenance and its final-tree publisher. Authority, source restrictions, schema and sensitive effects remain separate current decisions; report-only health cannot silently apply a repair.

## Knowledge Selection Trace Boundary

Knowledge retrieval MUST produce a deterministic selection result for identical authoritative inputs, index state, and policy state.

Its trace contribution MUST identify selected Knowledge Page ids and content digests, selected source or derived-representation references, excluded candidate identifiers and reasons, and applicable freshness, sensitivity, conflict, policy, and budget decisions.

The concrete Context Package owner decides package identity, trace shape, file inventory, delivery proof, replay, materialization, and product-versus-audit visibility.

The governed Knowledge retrieval trace proves only that selection ran; it does not prove worker delivery or use.

Only the owning worker-Turn delivery trace may prove which selected Knowledge reached a worker.

Restricted trace evidence MUST remain redacted or access-controlled under the owning policy and audit contracts.

## Capability Conformance

| Surface | Minimum governance |
| --- | --- |
| Import or capture | Portable source material or lower-conformance draft. |
| Draft create or rough note | OpenKit required fields when governed; invalid material may remain an invalid draft. |
| Proposal creation | `OpenKit-profile-valid` target shape or an invalid draft with attached errors. |
| Active Knowledge save | Human-authored, delegated or human-reviewed, policy-eligible, `scope-schema-valid` page with complete content and actor lineage. |
| Default notebook view | Active valid pages plus pending proposals and user-selected maintenance views. |
| Default worker Knowledge selection | Active, authorized, non-expired, policy-eligible `scope-schema-valid` pages. |
| Lower-conformance source snippet | Explicit policy authorization plus traceable source identity and exclusion reasoning. |
| Health inspection | Any conformance level, report only. |

## Current Implementation Projection

The current V1 implements portable governed page projection, the default Workspace Schema, pre-write validation and secret-like-field rejection, source identity and first text-derived metadata, observation and claim ledgers, conflict recording and resolution, derived indexes, deterministic retrieval traces, proposal review and application, and explicit Knowledge context preparation. The retrieval path does not yet consume the latest conflict ledger, so it cannot satisfy the required unresolved-conflict selection and trace decision; this bounded implementation defect remains scheduled under S60/S61 before the next generated-Knowledge release claim.

The transport-neutral operation catalog, bundled CLI, and public App API project those existing owners; no user-facing MCP facade remains.

Worker-facing Knowledge capability routes remain disabled and are not current product behavior.

The accepted-proposal path freezes exact create-only page bytes and digest, preserves proposal-to-review-to-page lineage, applies the one deterministic missing-page effect only for its matching accepted decision, and otherwise returns `recovery_required` for incomplete or contradictory authority. Bounded reversal removes only the unchanged proposal-created page and retains its durable evidence.

Context preparation references the single governed retrieval trace and exposes no standalone worker-context trace or materialization. Only S39 materializes and proves worker delivery.

No citation-based confirmation, TTL promotion or new scheduled trigger is implemented. Explicitly delegated notebook editing is accepted design but Not Started.

Concrete implementation detail remains in the Knowledge Store implementation, Knowledge Manager service, and Context Package specifications rather than being duplicated here.

## Testing Strategy / Acceptance Criteria

Use existing package and NanoCore suites; this specification authorizes no new runner, harness, or fixture framework.

- L1 governance tests cover active-write validation, secret rejection, source identity, delegated publication and required human-review authority, direct-mutation lineage, multi-page publication and history restoration, and fail-closed partial evidence.
- L2 contract tests prove proposal, review, page, command, actor, source, digest, and audit lineage remains resolvable without exposing restricted evidence or adding another lifecycle owner.
- S61 owns implementation and interruption tests, S17 owns caller and error tests, S39 owns direct-Task delivery tests, and S18 owns the single real L6 composition; this governance spec does not duplicate them.

Acceptance requires all of these predicates:

- Generated content cannot publish without explicit current maintenance authority or its exact required human Review.
- One authorized candidate publishes one complete Git revision, including all of its validated changed pages.
- Every active page resolves to published content/provenance; required human reviews bind exact candidate bytes, and successful commands have exact Audit/receipt evidence.
- Missing or contradictory application evidence fails `recovery_required` without inference or repair.
- Workspace-only, imported, reconstructed, or standalone Knowledge provenance cannot claim worker output.
- Only the owning worker delivery trace proves later Knowledge use.

## Risks & Mitigations

- Risk: human review becomes noisy before real proposal volume exists. Mitigation: use notebook-scoped delegation for ordinary edits and retain exact review for designated critical content.
- Risk: separate review and page writes leave a bounded interrupted state. Mitigation: publish content through one Git ref and report command success only when separate evidence verifies; retain explicit recovery-required results otherwise.
- Risk: reversal is mistaken for undoing downstream effects. Mitigation: reversal changes future active Knowledge only and preserves prior use evidence.
- Risk: Knowledge selection trace duplicates Context Package authority. Mitigation: retain only the Knowledge contribution and defer package identity, delivery, and replay to the owning contract.

## Resolved Decisions

- OKF-compatible Markdown is the portable envelope; the OpenKit Knowledge Profile and Scope Schema decide active validity.
- Programmatic validation enforces structure, Knowledge Manager operations support bounded maintenance, and authorized humans own Knowledge Review.
- Invalid material may remain a draft but never silently enters active retrieval.
- Raw captured sources are immutable by default and Derived Representations retain exact source-version lineage.
- Observations and claims remain evidence; authorized notebook publication creates reusable interpretation.
- Generated learning may use delegated publication; source lineage, current authority and any required Review remain mandatory.
- All notebook edits use one exact-base multi-page publisher with Git content lineage and explicit partial command-evidence handling.
- Reversal/restoration publishes a new exact-base revision through the same owner and never claims to undo external effects or erase intervening history.
- Knowledge selection contributes traceable page ids, content digests, and exclusions, while the separately owned worker delivery trace alone proves worker receipt.

## Deferred / Future Work

- Richer source conversion, binary capture, semantic retrieval, and broader source-reference validation remain deferred until current retrieval evidence justifies them.
- Health-driven ordinary notebook repairs use current maintenance authority; schema/authority changes remain separate configuration effects.
- Passive, event-triggered, or scheduled proposal drafting requires real-use evidence plus a separately accepted trigger contract and cannot itself grant maintenance authority.
- Richer imported notebook migration tools remain deferred until real incompatible bundles require them.

## Links

- `docs/core/knowledge.md`
- `docs/specs/20260703-knowledge_store_implementation.md`
- `docs/specs/20260704-knowledge_manager_internal_agent_runtime.md`
- `docs/specs/20260703-worker_context_package.md`
- `docs/specs/20260710-self_improvement_evaluation_loop.md`
