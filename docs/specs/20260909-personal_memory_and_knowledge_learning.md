---
status: Accepted
kind: concept
implementation: Partial
aspect: knowledge
---
# Personal Memory And Scoped Knowledge Learning

This specification owns the User, Workspace, and Server projections of the Knowledge Store, personal Memory recall and explicit saving, conversation-source intake, Knowledge Manager integration, scoped notebook editing and forgetting, scheduled daily maintenance, and explicit completed-work reflection and Knowledge improvement.

## Scope

### Owns

- The `ownerScope` model (`KnowledgeOwnerScopeSchema` in `packages/protocol/src/models/knowledge-notebook.ts`; closed protocol identifiers in `docs/specs/20261021-protocol_identifiers_and_enums.md`), personal Memory recall and explicit saving (`memory.*`), conversation-source intake, and user-confirmed `forget` with source-version suppression.
- Scoped Knowledge Manager integration, default-off daily maintenance (`## Scheduled Maintenance`), external-influence retention across Memory and Knowledge, and candidate-specific AI evidence-assessment rules.
- The explicit completed-Workspace-work reflection and Knowledge improvement composition (`## Reflection And Improvement`), including its strict Worker/Item/Context-Package evidence boundary, human Review activation, bounded reversal, and future Evaluation Harness activation gates.

### Does Not Own

- Canonical Knowledge semantics in `docs/core/knowledge.md`, Identity in `docs/core/identity.md`, Policy in `docs/core/policy.md`, or Storage in `docs/core/storage.md`.
- Knowledge Store governance and implementation in `docs/specs/20260702-knowledge_store_governance_rules.md` and `docs/specs/20260703-knowledge_store_implementation.md`, or fixed-base notebook editing in `docs/specs/20260909-knowledge_notebook_editing.md`.
- Knowledge Manager runtime mechanics in `docs/specs/20260704-knowledge_manager_internal_agent_runtime.md`, or recurring trigger dispatch in `docs/specs/20260711-scheduler_recurring_event_triggers.md`.
- Procedural Skill candidates, exact version pins, comparisons, and rollback in `docs/specs/20260711-skill_catalog_versioning_pinning.md`.
- Worker Context Package materialization and delivery proof in `docs/specs/20260703-worker_context_package.md`, or external-influence source and gate rules in `docs/specs/20261109-runtime_security.md` E9.

### Core

- `docs/core/knowledge.md`
- `docs/core/policy.md`
- `docs/core/identity.md`
- `docs/core/storage.md`
- `docs/core/agent-supply.md`
- `docs/core/doctrine.md`
- `docs/core/architecture.md`
- `docs/core/work-model.md`
- `docs/core/protocol.md`
- `docs/core/evidence.md`

## Scope, Storage, And API Projection

Memory is personally owned reusable understanding (`{kind: "user", userId}`); Knowledge is Workspace-owned (`{kind: "workspace", workspaceId}`) or Server-owned (`{kind: "server"}`) reusable understanding. Scope-qualified identity, not title or page ID alone, identifies every page and associated record through one implementation parameterized by a trusted resolved owner. User ownership is independent of Quick Chat or any project Workspace: personal Memory stays private when the user joins, leaves, or switches Workspaces, and a project-derived fact retains its source restriction without granting cross-Workspace import or post-revocation use. Server Knowledge serves deployment administration initially; publishing any subset for ordinary member use requires explicit authorized promotion into that member's Workspace.

Under `docs/specs/20260703-storage_layout_record_ownership.md` and `docs/specs/20261018-file_storage_and_knowledge_packages.md#raw-file-tracking-in-git`, scoped notebooks live under `users/<userId>/memory/`, `workspaces/<workspaceId>/knowledge/`, and `server/knowledge/`, each containing `notebook.git/`, optional materialized `pages/`, `schema/scope-schema.yaml`, `proposals/`, `reviews/`, rebuildable indexes, and canonical `SourceSummary` pointers at Notebook Git paths `sources/<sourceId>.md` with managed originals under that scope's `raw/`. Profile and schema `v4` (`OPENKIT_KNOWLEDGE_PROFILE_VERSION` and `DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_VERSION` in `apps/nanocore/src/knowledge/okf.ts`) record exact `ownerScope` (`KnowledgeOwnerScopeSchema`) without a page counter, and emit `REQUIRED_SCOPED_KNOWLEDGE_FEATURES` in `required_features` on scoped Page frontmatter and `requiredFeatures` on governed JSON mutation records and export manifests; unsupported readers reject before retrieval, mutation, or import. OpenKit retains published Git revisions for joint human and Agent editing rather than a resettable single-commit baseline; prerelease data follows [Pre-Stable Data Continuity](../decisions/20261014-pre_stable_data_continuity.md) without predecessor readers or retired Workspace `memory` aliases.

