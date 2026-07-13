# Knowledge Store Governance Rules

Status: Accepted
Implementation: Partial

Implementation note: the accepted V1 governance slice is implemented; the Provisional Auto-Promotion contract below is not yet implemented.

## Summary

This spec defines the rules that make OpenKit knowledge stores enforceable, maintainable, and user-friendly.

The core decision is that OpenKit should use OKF-compatible Markdown files as the portable knowledge format, then add an OpenKit Knowledge Profile and a workspace-specific schema layer on top.

Programmatic validation and the Knowledge Manager agent jointly maintain the store. The program enforces mandatory structure. The Knowledge Manager is the primary maintainer for judgment-heavy work such as ingest, naming, summarization, lint, deduplication, conflict detection, stale detection, source-reference repair, and proposal drafting.

Program validation protects structural correctness. Knowledge Manager protects semantic health. User review protects authority.

The target user experience is an agent-maintained compiled notebook: sources and rough inputs are ingested, the Knowledge Manager incrementally compiles them into linked Markdown knowledge pages and indexes, users inspect the result through OpenKit Web and App product surfaces, and useful generated outputs can become direct knowledge proposals or artifacts depending on what they are.

The target agent experience is a unified context reserve: worker agents should be able to receive task-relevant material through NanoCore context packages without separately rediscovering whether the material began as a note, source file, PDF, meeting record, imported wiki page, source summary, or reviewed knowledge page.

`docs/core/knowledge.md` owns the canonical knowledge model. This spec owns the concrete governance rules that make that model enforceable in files, schemas, validation, proposals, review, and maintenance workflows.

## Owns

- OKF-compatible Markdown as the portable file envelope for OpenKit knowledge stores.
- The OpenKit Knowledge Profile layered over portable files.
- Workspace schema lifecycle, validation, migration, conformance levels, and failure behavior.
- Save-time enforcement rules for governed knowledge records.
- Source identity, immutability expectations, derived representations, and source-reference health.
- Observation, claim, conflict, proposal, health-check, and Knowledge Manager maintenance rules.
- Context package trace requirements for explaining how knowledge material was selected, excluded, and projected.
- The current implementation projection from the existing `memory` slice to the target Knowledge Store model.

## Does Not Own

- The canonical definition of knowledge, notebook, Knowledge Manager, source, proposal, review, retrieval, or context package.
- Final API routes, protocol field names, database tables, storage paths, or UI components.
- Worker prompt assembly, Workflow Coordinator responsibilities, or agent-session lifecycle.
- Worker capability routing, LLM/tool gateways, or metering.
- Vault secret storage, permission policy semantics, audit record schemas, or workspace synchronization.
- Domain-specific schemas for HR, marketing, finance, analytics, engineering, or other verticals.
- Raw source-of-truth records owned by external systems.

## Core References

- `docs/core/knowledge.md`
- `docs/core/agent-capability.md`
- `docs/core/agent-workflow.md`
- `docs/core/storage.md`
- `docs/specs/20260703-worker_context_package.md`
- `docs/specs/20260703-worker_agent_capability.md`

## Goals

- Keep knowledge user-readable as a notebook while making the store machine-checkable.
- Prevent a knowledge store from drifting into a pile of inconsistent Markdown files.
- Allow workspace-specific schemas without losing OpenKit-wide interoperability.
- Keep observations and low-level agent signals out of the primary notebook until they are reviewed or summarized.
- Define passive, active, and scheduled Knowledge Manager actions.
- Make it practical for users to provide rough notes, files, links, meetings, and integrations without manually curating every page.

## Non-goals

- Do not define final API routes, database tables, storage paths, or UI components.
- Do not redefine core knowledge semantics.
- Do not define domain-specific HR, marketing, finance, analytics, or engineering schemas as core concepts.
- Do not require a particular editor, markdown renderer, search engine, vector store, or graph database.
- Do not treat the Knowledge Manager as the only enforcement mechanism.

## Layered Format

OpenKit knowledge stores should use a layered contract:

```text
OKF-compatible files
  -> OpenKit Knowledge Profile
    -> Workspace Schema
```

OKF-compatible files provide the portable envelope: Markdown, YAML frontmatter, concept-like documents, links, citations, index files, and log files.

