---
status: Accepted
---
# Knowledge And Personal Memory Model

This document defines OpenKit knowledge semantics.

This document owns personally owned Memory, Workspace- and Server-owned Knowledge, their common notebook semantics, sources, derived representations, proposals, reviews, Knowledge Manager responsibilities, retrieval, evidence assessment, knowledge-derived material selection and preparation, and the boundary between reusable understanding and task-time context.

This document does not own runtime session continuity, workflow progression, concrete Context Package files or delivery traces, final worker prompt assembly, vault secret storage, raw domain-system records, protocol record schemas, storage layout, UI design, or opaque agent-runtime memory.

Memory is the user-facing name for User-owned reusable understanding, preferences, learning and personal context. Knowledge is the name for reusable understanding owned by a Workspace or CoreServer. They use one governed knowledge model; Memory is not a second storage engine or a hidden Agent state.

Knowledge is not runtime session state, a prompt dump, hidden agent memory, raw source storage, or a replacement for an external system of record.

## Purpose

OpenKit keeps reusable understanding in an explicitly User-, Workspace- or Server-owned notebook and makes relevant, governed material available near agent work. User Memory emphasizes personality and continuity; shared Knowledge emphasizes work and organizational understanding. Ownership, applicable context and source restrictions are independent of those presentation names.

Sources remain evidence, knowledge remains curated interpretation, and Context Packages remain bounded task-time projections rather than copies of the notebook.

## Principles

- Memory is User-owned; Knowledge is Workspace- or Server-owned. None is agent-owned.
- Authorized humans retain final authority over reviewed knowledge.
- The Knowledge Manager may inspect, organize, retrieve, and propose, but generated learning never promotes itself into active knowledge.
- Sources provide evidence; knowledge stores curated interpretation.
- Context Packages are governed task-time projections, not raw workspace dumps.
- File-system-first knowledge remains inspectable, portable, editable, and easy to back up.
- Indexes, embeddings, graph edges, summaries, and read models are rebuildable accelerators rather than durable knowledge authority.
- OpenKit preserves context near worker execution without absorbing domain systems or their source-of-truth records.

## Canonical Terms

`Knowledge Store` is the common scope-bound system that manages reusable knowledge, notebook pages, source references, proposal lifecycle, review decisions, retrieval indexes, and knowledge selection for Context Packages.

`Knowledge Page` is a durable, reviewable, user-visible unit of reusable knowledge.

`Knowledge Source` is evidence or material cited by a knowledge page, proposal, claim, source summary, or Context Package.

`Derived Representation` is model-readable or searchable material derived from an identified source, such as extracted text, OCR, captions, transcripts, chunks, summaries, thumbnails, or metadata.

`Knowledge Proposal` is a pending request to create, update, merge, split, supersede, archive, or delete Knowledge Store content.

`Knowledge Review` is an explicit decision by an authorized human to accept, reject, or defer a Knowledge Proposal. For either create or replace, changing the proposed page content requires a new proposal rather than a combined edit-and-accept transition.

`Knowledge Manager` is the Internal Core Role responsible for source-traceable knowledge query support, context-material preparation, proposal drafting, validation support, and bounded maintenance suggestions.

`Observation` is a low-friction agent-recorded signal about work, source material, or repeated behavior; it is not active knowledge by default.

`Notebook` is the user-facing product projection over knowledge pages, source references, proposals, and review history.

`Agent-Near Context` is context preserved close enough to worker execution for Core to retrieve, filter, cite, and project it without requiring the worker to rediscover unrelated systems.

`Context Package` is the task-time projection of selected knowledge and other authorized context sent to a worker agent.

## Boundaries And Non-Goals

Knowledge owns scope-bound reusable understanding and source-traceable selection. Personal Memory is the User projection of the same primitive; Skill is procedural behavior and supporting code owned by Agent Supply, not a privileged Knowledge Page. Facts and preferences do not become executable instructions merely because a model stores them.

Knowledge does not own workflow progression, worker execution, final semantic context composition, concrete Context Package persistence or delivery, raw external records, permission semantics, audit schemas, or secret material.

Artifacts may become Knowledge Sources, but artifacts are not required between ordinary source ingest and a Knowledge Proposal.

The Knowledge Manager is not a persistent agent runtime, workflow engine, scheduler, retry queue, or autonomous proposal-application owner.

## Authority And Projection

Authorized users or team members own Knowledge Review decisions and direct user-authored knowledge.

The Knowledge Manager prepares source-traceable answers, context material, proposals, and maintenance suggestions through explicit bounded operations.

The Knowledge Store validates and persists knowledge, proposals, reviews, content identity and lineage, and retrieval projections through its existing owners.

The Workflow Coordinator decides how authorized material combines with task instructions, workflow state, constraints, capabilities, stop conditions, and review policy.

The owning Task or Goal boundary persists, materializes, and delivers the resulting Context Package through the separately owned delivery trace.

A Knowledge selection or preparation result, workspace record, imported record, or diagnostic trace does not prove that a worker received or used knowledge.

## Lifecycle

The canonical lifecycle is:

```text
intake or source
  -> source identity and derived representations
  -> pending Knowledge Proposal
  -> human Knowledge Review
  -> active Knowledge Page
  -> retrieval and policy filtering
  -> Context Package selection
  -> owning worker delivery trace
  -> worker execution
  -> observations or pending Knowledge Proposals
```

Raw material does not become active knowledge merely because it was ingested, summarized, cited, scheduled, or generated by an agent.

## Sources And Generated Learning

Sources preserve evidence identity and lineage; knowledge preserves reusable interpretation.

The same source may support multiple Knowledge Pages, and a Knowledge Page may cite multiple sources.