User management uses `memory.*` App operations at `/api/app/operations/<operationId>`, resolving the owner from current authentication (never from a payload user ID). User Memory read and mutation eligibility follows [Core Policy](../core/policy.md) while ownership stays with the original User; Workspace Knowledge requires active membership, and Server Knowledge requires deployment administration. The Notebook UI labels User pages `Memory` and Workspace/Server pages `Knowledge`, showing source, applicable scope, saved entries, and pending changes separately.

## History, Explicit Saving, And Personalization

Private Thread history, transient prompts, provider caches, and inferred preferences are not saved Memory. An explicit instruction passes supplied information to Knowledge Manager for integration; an exact saved expression may be `user-authored`, and users may make direct edits, whereas a model's expanded interpretation is generated content requiring current maintenance delegation or Proposal approval, and a one-task exception never rewrites a standing preference.

The Personal Assistant receives separate bounded Memory and Knowledge overviews from their admitted root `index.md` files and queries User Memory and admitted Knowledge in separate invocations with independently fixed limits (`1` through `20`, current default `5`), never merging them into a shared score-ranked list. Personal preference may influence a private reply across Workspaces but never overrides current instructions, policy, tool admission, target schema, or required decisions. Workers cannot read User Memory even when acting for its owner; a selected preference crosses into shared Task or Goal work only through explicit handoff or promotion with destination validation and disclosure checks.

Before a generated `memory.tell` candidate revision, digest, or Review is frozen, Core normalizes system facts ([Memory System Facts And Asking Trace](../decisions/20261024-memory_system_facts_and_asking_trace.md)): a new page receives `openkit_status: active` and `status: stable`, an existing page retains its lifecycle, Core supplies `created_at` (preserved on edits) and updates `updated_at` only when normalized content changes. `no-change` on `memory.tell` means no Memory page changes were published by that request (even if literal Source capture succeeded).

## Deterministic Retrieval And Conflicts

Every query runs in one trusted `(Server, Workspace, Actor, Thread/Turn)` context ([Query Context, Sources, References And Acts](../decisions/20261015-context_sources_references_query_acts.md)). Missing Server, Workspace, or Actor or contradictory context fails before source inventory. Memory recall requires that User's private Assistant Timeline in the current Workspace (a role label or User credential never makes a shared Thread eligible) and addresses only that User's Memory. A Knowledge retrieval invocation addresses one admitted Knowledge Base (Workspace by default; admitted Server Knowledge as a separate invocation). Within one source, candidates order by pinned-first, descending local score, then bytewise `pageId` and `revision`.

