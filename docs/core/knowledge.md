---
status: Accepted
---
# Knowledge And Personal Memory Model

This document defines OpenKit knowledge semantics.

This document owns personally owned Memory, Workspace- and Server-owned Knowledge, their common notebook semantics, sources, derived representations, proposals, reviews, Knowledge Manager responsibilities, retrieval, evidence assessment, knowledge-derived material selection and preparation, and the boundary between reusable understanding and task-time context.

This document does not own runtime session continuity, workflow progression, concrete Context Package files or delivery traces, final worker prompt assembly, vault secret storage, raw domain-system records, protocol record schemas, storage layout, UI design, or opaque agent-runtime memory.

Memory is the user-facing name for User-owned reusable understanding, preferences, learning and personal context. Knowledge is the name for reusable understanding owned by a Workspace or CoreServer. They use one governed knowledge model; Memory is not a second storage engine or a hidden Agent state.

Server Knowledge is the Server's shared knowledge base, mainly for sharing information across Workspaces on that Server. Workspace work can query both its Workspace Knowledge and Server Knowledge when the Server Knowledge owner admits the actor; User Memory does not enter shared work.

Knowledge is not runtime session state, a prompt dump, hidden agent memory, raw source storage, or a replacement for an external system of record.

## Purpose

OpenKit keeps reusable understanding in an explicitly User-, Workspace- or Server-owned notebook and makes relevant, governed material available near agent work. User Memory emphasizes personality and continuity; shared Knowledge emphasizes work and organizational understanding. Ownership, applicable context and source restrictions are independent of those presentation names.

Sources remain evidence, knowledge remains curated interpretation, and Context Packages remain bounded task-time projections rather than copies of the notebook.

## Principles

- Memory is User-owned; Knowledge is Workspace- or Server-owned. None is agent-owned.
- Authorized humans retain final authority over reviewed knowledge.
- The Knowledge Manager may inspect, retrieve and edit an explicitly delegated notebook through one validated publisher. Ordinary authorized maintenance need not create a human Review; critical-content and sensitive-effect decisions retain their owning human authority.
- Sources provide evidence; knowledge stores curated interpretation.
- Context Packages are governed task-time projections, not raw workspace dumps.
- File-system-first knowledge remains inspectable, portable, editable, and easy to back up.
- Indexes, embeddings, graph edges, summaries, and read models are rebuildable accelerators rather than durable knowledge authority.
- OpenKit preserves context near worker execution without absorbing domain systems or their source-of-truth records.

## Canonical Terms

`Knowledge Store` is the common scope-bound system that manages reusable knowledge, notebook pages, source references, content revisions, optional proposal/review decisions, retrieval indexes, and knowledge selection for Context Packages.

`Knowledge Page` is a durable, reviewable, user-visible unit of reusable knowledge.

`Knowledge Source` is evidence or material cited by a knowledge page, proposal, claim, source summary, or Context Package.

`Derived Representation` is model-readable or searchable material derived from an identified source, such as extracted text, OCR, captions, transcripts, chunks, summaries, thumbnails, or metadata.

`Knowledge Proposal` is a pending request to create, update, merge, split, supersede, archive, or delete Knowledge Store content.

`Knowledge Review` is an explicit decision by an authorized human to accept, reject, or defer a Knowledge Proposal. For any candidate, changing its proposed content requires a new proposal rather than a combined edit-and-accept transition.

`Knowledge Manager` is the internal agent role that retrieves, explains, writes, integrates and organizes Memory and Knowledge through governed Core tools. It maintains each OpenKit Knowledge Format (OKF) notebook's root `index.md` as a bounded scope overview.

`Observation` is a low-friction agent-recorded signal about work, source material, or repeated behavior; it is not active knowledge by default.

`Notebook` is the user-facing product projection over knowledge pages, source references, proposals, and review history.

`Agent-Near Context` is context preserved close enough to worker execution for Core to retrieve, filter, cite, and project it without requiring the worker to rediscover unrelated systems.