The OpenKit Knowledge Profile defines OpenKit-wide governance rules that every workspace must preserve.

The Workspace Schema defines domain-specific source types, knowledge page types, observation types, views, templates, review rules, and lint rules for one workspace.

## Schema Files

Each workspace should have a formal schema file stored as YAML or JSON.

The schema file should be the machine-checkable contract for:

- allowed source types
- allowed knowledge page types
- allowed observation types
- required frontmatter fields
- optional frontmatter fields
- field value constraints
- source reference shape
- page templates
- notebook views or tabs
- proposal rules
- review requirements
- lint and maintenance rules

Prose instructions may explain the schema, but prose instructions are not enough.

## Schema Lifecycle

Workspace schemas are long-lived knowledge governance assets.

Each workspace schema should have:

- `schema_version`
- owner or maintainer metadata
- active status
- created and updated timestamps
- allowed extension points
- migration notes
- validation rules
- review requirements for schema changes

Schema changes should be proposed, reviewed, and applied deliberately because they can affect every active knowledge page, observation, claim, proposal, index, and context package.

A schema change may require:

- validating all existing records against the new schema
- rewriting frontmatter fields
- reclassifying page types
- migrating observations or claims
- rebuilding indexes
- marking invalid records as drafts
- creating maintenance tasks for records that need human review

Schema migration should produce a validation report.

If a schema migration fails, OpenKit should preserve the previous valid schema and prevent invalid records from entering active retrieval.

First-slice schema changes should use a reviewable migration flow:

1. Draft a workspace schema change proposal.
2. Validate the schema syntax and compatibility with OpenKit required fields.
3. Run a dry-run migration against existing knowledge, observations, claims, proposals, indexes, and context-package trace references.
4. Produce a validation report with valid, migrated, invalid-draft, and needs-review counts.
5. Require review for changes that affect active retrieval, required fields, sensitivity, source-reference shape, or review rules.
6. Apply the schema change only after approval or policy authorization.
7. Preserve the previous valid schema and migration report for replay and rollback analysis.

If migration cannot repair a record safely, the record should become an invalid draft or needs-review record excluded from active retrieval.

## Conformance Levels

OpenKit should distinguish format compatibility from active knowledge validity.

| Level | Meaning | Usage |
| --- | --- | --- |
| `OKF-compatible` | The bundle or document follows the portable OKF-style Markdown and frontmatter shape. | May be imported, inspected, indexed lightly, or held as source material. |
| `OpenKit-profile-valid` | The record satisfies OpenKit-required governance fields and base type rules. | May participate in OpenKit knowledge workflows, proposals, and generic tooling. |
| `Workspace-schema-valid` | The record satisfies the active workspace schema. | May enter active retrieval and be used as trusted workspace knowledge. |

External OKF bundles should not be rejected only because they do not satisfy a workspace schema.

They may be imported as sources, invalid drafts, or lower-conformance material until transformed or reviewed.

Active knowledge used in context packages should satisfy `Workspace-schema-valid` unless an explicit policy permits a lower-conformance source snippet.

## OpenKit Required Fields

The OpenKit Knowledge Profile should require fields or equivalent structured metadata for governed records:

- `type`
- `title`
- `schema_version`
- `status`
- `scope`
- `source_refs`
- `review_state`
- `sensitivity`
- `freshness`
- `created_at`
- `updated_at`

Workspace schemas may add fields, but they must not remove or weaken OpenKit-required governance fields.

## First-Slice Required Fields

Every governed Knowledge Store record in the first implementation should carry the OpenKit required fields listed above.

First-slice field behavior:

- `type` must be one of the OpenKit base types or a workspace-schema extension.
- `title` must be human-readable and non-empty.
- `schema_version` must identify the workspace schema used to validate the record.
- `status` must distinguish draft, active, archived, superseded, invalid, and deleted states.
- `scope` must identify workspace scope and any narrower project, personal, thread-derived, or source-derived scope.
- `source_refs` must exist even when empty; empty source references are allowed only for direct user-authored notes, indexes, or policy-approved seed pages.
- `review_state` must distinguish unreviewed, user-authored, accepted, rejected, deferred, needs-review, and provisional states. Provisional is reserved for auto-promoted records under the Provisional Auto-Promotion rules.
- `sensitivity` must be present even when the value is public or internal.
- `freshness` must record whether the record is evergreen, time-bound, stale, expired, or unknown.
- `created_at` and `updated_at` must be machine-readable timestamps.