Pins, trace entries, and citations use [Core Protocol references](../core/protocol.md#scope-qualified-object-references) `(scopeId, objectId)`. Each query with a Thread or Turn publishes one immutable selection trace file under that querying owner (the private Assistant Timeline for Assistant queries; the Task/Goal Thread for Worker queries, which never contain Memory selections), while threadless direct User App calls publish no trace. Trace reads and exports recheck both the containing record's audience and current source access for every reference. Contradictory factual pages remain source-attributed conflicts and are never resolved merely by preferring User over Workspace or Server; protected-source revocation invalidates derived candidates even when a personal snapshot remains stored. Future cross-Workspace or cross-Server source bindings require separately accepted contracts (`#260`, `#261`, `#297`).

## Conversation-Source Intake, Forgetting, And Portability

Selected completed Assistant or human conversation Items (or explicit self literal documents) are captured through the Knowledge Source registration owner before drafting, storing exact Item identities/digests, cutoff, originating Thread/Workspace/user attribution, audience, capture time, and restrictions with the captured bytes (`source:<sourceId>@<digest>`). Synchronous Notebook validation checks pointer closure (`source:<sourceId>` and `source:<sourceId>@<contentDigest>`), while original delivery uses asynchronous Storage reads verifying exact bytes, size, digest, and current authority. Conversation capture is conversation evidence, never fabricated `AgentSession`, Context Package, or completed Worker Turn evidence, and source and destination permissions are rechecked at capture, draft, apply, and retrieval.

User `forget` is an authorized operation over an exact page revision and digest, gated by an Item-backed human confirmation displaying the exact owner, page, revision, digest, removed content, suppression effect, and retained source/evidence/backup scope. Application rechecks current self authority and exact revision/digest, rejects stale targets, replays identically on completed requests, marks the page unavailable before derived index cleanup, blocks pending candidates based on the forgotten material, and records minimal `{scope, id, lastRevision, digest}` and sorted unique `source:<sourceId>@sha256:<digest>` fingerprints without retaining forgotten prose as a tombstone. A forgotten `pageId` stays reserved (later explicit saves use a new `pageId` at the current base and do not clear raw-source suppression for model delivery). While suppression is active, `memory.source.read` returns `null` for a matching Source-version fingerprint, `memory.source.list` withholds that version's metadata including title, and model query/maintenance contexts and Proposal previews withhold reserved `index.md`/`log.md` navigation bodies and historical diffs (invalidating any in-flight run if suppression appears before its next disclosure or effect), while authorized human Source inspection retains access to stored bytes.

If learning produces a reusable procedure, it submits a `SkillCandidate` to `docs/specs/20260711-skill_catalog_versioning_pinning.md` rather than storing executable behavior as a Memory page. An ordinary Workspace bundle exports Workspace Knowledge and shared admissible sources, never User Memory or Server Knowledge. The User `disabled` state immediately blocks Memory reads, extraction, and publication without transferring ownership. On an authenticated User's first `memory.ask`, `memory.search`, or `memory.tell`, after verifying current Workspace access and the private Assistant Timeline (and preflighting the personal Workspace for maintenance), a genuinely fresh User Memory scope initializes its empty `v4` Notebook once, whereas missing established storage or incomplete initialization evidence returns `recovery_required`.

### Carried External Influence And Future Assessment

Memory written from an influenced agent context MUST retain its `externallyInfluenced` bit (`KnowledgeNotebookCommitMetadataSchema` in `packages/protocol/src/models/knowledge-notebook.ts`), and reading it MUST mark the receiving context influenced before use; consolidation, summaries, derived representations, and human Review MUST NOT erase known influence, and missing ancestry counts as influenced ([Runtime Security](20261109-runtime_security.md) E9; [Knowledge](../core/knowledge.md)).

When candidate-specific AI evidence assessment (`prove`, `#264`) is enabled, it uses independent admitted Sources or observed checks, an explicit rubric, and an existing `Observation` recording assessed digest, Sources, assessor/model identity, closed outcome `supported | contradicted | insufficient_evidence`, limitations, and time; source or candidate changes invalidate it, positive assessment never replaces human Review, and advisory assessment cannot veto an authorized human decision. When an authored policy requires assessment for generated activation, unavailable, failed, or insufficient assessment leaves the candidate pending. Changing that requirement is a separate authorized policy decision; an assessment cannot repair missing disclosure authority.

## Scheduled Maintenance

[Knowledge Manager Agent](20260704-knowledge_manager_internal_agent_runtime.md#query-and-maintenance-execution) owns the bounded run and publication contract, and [Recurring Triggers](20260711-scheduler_recurring_event_triggers.md#knowledge-manager-daily-maintenance) owns daily trigger admission. Server, User, and Workspace scopes each have one independent `knowledgeMaintenance.schedule.enabled` boolean (`KnowledgeMaintenanceSchema` in `packages/config-schema/src/knowledge-maintenance.ts`), current default `false`, with fixed daily cadence and no custom cadence or count knobs. Workspace intake bounds each run to at most `8` eligible completed prior Turns (capturing completed human Items and excluding active/inaccessible work, Knowledge Manager outputs, prior generated maintenance/assessment output, pending proposals, and unreviewed generated text), and candidate submission enforces the shared notebook editor's `256`-changed-file bound. Failed or incomplete source ranges are not marked processed; human edits since the previous run are preserved as inputs and never overwritten; Server maintenance takes only explicit requests, admitted Server Sources, and human Server-notebook edits (`sourceRange` is empty); and failed, skipped, or no-op runs record visible outcomes without replaying models or resuming hidden editing sessions.

## Reflection And Improvement

This section owns the explicit completed-Workspace-work reflection composition:

### Scope, Boundaries, And Operation Composition

- A reflection pass begins only when an authenticated User explicitly asks an authorized agent (operating through remote MCP guide and operation tools or the bundled administrator CLI) to inspect retained completed Workspace work; it reuses existing work-history reads, `knowledge.proposal.draft` (`KnowledgeManagerDraftProposalRequestSchema` in `packages/app-api-schemas/src/knowledge-manager.ts`), `knowledge.proposal.decide`, `knowledge.proposal.reverse`, and Knowledge Page reads as a transport-neutral composition rather than a `knowledge.reflect` operation or NanoCore subsystem.
- The composition introduces no reflection-specific route, schema family, module, durable record, table, file-backed ledger, lifecycle, Internal Core Role, persistent Reflector, Task Evaluator runner, private session, scheduler, event hook, retry queue, checkpoint, recovery workflow, `EvalTask`, Judge, evaluation suite, or Evaluation Harness implementation. Completed-work projections, remote MCP and CLI, pending Proposals (`docs/core/knowledge.md`, `docs/specs/20260702-knowledge_store_governance_rules.md`, `docs/specs/20260703-knowledge_store_implementation.md`), human Review decisions, deterministic retrieval, command-idempotency receipts, Audit and Usage records, and accepted [Worker Context Package](20260703-worker_context_package.md) delivery traces remain the sole owners.
- Within this caller composition, the reviewing agent either returns an honest advisory explanation when evidence does not justify one bounded reusable lesson, or invokes `knowledge.proposal.draft` at most once with complete create-only Knowledge Page content (`KnowledgeProposalPageIdSchema`) for one new page, while the shared Proposal command and separately admitted Notebook maintenance retain exact-base replacement and multi-page updates/merges for other authorized compositions (`docs/specs/20260909-knowledge_notebook_editing.md`).
- A reflection candidate MUST NOT describe a generic update, merge, Skill change, or workflow change. This composition never mines work passively or on a schedule (`## Scheduled Maintenance` governs scoped daily learning), never infers improvements from incomplete or cross-Workspace history (`#260`), and grants no authority to evaluate or mutate Skills (`#313`), prompts, Agents, workflows, coordinator behavior, NanoCore code, or external systems, nor to automatically accept, promote, confirm, expire, or reverse Knowledge. Opted-in conversation-source learning and delegated Notebook editing remain distinct from strict completed-Worker/Context-Package reflection proof.

### Evidence Boundary

- Primary completed-work evidence for the proposal mutation requires one terminal direct-Task Worker Turn in the same Workspace, that Turn's final completed `assistant-message` Item (a request `user-message` or other completed Item cannot masquerade as Worker output), and the same-owner, strictly verified accepted Context Package digest exposed on `turn.read` (`turn:<turnId>`, `item:<itemId>`, and `context-package:<turnId>@<contextPackageDigest>`).
- Imported history and any Turn without retained verified package bytes project a `null` digest and MUST NOT supply or fabricate strict delivery evidence; a missing accepted Context Package trace or source proof MUST NOT be reconstructed or replaced with current mutable Workspace files.
- Optional corroborating references may cite an exact registered Knowledge Source (`source:<sourceId>@<contentDigest>`) or a directly `user-authored` Knowledge Page (`openkit:<page-scopeId>/<knowledgePageId>@<contentDigest>`), never a generated `accepted` Page (avoiding a transitive proposal-authority graph). Other Artifacts, Reviews, EvidenceBundles, Audit records, Usage records, or external material may guide advisory analysis only and must be captured through the registered Knowledge Source owner before serving as Proposal evidence.
- Secret values, Vault material, raw credentials, unrestricted host paths, and cross-Workspace content MUST NOT enter the Proposal, Review projection, Audit summary, or CLI output.
- When evidence is missing, contradictory, `restricted`, denied by current policy, secret-bearing, stale, unavailable, or too weak, the agent returns ordinary advisory output without calling the Proposal mutation and creates no durable `advisory`, `partial`, `reflection`, or `evaluation` record.

### Proposal Creation, Review, Delivery, Reversal, And Failure

- **Drafting and command idempotency**: Deterministic `knowledge.proposal.draft` runs no model, validates exact same-Workspace source references, content shape, and current authorization, and freezes the notebook base commit, candidate commit, new target page ID (never silently reusing an existing or suppressed page ID), exact page bytes, content digest, and Source lineage (`KnowledgeProposalRecordSchema` in `apps/nanocore/src/storage/knowledge-proposal-codecs.ts`) before returning the pending Proposal ID (`kp_` over `{ownerScope, requestId}` with complete structured `ownerScope`) and validation result. Fixed candidate bytes cannot be modified in place; changing a candidate requires a new Proposal. The command-ledger key is `command + requestId + scope` with canonical owner scope `{kind: "workspace", workspaceId}` and the complete normalized draft request as input hash (title and candidate fields never enter ledger scope to partition or bypass conflict detection): a stored completed receipt for an identical request replays through the existing owner projection, any changed draft input under the same Workspace and `requestId` returns `idempotency_key_conflict`, and a deterministic Proposal found for `{ownerScope, requestId}` without a completed receipt returns `recovery_required` without reconstructing a response or expanding the direct-mutation ledger contract.
- **Human Review activation**: The existing Knowledge Proposal and Knowledge Review owners (`KnowledgeProposalReviewFileSchema` / `KnowledgeProposalReviewRecordSchema`) decide `accepted`, `rejected`, or `deferred`; human Knowledge Review is the sole activation authority for this explicit composition (other delegated maintenance compositions follow their own accepted admission), and agent output, Proposal existence, retrieval selection, citation count, or later model agreement never activates Knowledge. Acceptance rechecks the fixed base and candidate commits, current authorization, validation, conflict status, sensitivity, and source lineage through the common notebook publisher, activating content only when the canonical published head commits with completed command evidence (Workspace native SQLite transaction or User/Server ordered physical stages), returning `409 conflict` on a stale base or `recovery_required` on an incomplete or contradictory decision, publication, or receipt tuple without automatic missing-page completion. Rejecting or deferring changes only the Review lifecycle and MUST NOT trigger an automatic agent call, Worker Turn, retry, or follow-up.
- **Later Worker delivery proof**: Deterministic retrieval selection and its trace are audit inputs only, not delivery proof; the owning mode service and `docs/specs/20260703-worker_context_package.md` alone select, persist, materialize, and prove Worker context delivery. A later Task Worker has received and used the accepted page only when its accepted Context Package trace names the exact page identity, content digest, source references, materialized path, and verified bytes under the Worker Turn's owner tuple; if any required trace, byte, digest, or owner field is missing or contradictory, delivery remains unproved and the Context Package path fails closed without reflection repairing, replacing, or settling delivery.
- **Reversal and failure**: A restoration request through `knowledge.proposal.reverse` is a current-base Knowledge-owner publication naming the current base commit, the retained historical Proposal-base commit, and the selected page paths; it binds the exact Proposal, Review, Page, and digest lineage, computes a validated diff, requires exact human confirmation for removal, and publishes a new revision while preserving intervening Git, Proposal, Review, Source, command, and Audit history without rewinding the published head, blindly deleting a later edit, reopening completed work, or enqueuing follow-up execution (`409 conflict` if current base or target page changed; `409 recovery_required` on missing or contradictory lineage; zero mutation on both). After failure, interruption, or restart, only records owned by completed work, Proposal, Review, Page, command ledger, Audit, Usage, and Context Package contracts remain: An interrupted reviewing-agent attempt remains incomplete; starting a fresh attempt requires explicit User authorization. Any authorization/store/history/provider/Worker/transport failure returns its existing bounded error, and only an already created pending Proposal remains inspectable through its existing owner.

### Future Activation Gates

- Scheduled or event-triggered reflection waits until explicit use demonstrates value and a separately accepted trigger design exists (`#313`).
- #311 tracks the design proposal. A concrete Evaluation Harness design may be proposed only when all five activation gates hold:
  1. Real use has produced repeated evaluations of the same asset family, rather than only planned scenarios or repository tests.
  2. Those evaluations demonstrate a specific invariant that existing Turn, Context Package, Artifact, EvidenceBundle, and human-review owners cannot express safely or reliably.
  3. The missing capability causes a measured correctness, security, review-cost, or repeatability problem large enough to justify another maintained product mechanism in the documented small-deployment profile.
  4. The proposed mechanism reuses existing scheduler, sandbox, provider, policy, Audit, Usage, and Review owners without becoming a second workflow engine or test platform.
  5. An accepted replacement specification defines the smallest record and execution boundary needed before implementation begins.
- Until all five gates are met, manual or request-scoped evaluation through existing owners remains the accepted fallback.

## Acceptance

- Multi-user and cross-scope isolation verification proves that ordinary users and Workers remain isolated from another user's Memory across direct APIs, search, indexes, exports, and model context, ABA concurrent direct-edit vs reviewed-replacement conflicts preserve the winner, and explicit `forget` survives restart and index rebuild while suppressing re-extraction without deleting shared originals.
- For explicit completed-work reflection (`## Reflection And Improvement`), historical A1 stock OpenShell/Codex completion is historical evidence only and a skipped or synthetic story is not L6 acceptance evidence (with no separate reflection endpoint runner, Evaluation Harness, crash matrix, recurring-trigger story, Judge story, or long-horizon platform required):
  - **L1/L2**: exact same-Workspace Worker source validation, create-only target enforcement, request replay and conflict, product-safe errors, application retry boundaries, stale-safe reversal, and one negative-advisory check proving that missing, contradictory, `restricted`, policy-denied, secret-bearing, or insufficient evidence causes no Proposal call and no durable Knowledge or reflection state.
  - **L3**: one direct-Task path selects one accepted page into the exact Context Package and excludes one invalid or `restricted` candidate.
  - **L6**: real-surface verification through remote MCP, the administrator CLI, and the stock runtime for one useful completed Task, explicit agent review, pending Proposal, human decision, later Task Context Package delivery, and reversal.

## Implementation

- Scoped Memory, Source intake, forgetting, and maintenance runners: `apps/nanocore/src/knowledge/`, `apps/nanocore/src/`.
- Governed retrieval, Proposal/Review codecs, and Context Package assembly: `apps/nanocore/src/storage/`, `apps/nanocore/src/context/`.
- Protocol models, operation schemas, and maintenance config schemas: `packages/protocol/src/`, `packages/app-api-schemas/src/`, `packages/config-schema/src/`.

## Implementation Gaps

- User Memory capture of selected completed conversation Items and recent private Thread ranges - User Source intake admits literal documents (`kind: document`) and User maintenance records an empty historical `sourceRange` rather than extracting recent private conversation Items - #259
- Administrator inspection of another User's Memory Sources - Public administrator Source inspection across Users is not joined - #792
- Explicit forget suppression-removal operation and User Memory / Server Knowledge export and import - Not implemented - #564, #385
- Usage aging and candidate-specific AI evidence assessment (`supported | contradicted | insufficient_evidence`) - Deferred and not implemented - #259, #264
- Cross-Workspace learning and consolidation into Server Knowledge - Server maintenance ingests explicit requests, Server Sources, and human edits only - #260
- Scheduled or event-triggered work reflection and Skill or prompt improvement - Explicit reflection is manual and create-only; scheduled triggers and Skill/prompt improvement are not implemented - #313
- Evaluation Harness activation - Deferred until all five real-use activation gates are met - #311
- End-to-end L6 and negative-advisory qualification for explicit completed-work reflection - Historical A1 stock OpenShell/Codex evidence exists, while fresh main L6 end-to-end and negative-advisory conversational qualification evidence remains unestablished - #792

## Decisions

- [Pre-Stable Data Continuity](../decisions/20261014-pre_stable_data_continuity.md)
- [Query Context, Sources, References And Acts](../decisions/20261015-context_sources_references_query_acts.md)
- [Memory System Facts And Asking Trace](../decisions/20261024-memory_system_facts_and_asking_trace.md)