`Context Package` is the task-time projection of selected knowledge and other authorized context sent to a worker agent.

## Boundaries And Non-Goals

Knowledge owns scope-bound reusable understanding and source-traceable selection. Personal Memory is the User projection of the same primitive; Skill is procedural behavior and supporting code owned by Agent Supply, not a privileged Knowledge Page. Facts and preferences do not become executable instructions merely because a model stores them.

Knowledge does not own workflow progression, worker execution, final semantic context composition, concrete Context Package persistence or delivery, raw external records, permission semantics, audit schemas, or secret material.

Artifacts may become Knowledge Sources, but artifacts are not required between ordinary source ingest and a Knowledge Proposal.

The Knowledge Manager only manages and queries its notebook scope. It has no network tools or effects outside that purpose. Its operations are trusted at this stage; review by another model and confidence marks are out of scope. Current authority and required human decisions still apply.

The Server Knowledge maintenance Thread is Server-owned and visible under current Server administration authority. Workspace membership does not admit its history.

The Knowledge Manager uses existing Thread, Turn and Item owners for conversation continuity. It owns no separate runtime, scheduler, retry queue or publication authority.

## Authority And Projection

Authorized users or team members own Knowledge Review decisions and direct user-authored knowledge.

Working internal agents and Workers receive the applicable notebook overview and ask the Knowledge Manager for relevant understanding. The Knowledge Manager retrieves with tools, answers with `page@revision` and `source@digest` citations, and states uncertainty. Users provide intent, information and approval; authorized simple direct edits remain available.

The Knowledge Manager prepares answers, context material, proposals and notebook edits under current scope and source authority. One maintenance Thread serves each notebook scope as the work record and approval place, not a resident agent. Explicit requests and scheduled maintenance start fresh bounded Turns with one writer. Users inspect and approve maintenance in that Thread. Cross-run memory is the notebook and its commit history. Independent query runs remain bound to each asker's query context and audience. The [agent and compaction decision](../decisions/20261017-bounded_knowledge_maintenance_and_shared_summaries.md) records this choice.

The Knowledge Store validates and persists knowledge, proposals, reviews, content identity and lineage, and retrieval projections through its existing owners.

The Workflow Coordinator decides how authorized material combines with task instructions, workflow state, constraints, capabilities, stop conditions, and review policy.

The owning Task boundary persists, materializes, and delivers the resulting Context Package for a standalone Task and for a Task a Goal admitted, through the separately owned delivery trace. The Goal's Coordinator uses assembled input and reads, and does not use that package.

A Knowledge selection or preparation result, workspace record, imported record, or diagnostic trace does not prove that a worker received or used knowledge. A bounded body, excerpt, or descriptor retains its delivered digest separately from the canonical page/source digest. Indexing or media extraction does not publish Knowledge. Missing or incomplete representations cannot prove body absence. The Context Package owner proves its delivered bytes; an existing capability call records the exact Knowledge Manager answer delivered through a Worker tool. [Large Files And Model Context](../decisions/20261015-large_files_and_model_context.md) records the decision.

## Lifecycle

Sources and interactions supply evidence; human and Agent edits work from one fixed notebook revision; the Knowledge Store validates the complete candidate and current authority before publishing a new revision. A human Review is an additional path when required, not the mandatory intermediary for every ordinary delegated edit. Default retrieval selects valid active pages, then the existing Context Package and worker-delivery owners project and prove exact delivered content.

One published notebook revision owns the current OKF content tree and retained history. An editing workspace is temporary, and indexes, summaries and materialized directories are rebuildable projections. Multiple file changes publish as one revision after an exact-base check; a stale writer cannot overwrite a newer edit. Creation, editing, merge, split, archive and restoration use this same boundary. Restoration appends a new revision; it never erases intervening history or reverses external effects.

Capture, successful no-op, draft, required Review, publication, conflict and incomplete command evidence are distinct outcomes. Restart reads published content and existing evidence; it never resumes a hidden editor or infers publication from a candidate.

## Sources And Generated Learning