Workspace schemas may require stronger fields, but they must not weaken or omit these fields.

## Type Governance

OpenKit should define stable base types that all workspaces can reuse:

- `SourceSummary`
- `KnowledgePage`
- `Entity`
- `Topic`
- `Observation`
- `Claim`
- `Procedure`
- `Decision`
- `Lesson`
- `Proposal`
- `Index`
- `Log`

Workspace schemas may extend these types with domain-specific types.

Examples:

- A marketing workspace may add `BrandVoice`, `CreativeReference`, and `CampaignLearning`.
- An HR workspace may add `RoleRubric`, `HiringPrinciple`, and `InterviewLesson`.
- A technical workspace may add `ArchitectureDecision`, `RepoConvention`, and `Runbook`.

Consumers should understand the OpenKit base types even when they do not understand a workspace extension.

## Save-Time Enforcement

Mandatory schema rules must be enforced by code.

If a user, worker, integration, or Knowledge Manager tries to save an invalid governed document, NanoCore should reject the write, block the save, or save it only as an invalid draft that is excluded from active retrieval.

Save-time enforcement should cover:

- invalid YAML frontmatter
- missing required fields
- unknown type values when the workspace schema does not permit them
- invalid status or review state
- invalid source references
- forbidden secret-like fields
- missing sensitivity labels where policy requires them
- invalid freshness or expiration metadata
- attempts to weaken OpenKit-required governance fields

The Knowledge Manager may propose repairs for invalid records, but invalid active knowledge must not silently enter retrieval.

Invalid edits should not overwrite the latest valid active record.

First-slice behavior:

- Direct active updates that fail validation are blocked.
- Imports, rough notes, integrations, and Knowledge Manager drafts may be saved as invalid drafts when preserving the material is useful.
- Invalid drafts are excluded from active retrieval, worker capability search, and default context package selection.
- Validation errors should be attached to the draft or failed save result so the user or Knowledge Manager can repair them.
- Repairing an invalid draft creates a valid draft, proposal, or active record according to workspace policy.

## Source Identity And Immutability

Sources provide evidence and should have stable identity.

Each source should have a source identifier that remains stable even when derived representations, summaries, or knowledge pages change.

Source metadata should record:

- source id
- source type
- original location when available
- captured or imported timestamp
- producer or integration
- content hash or equivalent integrity marker where practical
- access and sensitivity metadata
- derived representation links
- retention policy when relevant

Raw sources should be treated as immutable evidence by default.

If a source must be replaced or recaptured, OpenKit should create a new source version or capture record instead of silently mutating the old evidence.

Derived representations should preserve lineage back to the source version they came from.

This identity and lineage make source references, claim validation, stale checks, and context-package traces debuggable.

## Notebook Versus Maintenance Layer

The user-facing notebook should stay readable and editable.

The notebook should primarily show:

- knowledge pages
- source summaries
- decisions
- procedures
- lessons
- project notes
- indexes
- reviewable proposals

The maintenance layer may contain:

- observations
- candidate claims
- conflicts
- stale signals
- duplicate-topic reports
- broken-link reports
- lint findings
- maintenance tasks

Observations and other low-level signals should not appear as ordinary notebook pages by default. They should be visible through maintenance views, digests, or proposal flows.

## Compiled Notebook Outputs

The notebook is not only an input surface. It is also an output destination.

Worker tasks may generate:

- answer pages
- research reports
- slide decks
- charts and visualizations
- generated diagrams
- source summaries
- comparison tables
- candidate concept pages
- index pages
- health reports

Generated outputs should not always be forced through an artifact-first path.

If a generated output is a task deliverable such as a report, chart, slide deck, exported document, design asset, or standalone file, it should be stored as an artifact first. After user review or policy approval, useful conclusions from it may be proposed into the Knowledge Store as knowledge pages, source summaries, claims, lessons, or source-linked artifact references.