Raw sources remain source material unless an authorized user authors knowledge directly or accepts a source-linked Knowledge Proposal.

An explicit bounded inspection of exact completed work history MAY produce a source-linked pending Knowledge Proposal.

That inspection drafts a proposal; it is not a Knowledge Review and does not activate knowledge.

Generated learning MUST remain pending until an authorized human accepts it through Knowledge Review.

Citation count, elapsed time, repeated generation, absence of rejection, schedule execution, or later agent use MUST NOT confirm or promote generated learning.

Worker-output provenance requires the exact completed worker Turn and its owning delivery trace.

Workspace-only work, imported history, reconstructed history, standalone Knowledge operations, and records without accepted worker-delivery proof MUST NOT masquerade as worker output.

## Proposal Review, Application, And Reversal

Knowledge changes that may affect future worker behavior MUST remain proposed until Knowledge Review accepts them, except for explicit direct user-authored edits.

An authorized human MAY create or edit knowledge directly through the existing Knowledge mutation owner, but the candidate MUST pass current validation and become `user-authored`; changed bytes MUST NOT retain the acceptance label of an earlier reviewed proposal.

An accepted Knowledge Review authorizes one bounded application through the Knowledge Store owner; the review decision alone does not prove that the change became active.

A generated create or single-page replacement fixes target scope, page identity, exact candidate content, source versions, producer and expected prior revision or absence before review. The business activation tuple is the exact proposal, accepting human review, resulting page revision and digest, sources, producer and reviewer. Application rejects a stale base and never overwrites a later direct edit. Request, Audit and command-receipt evidence prove command completion and replay but are not additional activation authority; multiple storage effects are not implicitly atomic.

A missing or contradictory application owner MUST fail closed and MUST NOT be reconstructed from the current page or process memory.

Bounded create reversal is an explicit authorized Knowledge-owner command that removes only the unchanged page created by that accepted create proposal. Replacement proposals are ineligible, and a page later replaced counts as edited and cannot be removed by its earlier create reversal.

The reversal result MUST retain the original proposal, original review, created-page digest, reversal request, actor, and audit lineage.

Reversal MUST NOT create a second proposal or rollback workflow, erase source evidence, remove a subsequently edited page, or imply reversal of external effects already caused by prior worker use.

Consolidation may propose a complete replacement of one page using current authorized sources. Multi-page merge, split, rename, generated deletion and generalized historical restoration are excluded from this bounded lifecycle. Forgetting is an explicit authorized user operation: stop active retrieval and stale candidate application, remove content through its retention owner, and prevent automatic resurrection from the same source versions. Retained minimal evidence and independently published copies do not become active memory.

## Automatic Learning And Evidence Assessment

Automatic extraction selects bounded eligible completed interactions and creates source-linked observations or pending proposals. Consolidation compares those observations with current saved understanding; unchanged inputs or no useful finding may complete without a proposal. It is a bounded operation of the existing Knowledge Manager and runtime, not a separate persistent Agent, scheduler or self-improvement authority. Consolidation and assessment output MUST NOT recursively establish its own factual evidence.

Users may explicitly save, inspect, edit or forget personal Memory and eligible Knowledge. A current task instruction overrides a remembered preference for that task without silently rewriting it. Direct user expression is distinguishable from a model inference; inferred learning remains pending until authorized review. Existing source, candidate, review, page and evidence owners preserve the difference between a proposal, an assessment and an applied change.

Optional AI prove is source-grounded evidence assessment of an exact claim or candidate. It records support, contradiction or insufficient evidence and its limitations; it is neither mathematical proof nor an authorization grant. An authored scope policy may require this assessment for critical generated content, but a positive result never substitutes for human Review. Changed content or evidence invalidates the old assessment. User editing remains available without falsely preserving a verified label.

Learning that yields a reusable procedure may submit a Skill candidate through Agent Supply. Skill version comparison and rollback retain that owner; factual Memory/Knowledge, procedural Skills, model-generated candidate claims and observed evaluation results remain distinguishable.

## Retrieval And Context

Retrieval selects candidate knowledge or source material; policy filtering decides what remains eligible; the owning Context Package projection records the selected bounded result.

Workers MUST NOT silently read all knowledge.

Knowledge selection MUST preserve source references, exact page content digest, freshness, sensitivity, conflict state, and exclusion reasons in the governed retrieval evidence; the owning package trace preserves only its retrieval linkage, delivered page identity and bytes, and any exclusion caused by package-stage budgeting.

Only the owning worker delivery trace proves which exact knowledge-derived bytes or references reached a worker Turn.

Later citations, evaluation, or learning claims MUST resolve to that delivery trace rather than a current Knowledge Page, mutable index, standalone selection trace, or imported history.

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
- Generated learning MUST enter as a source-linked pending Knowledge Proposal and MUST NOT self-promote or self-confirm.
- Only an authorized human Knowledge Review may accept generated learning for active retrieval.
- An accepted review MUST NOT count as applied knowledge until the exact resulting page revision, content digest, owner scope, source lineage, producer, and accepting human review are durable. Missing Audit or command receipt prevents a success or replay claim and returns `recovery_required`, but does not deactivate an otherwise complete business tuple.
- Bounded create reversal MUST remove only the unchanged original proposal-created page; any later replacement makes it ineligible. Both original and reversal evidence MUST remain.
- Workspace-only, imported, reconstructed, or standalone Knowledge provenance MUST NOT masquerade as completed worker output.
- Only the owning worker delivery trace may prove that a worker received selected knowledge.
- Knowledge Pages MUST NOT store secret values.
- Raw external records MUST remain owned by their external system unless explicitly captured as OpenKit source material.