Sources preserve evidence identity and lineage; knowledge preserves reusable interpretation.

The same source may support multiple Knowledge Pages, and a Knowledge Page may cite multiple sources.

OKF front matter has a closed core and open extensions. Required fields retain strict validation; users and agents may add descriptive extension fields. No page-level origin or trust field is required. Each notebook commit records its change source through existing producer, authority and source references; an optional origin note is an extension.

Raw sources remain source material until an authorized notebook publication creates curated interpretation. Human-authored, human-reviewed and delegated Agent-authored content remain visibly distinguishable.

An explicit bounded inspection of exact completed work history MAY produce a source-linked pending Knowledge Proposal.

That inspection is not a Knowledge Review. It may draft a candidate or, under separately admitted notebook maintenance authority, publish an ordinary validated edit.

Generated learning MUST have explicit current maintenance or exact human decision authority before publication. Required Reviews cannot be supplied by the generating model.

Citation count, elapsed time, repeated generation, absence of rejection, schedule execution, or later agent use MUST NOT confirm or promote generated learning.

Worker-output provenance requires the exact completed worker Turn and its owning delivery trace.

Workspace-only work, imported history, reconstructed history, standalone Knowledge operations, and records without accepted worker-delivery proof MUST NOT masquerade as worker output.

## Proposal Review, Application, And Reversal

Humans own maintenance delegation and required decisions. The Knowledge Store owns validation and publication. Ordinary authorized edits may publish without a synthetic Proposal/Review; a required decision freezes the exact base, candidate and source evidence in the existing Proposal/Review owners. Changed bytes or base require a new decision. A model cannot change its own scope, maintenance policy or critical-content rules through notebook text.

One fixed-base edit can change several files, repair links and update page states. Final validation prevents invalid active content, broken affected references, source disclosure and silent overwrites; temporary draft inconsistencies are allowed. Notebook history retains exact old/new content and responsible actor/producer history. There is no separate page-counter/full-byte archive or merge/split workflow. A content version is not proof of truth or authorization for future operations.

Success requires published content plus the existing command and audit evidence. Failure before publication leaves the earlier version intact; missing or contradictory post-publication command evidence is explicit recovery-required, not permission to replay or fabricate a receipt. Exact historical reads still require current scope/source permissions.

Archival excludes a retained page from ordinary retrieval. Explicit removal/forgetting retains its required human confirmation. Forgetting blocks active and normal historical retrieval, stale candidate application and automatic resurrection from the same sources; independently retained evidence and backup bytes remain subject to their disclosed retention. Ordinary forgetting does not promise physical erasure. User restoration and import cannot bypass suppression or revoked source authority.

Administrator masking records a tombstone through an ordinary notebook commit. Notebook reads and references honor current masks across retained history without rewriting Git history. Items and backups remain outside this mechanism.

## Automatic Learning And Evidence Assessment

Consolidation and learning from the scope's recent authorized Threads are part of v0.1.0 Knowledge Manager maintenance. Daily scheduling has one on/off setting per Server, User and Workspace scope, default off; enable it only for acceptance, testing and evaluation. Explicit run requests remain available. Each run starts with fresh context, retains its inputs and produces fixed-base candidate commits. Current maintenance delegation or required proposal approval governs publication; the diff is the review surface. Existing trigger and work owners retain scheduling and outcomes; no separate learning scheduler is introduced.

Knowledge Manager run records MUST NOT become later learning inputs. Human edits since the prior run MUST be included as inputs and MUST NOT be overwritten; stale-base publication fails. Failed or skipped scheduled runs MUST have a visible outcome. Usage aging and AI evidence assessment remain deferred until after v0.1.0.

Users may explicitly save, inspect, edit or forget personal Memory and eligible Knowledge. A current task instruction overrides a remembered preference for that task without silently rewriting it. Direct user expression is distinguishable from a model inference; inferred learning follows current notebook maintenance authority and any required review. Existing source, candidate, review, page and evidence owners preserve the difference between a proposal, an assessment and an applied change.