If a generated output is already a knowledge page, source summary, index page, candidate claim, or page update, the Knowledge Manager may propose it directly as a Knowledge Store update without first creating an artifact.

Filing or direct proposal should preserve lineage back to the worker turn, prompt or task, source references, generated output or artifact when one exists, reviewer, and decision.

The Knowledge Manager may propose filing actions, but high-impact or opinionated output should not silently become active knowledge without review.

## Observations

An observation is an agent-recorded signal, not final knowledge.

An observation should include:

- the observed event or pattern
- source references
- scope
- timestamp
- producer
- confidence
- freshness
- possible interpretations when useful
- current status

An observation may support a claim, proposal, or knowledge page update.

An observation may expire without becoming knowledge.

Repeated observations may be aggregated into a candidate claim.

## Observation Retention And Promotion

Observation capture should be selective.

OpenKit should avoid turning every worker action into an observation.

Workspace schemas or policies should define:

- which observation types may be recorded
- which producers may record them
- required source references
- default retention period
- expiration rules
- aggregation thresholds
- promotion criteria
- review requirements for high-impact promotion

An observation may be:

- ignored as noise
- retained in the observation ledger
- summarized into a digest
- aggregated with related observations
- promoted into a candidate claim
- attached to a knowledge proposal
- expired or archived

Promotion should consider evidence count, source diversity, recency, confidence, user feedback, and potential impact on future worker behavior.

High-impact observations should not become active knowledge without review.

First-slice observations should be stored as workspace maintenance records, not ordinary notebook pages.

Recommended first-slice storage:

- JSONL observation ledgers for low-level observations and repeated signals.
- Periodic digest pages or health reports for human inspection.
- Knowledge proposals when an observation or group of observations should influence future worker context.

Observation ledgers should be file-backed, scoped to the workspace, and excluded from default notebook views. Promoted claims or accepted conclusions may become governed OKF-compatible knowledge records after review.

## Claims

A claim is a reusable assertion that may influence future work.

Claims need stronger governance than observations because workers may use them in context packages.

A claim should have:

- evidence through source references
- confidence
- freshness or expiration metadata
- scope
- review state
- conflict status when applicable

Claims may live inside knowledge pages, as structured frontmatter-backed blocks, or as separate records depending on the workspace schema.

## Conflict Model

Knowledge systems should preserve uncertainty instead of forcing premature resolution.

A record, claim, source summary, or page may be marked with conflict-related states such as:

- `conflicting`
- `needs_review`
- `weak_evidence`
- `stale`
- `resolved`
- `superseded`
- `partially_superseded`

Conflicts may come from newer sources, user corrections, changed workspace schema, external data freshness, contradictory observations, or disagreement between reviewed pages.

The Knowledge Manager should surface conflicts with source references and suggested actions.

A conflict may be resolved by editing, merging, splitting, superseding, archiving, adding scope limits, lowering confidence, or asking the user a clarifying question.

Some domains may intentionally preserve multiple competing viewpoints. In that case, the conflict relationship should stay explicit and context packages should avoid presenting one side as uncontested truth.

## Proposal Rules

Knowledge changes that affect future worker context should go through proposals unless policy explicitly allows direct edits.

Proposals may request:

- create
- update
- merge
- split
- supersede
- archive
- delete
- promote observation to claim
- promote claim to knowledge page content

Each proposal should identify sources, rationale, affected pages, confidence, freshness, and whether user review is required.

## Provisional Auto-Promotion

Some proposal producers — most importantly the Reflector's rubric and lesson distillation under `docs/specs/20260710-self_improvement_evaluation_loop.md` — generate a steady stream of small additive proposals. Requiring human review for every one of them makes the lightweight tier heavier than the mechanism it feeds. This section defines the only path by which a proposal may become active knowledge without a human decision.

Auto-promotion is disabled by default and enabled per workspace by explicit policy. When enabled:

**Eligibility.** A proposal is eligible for auto-promotion only when all of the following hold:

- The diff is strictly additive: it creates new records (or appends new self-contained entries to designated append-target pages) and does not modify, remove, reorder, supersede, or archive any existing record or entry.
- The proposed records are limited to workspace-schema-designated auto-promotable types. The default eligible set is `Lesson` and rubric-typed records; workspace schemas MAY narrow this set and MUST NOT widen it beyond additive-safe types (`Decision`, `Procedure`, and schema changes are never eligible).
- Knowledge Manager conflict detection finds no conflict between the proposed content and any existing active record, user-authored record, or user-stated preference.
- The proposal passes normal save-time validation at `Workspace-schema-valid`.

Any proposal that fails any condition escalates to the normal review path unchanged. Escalation is silent success, not an error.

**Provisional state.** An auto-promoted record enters active retrieval with `review_state: provisional` and MUST carry:

- a TTL expiry timestamp (workspace-configurable; default 30 days)
- a citation counter target (workspace-configurable; default 3) and current count
- the producing proposal reference and its evidence links

Provisional records participate in retrieval, worker knowledge capabilities, and context package selection like accepted records, but context package traces MUST label them as provisional so downstream consumers (including the Judge rubric snapshot) can weigh them.

**Confirmation and expiry.** A provisional record becomes `accepted` when a human confirms it through any review surface, or when it has been cited by at least the configured number of distinct subsequent task runs (citation means appearing as a used entry in a context package trace whose turn completed without a redo or rejection outcome). A provisional record that reaches its TTL without confirmation is archived with an `expired-provisional` reason and leaves active retrieval. Expiry is recorded; it is signal for the producing loop, not silent deletion.

**Visibility and rollback.** Every auto-promotion MUST be visible in proposal history and produce an audit event. A one-step rollback (archive the record, reopen the proposal as needs-review) MUST be available to the user for any provisional or provisionally-confirmed record.

**Invariant.** The worst-case outcome of auto-promotion is a temporarily useless provisional suggestion that expires; it can never durably corrupt the workspace preference profile, mutate existing knowledge, or bypass conflict detection.

TTL expiry sweeps and citation-count evaluation run as scheduled Knowledge Manager maintenance; the recurring-schedule mechanism in `docs/specs/20260711-scheduler_recurring_event_triggers.md` is the intended substrate.

## Knowledge Manager Actions

Knowledge Manager actions fall into three groups.

### Passive Actions

Passive actions happen after worker turns, ingest events, user edits, source updates, or review decisions.

Examples:

- record observations
- update logs
- validate schema conformance
- attach source references
- draft proposals from completed work
- detect whether a user correction should become reusable knowledge

### Active Actions

Active actions happen during user requests or when the Knowledge Manager is asked to help.

Examples:

- search and explain notebook content
- find relevant pages and source references
- suggest a page split or merge
- ask a clarifying question
- repair a broken link
- create a proposal for user review

### Scheduled Actions

Scheduled actions happen as periodic maintenance.

Examples:

- lint schema conformance
- find orphan pages
- find duplicate or near-duplicate topics
- check broken links and citations
- find stale claims
- summarize unreviewed observations
- surface conflicts between sources
- refresh indexes and logs
- produce a health report

## Health Checks

A health check should produce a prioritized report, not an unbounded rewrite.

It should identify:

- invalid records
- stale records
- duplicate topics
- orphan pages
- broken links
- missing citations
- unreviewed high-impact observations
- claims with weak evidence
- conflicting pages or claims
- schema drift

The health check may perform low-risk repairs allowed by policy. High-impact changes should become proposals.

Low-risk Knowledge Manager repairs may be applied without review only when they do not change meaning, authority, sensitivity, scope, freshness, or future worker behavior.

Allowed low-risk repairs:

- normalize frontmatter ordering and formatting
- add missing non-semantic derived metadata that can be computed deterministically
- repair internal links when the target move or rename is unambiguous
- update generated indexes from already-valid records
- remove duplicate whitespace or renderer-only formatting noise
- attach a missing source-reference backlink when both sides already identify each other

Repairs that change claims, conclusions, source interpretation, sensitivity, scope, review state, schema type, freshness, or retrieval eligibility must become proposals or needs-review records.

## Context Package Trace

Every context package should be explainable after the worker turn.

The trace is the audit counterpart of agent-near context. It preserves source diversity and policy decisions even when the worker saw a coherent projected package.

The trace should record:

- selected knowledge pages
- selected claims
- selected source snippets or derived representations
- selected artifacts or work-history records
- selection rationale where practical
- excluded candidates and exclusion reasons when useful
- policy, sensitivity, freshness, or token-budget exclusions
- package timestamp
- target worker turn
- package digest or equivalent identity

The trace does not need to expose unsafe or sensitive content to every product surface.

It may be split between item-visible records, audit records, and internal diagnostics.

The minimum requirement is that Core can later answer what the worker saw, what it did not see, and why.

Minimal context package trace visibility should follow the context package spec.

Item-visible trace projection should include:

- context package id or digest
- selected high-level source categories
- citations used by worker-visible outputs when available
- package freshness or sensitivity warning when user-relevant
- short explanation when important context was excluded for policy, sensitivity, or missing source reasons

Audit-only trace detail should include:

- selected and excluded candidate ids
- exact exclusion reasons
- policy decision ids
- sensitivity and freshness decisions
- budget fitting decisions
- package assembly timestamp
- package digest inputs
- source, derived representation, knowledge page, claim, artifact, and work-history references

Restricted trace evidence may hold redacted snippets, raw candidate summaries, or sensitive source locators under the evidence and audit retention rules. Product APIs must not expose restricted trace evidence by default.

## Capability Conformance Requirements

First-slice Knowledge APIs and worker capabilities should enforce conformance levels consistently.

| Surface | Minimum conformance |
| --- | --- |
| Import or capture source material | `OKF-compatible` when importing OKF material; otherwise source material may be retained as raw source pending transformation. |
| Draft create or rough note save | OpenKit required fields when the record is governed; invalid material may be saved as invalid draft. |
| Proposal creation | `OpenKit-profile-valid` for the proposed target shape, or an invalid draft with validation errors attached. |
| Active knowledge save | `Workspace-schema-valid`. |
| User notebook default view | Active `Workspace-schema-valid` records plus reviewable proposals and user-selected maintenance views. |
| Knowledge search for default worker context | Active `Workspace-schema-valid` records. |
| Worker `knowledge.search` and `knowledge.read` capability routes | Active `Workspace-schema-valid` records unless an explicit policy permits lower-conformance source snippets. |
| Context package selected knowledge | Active `Workspace-schema-valid` records unless the trace records why a lower-conformance source or snippet was permitted. |
| Knowledge Manager health and repair | Any conformance level, but repairs must not promote invalid material into active retrieval without validation and review where required. |

## Current Implementation Projection

The current implementation is the accepted V1 projection of the target Knowledge Store:

- `packages/protocol` defines `KnowledgeEntrySchema` with `preference`, `project-context`, and `task-summary` kinds. This is a minimal workspace knowledge record, not the target governed Knowledge Store schema.
- `packages/protocol/src/models/item.ts` and event schemas expose `knowledge-injection` item projection for product-visible bounded context injection.
- `packages/protocol/src/requests/workspace.ts` exposes knowledge create, update, delete, and list request shapes.
- `apps/nanocore/src/lib/store.ts` stores workspace knowledge entries and app-local knowledge proposals in the current file-backed store snapshot, then projects accepted knowledge entries into governed Markdown pages with a default workspace schema file.
- `apps/nanocore/src/app.ts` exposes `/api/workspaces/:workspaceId/knowledge` create, update, delete, and list routes with idempotent command handling.
- NanoCore currently exposes no worker Knowledge capability routes because Agent Environment Packages declare the capability plane disabled. The conformance table above remains the accepted requirement for future `knowledge.search` and `knowledge.read` routes.
- `apps/nanocore/src/action-center.ts` projects pending knowledge proposals into human-attention rows for accept, edit, reject, or defer review actions.
- `apps/nanocore/src/internal-agents/quick-chat.ts` retains the `searchKnowledge` diagnostic allowlist identifier. No internal Core tool executor or `knowledge-manager` mode runner is currently wired; the implemented Knowledge Manager surface is the App API context-package path below.
- `apps/nanocore/src/storage/fs-layout.ts` creates workspace `knowledge/` and `sources/` directories.
- `apps/nanocore/src/knowledge/okf.ts` implements the first-slice OKF parser, OpenKit Knowledge Profile validator, default workspace schema parser, workspace schema validator, conformance computation, and secret-like field rejection.
- First-slice observations are stored as workspace maintenance records in monthly JSONL ledgers under `knowledge/observations/<YYYYMM>.jsonl`. NanoCore, `@openkit/core-client`, and `@openkit/mcp` expose append/list surfaces for observation records with kind, summary, source references, scope, producer, confidence, freshness, status, observed timestamp, and creation timestamp; the records remain outside the user-facing notebook and default derived indexes.
- First-slice claims are stored as workspace maintenance records in monthly JSONL ledgers under `knowledge/claims/<YYYYMM>.jsonl`. NanoCore, `@openkit/core-client`, and `@openkit/mcp` expose append/list surfaces for claim records with statement, source references, scope, producer, confidence, freshness, review state, conflict status, and timestamps; the records remain outside the user-facing notebook and default derived indexes. Accepted, current, non-conflicting claims can be promoted into pending Knowledge Proposals through the existing review lifecycle, and accepted claim-derived proposals create source-linked `project-context` knowledge entries.
- First-slice conflicts are stored as workspace maintenance records in monthly JSONL ledgers under `knowledge/conflicts/<YYYYMM>.jsonl`. NanoCore, `@openkit/core-client`, and `@openkit/mcp` expose append/list/resolve surfaces for conflict records with subject references, source references, status, summary, suggested actions, producer, optional resolution metadata, and timestamps; the records remain outside the user-facing notebook and default derived indexes. Resolution is append-only: the ledger keeps prior rows while list/read surfaces project the latest row per conflict id.
- Current derived indexes file-backed knowledge pages only after they validate as active `Workspace-schema-valid` records, local `source:<sourceId>` or `knowledge:<knowledgeEntryId>` references resolve to registered workspace source or knowledge records, and external source references pass the V1 HTTP(S) URL syntax gate. The same rebuild pass writes `indexes/knowledge-links.json`, a directed Markdown concept-link graph for active valid pages with broken local links recorded as unresolved edges and external URLs excluded from the concept graph, `indexes/knowledge-validation.json`, a per-page validation report for conformance, active/indexed state, profile/schema errors, and local or external reference errors, `indexes/knowledge-source-refs.json`, a source-reference index that classifies page references as registered sources, workspace knowledge references, or external references with local resolution or external syntax status, and `indexes/knowledge-fts.json`, a portable full-text term index over active valid knowledge page titles and bodies. Registered text source material writes derived representation metadata under `sources/derived/<sourceId>/text.json`; source register/read responses expose that metadata without returning captured content, and workspace export/import preserves it. NanoCore, `@openkit/core-client`, and `@openkit/mcp` expose a read-only derived-index surface for those four knowledge indexes. NanoCore also exposes deterministic retrieval that ranks active valid pages from the portable full-text index, returns selected and excluded candidates with reasons, and persists the same trace to `knowledge/traces/<YYYYMM>.jsonl`. Knowledge Manager context material preparation selects accepted, current, non-conflicting claims related to selected knowledge material, carries unresolved conflicts related to selected knowledge or selected claims, returns selected claim ids, selected conflict ids, selected explicit artifact ids, selected artifact records, and the compact context policy summary in the package trace, persists the returned response snapshot under `knowledge/context-packages/<YYYYMM>.jsonl`, exposes a read API plus MCP tool for one persisted trace by context package id, writes a worker-visible `/openkit/context` snapshot with captured text snippets for registered sources referenced by selected knowledge material and files for explicitly selected inline artifacts, workspace files, and materialized workspace-root text files, and exposes digest-checked readback for that stored snapshot. The manifest carries byte/file/token-estimate budget metadata, package-relative paths, `normal` or `redacted` entry sensitivity labels, and source entry provenance fields; worker-visible files apply raw-secret-shaped material redaction before write; unavailable referenced sources are recorded as `source_unavailable` decisions. Broader OKF serialization, richer source conversion, semantic retrieval, external reference fetching, scheduled maintenance, and richer merge/edit proposal mechanics remain deferred future work.

## User Control

The user or team remains the editor-in-chief.

The Knowledge Manager can maintain, propose, and repair. It should not silently rewrite active high-impact knowledge when schema or policy requires review.

Users should be able to inspect and edit the notebook without understanding every maintenance record.

## Consequences

- OpenKit can use OKF without treating OKF's minimal rules as the full governance model.
- Workspaces can customize their schemas while preserving OpenKit-wide base types and required governance fields.
- Programmatic validation prevents schema drift before it becomes a knowledge quality problem.
- Knowledge Manager maintenance prevents the notebook from accumulating stale, duplicate, or unreviewed material.
- Observations can accumulate evidence without cluttering the user-facing notebook.
- Schema lifecycle rules protect existing knowledge when a workspace schema evolves.
- Conformance levels let OpenKit import open OKF material without allowing invalid records into active retrieval.
- Source identity and context package traces make knowledge use debuggable after worker execution.

## Resolved Decisions

- Knowledge Store is the canonical target concept; the older `memory` implementation naming has been removed.
- OKF-compatible Markdown is the portable envelope, but OpenKit Knowledge Profile and Workspace Schema decide active OpenKit validity.
- Programmatic validation enforces mandatory structure. Knowledge Manager maintains semantic health. User or team review preserves authority.
- Invalid active knowledge must not silently enter retrieval. Invalid material may be rejected, blocked, or saved as an invalid draft excluded from active retrieval.
- Raw sources are evidence and should be immutable by default. Source replacement creates a new version or capture record.
- Observations are low-friction signals, not notebook pages by default.
- Claims need stronger governance than observations because workers may reuse them through context packages.
- High-impact generated output, observations, claims, and Knowledge Manager repairs require review unless policy explicitly allows direct application.
- Artifacts are not a required middle step for ordinary ingest-to-knowledge updates.
- Context package traces must make worker-visible knowledge selection explainable after execution.
- All governed records require the OpenKit required fields in the first slice. Workspace schemas may strengthen but not weaken them.
- Invalid active edits are blocked. Invalid imported, rough, or drafted material may be saved as invalid drafts excluded from active retrieval.
- Workspace schema changes use a reviewed dry-run migration flow with validation reports and previous-schema preservation.
- First-slice observations live in workspace maintenance JSONL ledgers, with digests or proposals used to surface important patterns.
- Knowledge Manager may auto-apply only non-semantic low-risk repairs. Meaning-changing or retrieval-affecting repairs require proposals or review.
- Default worker knowledge search, read, and context package selection require active `Workspace-schema-valid` records unless explicit policy permits lower-conformance source snippets.
- Minimal context package trace visibility is split into item-visible package and citation summaries, audit-only selected or excluded detail, and restricted evidence for sensitive trace material.
- Auto-promotion without review exists only through the Provisional Auto-Promotion path: strictly additive diffs of designated types, no conflict-detection hits, provisional review state with TTL and citation-based confirmation, per-workspace opt-in, visible history, and one-step rollback.

## Deferred / Future Work

- Add full YAML-compatible OKF serializer and lint rules.
- Extend OpenKit Knowledge Profile and workspace schema files beyond the first-slice validator.
- Extend the implemented source identity registry with binary byte-copy materialization, richer derived representation records, and source-reference validation beyond local source and knowledge ids.
- Extend observation, claim, conflict, proposal, review, and health-check records beyond the first implemented slices.
- Extend context package traces with complete audit-only exclusion, sensitivity, freshness, and replay detail beyond the V1 readable trace and digest-checked materialization.
- Add scheduled Knowledge Manager maintenance loops after the on-demand V1 health check and repair suggestion paths have real usage evidence.
- Add richer migration and repair tools for legacy or imported external notebook bundles that cannot be projected through the current governed page and proposal surfaces.

## Links

- `docs/core/knowledge.md`
- `docs/specs/20260703-worker_context_package.md`
- `docs/core/storage.md`
- `docs/core/agent-capability.md`
- `docs/specs/20260703-worker_agent_capability.md`
- `docs/specs/20260710-self_improvement_evaluation_loop.md`
- `docs/specs/20260711-scheduler_recurring_event_triggers.md`
- `docs/specs/superseded/agent-workflow/20260526-nano_core_lightweight_agents.md`