The deferred optional AI prove is source-grounded evidence assessment of an exact claim or candidate. It records support, contradiction or insufficient evidence and its limitations; it is neither mathematical proof nor an authorization grant. An authored scope policy may require this assessment for critical generated content, but a positive result never grants maintenance authority or substitutes for a required human Review. Changed content or evidence invalidates the old assessment. User editing remains available without falsely preserving a verified label.

Learning that yields a reusable procedure may submit a Skill candidate through Agent Supply. Skill version comparison and rollback retain that owner; factual Memory/Knowledge, procedural Skills, model-generated candidate claims and observed evaluation results remain distinguishable.

## Retrieval And Context

Retrieval selects candidate knowledge or source material; policy filtering decides what remains eligible; the owning Context Package projection records the selected bounded result.

Workers MUST NOT silently read all knowledge.

Knowledge selection MUST preserve source references, exact page content digest, freshness, sensitivity, conflict state, and exclusion reasons in the governed retrieval evidence; the owning package trace preserves only its retrieval linkage, delivered page identity and bytes, and any exclusion caused by package-stage budgeting.

The owning worker delivery trace proves the bytes and references delivered in its Context Package. For a Knowledge Manager tool answer, the existing capability call records the exact delivered answer bytes. Neither record proves that the Worker used the material.

Later citations, evaluation or learning claims MUST resolve to the applicable delivery evidence. A current Knowledge Page, mutable index, standalone selection trace or imported history cannot substitute for delivered bytes.

## Scope And Relationships

Every Memory or Knowledge record has one explicit owner scope. Personal Memory may serve its User across authorized private work contexts; it MUST NOT silently enter shared work. Workspace and Server Knowledge do not leak across scopes through sessions, manifests, caches, embeddings, indexes, traces or Context Packages. Current source restrictions survive capture, derivation, assessment and promotion, including when the destination is privately owned.

Items and work history may be Knowledge Sources, but they are not knowledge by themselves.

Artifacts may become Knowledge Sources, but they are not the ordinary ingest-to-knowledge middle step.

Vault owns secret values; Knowledge Pages MUST NOT store them.

External domain systems own their raw source-of-truth records; OpenKit may cite, summarize, and contextualize those records without replacing their authority.

## Invariants

- User Memory, Workspace Knowledge and Server Knowledge MUST remain isolated by current owner and source authority; personal material MUST NOT silently enter shared work or another scope.
- Forgetting MUST stop retrieval and stale candidate application before derived cleanup and MUST prevent automatic resurrection from the same source versions.
- AI assessment MUST remain evidence, never permission or human Review; content-bound assessment MUST be invalidated by a changed candidate or evidence.

- Reviewed knowledge MUST remain human-authoritative and MUST NOT become agent-owned.
- Direct human creates and edits MUST pass current validation and MUST NOT preserve a reviewed-proposal acceptance label across changed bytes.
- Generated learning MUST retain source lineage and explicit publication authority; a model MUST NOT self-authorize or self-confirm its factual claims.
- Ordinary delegated publication requires explicit current maintenance authority; only an authorized human can supply a required Knowledge Review.
- A required Review is not proof of publication. Published revision, exact content and existing operation evidence must agree; missing Audit or command receipt prevents a success or replay claim even when the content ref advanced.
- Restore and reversal create new exact-base revisions; they preserve old evidence and cannot silently overwrite later edits or undo external effects.
- Workspace-only, imported, reconstructed, or standalone Knowledge provenance MUST NOT masquerade as completed worker output.
- Worker receipt of selected Knowledge requires its owning Context Package delivery trace or the exact answer bytes in its existing Knowledge Manager capability call.
- Knowledge Pages MUST NOT store secret values.
- Raw external records MUST remain owned by their external system unless explicitly captured as OpenKit source material.

Server Knowledge maintenance records its work and approval on a Server-owned Thread. Current Server administration authority controls visibility; Workspace membership grants no access. A run uses explicit Server inputs and human notebook changes, with no automatic learning across Workspaces.
